//! Windows implementation of the Activity monitor's process sampler. Same
//! session/delta/history bookkeeping as `procmon.rs` and `procmon_linux.rs`
//! (its own copy, for the reason procmon_linux.rs gives); the pure logic
//! lives in procmon_common.rs.
//!
//! Where it differs from the other two, and why:
//!
//! - **One ToolHelp snapshot is the whole pid table**: parent pid, image
//!   name and thread count for every process in a single call, no handle
//!   opened. The per-process calls (`OpenProcess` + times + memory) run only
//!   for pids inside one of our subtrees, which keeps the cost proportional
//!   to OUR processes (docs/performance.md).
//! - **A parent pid is a claim, not a fact.** Windows never rewrites a
//!   process's parent pid when the parent dies, and it reuses pids, so an
//!   unrelated orphan can name one of our pids as its parent. `adopted`
//!   keeps a link only when the child was created after its parent, the
//!   same rule `proc_ctl`'s tree kill uses. Without it a stranger would be
//!   charged to an agent, and `signal` would be allowed to kill it.
//! - **Memory is the private working set** (`PrivateWorkingSetSize`), the
//!   figure Task Manager's "Memory" column shows: pages in RAM that belong
//!   to this process alone, so summing a tree does not double-count shared
//!   images. It needs `PROCESS_MEMORY_COUNTERS_EX2`; a Windows too old for
//!   it falls back to the plain working set, which reads high the way
//!   Linux's RSS does.
//! - **WebView2 needs no attribution pass, usually.** Its browser, GPU and
//!   renderer processes are ordinary descendants of the app process, so the
//!   Termic row's own subtree already holds them. The exception is a second
//!   instance on the same WebView2 user-data folder (a dev or e2e build
//!   beside the installed app): WebView2 keeps ONE browser process per
//!   folder, owned by whichever instance started first, and the later
//!   instance's renderers hang under that one. Measured: an e2e build
//!   started beside the installed app had no `msedgewebview2` under it at
//!   all. So the Termic row says `webkit_unavailable` when none is found
//!   under it, rather than quietly reporting a smaller number.
//! - **There are no signals.** TERM and KILL both end the process tree
//!   (`proc_ctl`; a console program has no graceful stop), and STOP / CONT
//!   suspend and resume every process in the row's subtree, because the pid
//!   on the row is usually a `cmd.exe` shim and freezing only that leaves
//!   the real workload running.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use parking_lot::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SUSPEND_RESUME,
};

use crate::procmon_common::{build_child_map, collect_subtree, cpu_ratio, label_for, EMPTY_SET};
// Re-exported: lib.rs reaches these as `procmon::Root` / `procmon::Snapshot`
// regardless of which platform module `procmon` resolves to.
pub use crate::procmon_common::{ChildRow, ProcRow, Root, Snapshot};

// Not in windows-sys's Win32 surface. Exported by ntdll since XP and what
// every process manager uses: there is no documented whole-process suspend,
// only a per-thread one that races thread creation.
#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(process: HANDLE) -> i32;
    fn NtResumeProcess(process: HANDLE) -> i32;
}

/// WebView2's image name, as `image_name` reports it.
const WEBVIEW2: &str = "msedgewebview2";

/// FILETIME ticks (100ns) between 1601-01-01 and the unix epoch.
const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

fn filetime(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

/// Right now, in the same units and epoch as a process's creation time.
fn now_filetime() -> u64 {
    let since_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_nanos() / 100) as u64)
        .unwrap_or(0);
    UNIX_EPOCH_FILETIME.saturating_add(since_unix)
}

struct Entry {
    ppid: u32,
    threads: u32,
    name: String,
}

/// The image name the way the other platforms report a comm: `node`, not
/// `node.exe`. Every row would carry the suffix otherwise.
fn image_name(raw: &[u16]) -> String {
    let len = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    let name = String::from_utf16_lossy(&raw[..len]);
    match name.len().checked_sub(4) {
        Some(cut) if name.is_char_boundary(cut) && name[cut..].eq_ignore_ascii_case(".exe") => {
            name[..cut].to_string()
        }
        _ => name,
    }
}

/// Every process in the table, by pid.
fn process_table() -> HashMap<u32, Entry> {
    let mut out = HashMap::new();
    // SAFETY: standard ToolHelp snapshot walk over a zeroed entry whose
    // dwSize is set as the API requires; the snapshot is closed before return.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                out.insert(
                    e.th32ProcessID,
                    Entry {
                        ppid: e.th32ParentProcessID,
                        threads: e.cntThreads,
                        name: image_name(&e.szExeFile),
                    },
                );
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

#[derive(Clone, Copy)]
struct PidStats {
    /// Creation time, FILETIME ticks. Same epoch as `now_filetime()`.
    created: u64,
    /// kernel+user time, in 100ns units.
    cpu: u64,
    /// Private working set (see the module doc), or `rss` when unavailable.
    mem: u64,
    rss: u64,
}

/// None for a process that is gone, has exited, or is not ours to query.
///
/// "Has exited" is checked on purpose: the app keeps a handle to every PTY
/// child, and Windows keeps a process object (and its pid) alive for as long
/// as anyone holds one, so an agent that quit minutes ago still opens.
fn pid_stats(pid: u32) -> Option<PidStats> {
    // SAFETY: query-only handle, closed before return; every out-param is a
    // plain struct of the size the call is told about.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let stats = read_stats(h);
        CloseHandle(h);
        stats
    }
}

unsafe fn read_stats(h: HANDLE) -> Option<PidStats> {
    let mut code = 0u32;
    if GetExitCodeProcess(h, &mut code) == 0 || code != STILL_ACTIVE as u32 {
        return None;
    }
    let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (z, z, z, z);
    if GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
        return None;
    }
    // A failure here is not fatal: the row still has CPU and uptime.
    let (mut mem, mut rss) = (0u64, 0u64);
    let mut ex2: PROCESS_MEMORY_COUNTERS_EX2 = std::mem::zeroed();
    let ex2_size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
    if K32GetProcessMemoryInfo(h, &mut ex2 as *mut _ as *mut PROCESS_MEMORY_COUNTERS, ex2_size) != 0 {
        rss = ex2.WorkingSetSize as u64;
        mem = ex2.PrivateWorkingSetSize as u64;
    } else {
        let mut basic: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if K32GetProcessMemoryInfo(h, &mut basic, size) != 0 {
            rss = basic.WorkingSetSize as u64;
            mem = rss;
        }
    }
    Some(PidStats {
        created: filetime(created),
        cpu: filetime(kernel).saturating_add(filetime(user)),
        mem,
        rss,
    })
}

/// The parent links under `roots` that are real, as a child map.
///
/// `raw` is every claimed link in the table (see the module doc for why a
/// claim is not enough). A link survives only when both ends can be dated
/// and the child is not older than its parent. `born` is injected so the
/// rule is testable without real processes.
fn adopted(
    roots: &[u32],
    raw: &HashMap<u32, Vec<u32>>,
    born: &mut dyn FnMut(u32) -> Option<u64>,
) -> HashMap<u32, Vec<u32>> {
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack: Vec<u32> = roots.to_vec();
    while let Some(parent) = stack.pop() {
        if !seen.insert(parent) {
            continue;
        }
        let Some(parent_born) = born(parent) else { continue };
        let Some(claimed) = raw.get(&parent) else { continue };
        let kids: Vec<u32> = claimed
            .iter()
            .copied()
            .filter(|&kid| kid != 0 && born(kid).is_some_and(|b| b >= parent_born))
            .collect();
        stack.extend(kids.iter().copied());
        if !kids.is_empty() {
            out.insert(parent, kids);
        }
    }
    out
}

// ───────────────────────────── session ─────────────────────────────
// Identical shape to procmon.rs's — see that module for the reasoning
// behind each field (delta bookkeeping, output rate, capped history).

const HISTORY_LEN: usize = 90;
const MAX_CHILDREN: usize = 8;

struct Session {
    id: u64,
    /// pid -> cumulative cpu time (100ns) at the previous sample.
    prev_cpu: HashMap<u32, u64>,
    /// When the previous sample was taken. None before the first one.
    prev_wall: Option<Instant>,
    prev_out: HashMap<String, (u64, f64)>,
    hist: HashMap<String, Vec<f64>>,
}

static STATE: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

pub fn start(roots: Vec<Root>) -> Snapshot {
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    *STATE.lock() = Some(Session {
        id,
        prev_cpu: HashMap::new(),
        prev_wall: None,
        prev_out: HashMap::new(),
        hist: HashMap::new(),
    });
    sample(id, roots).unwrap_or_else(|_| Snapshot {
        session: id,
        unix_ms: unix_ms_now(),
        rows: Vec::new(),
        sample_ms: 0.0,
        webkit_unavailable: false,
    })
}

pub fn stop(session: u64) {
    let mut g = STATE.lock();
    if g.as_ref().is_some_and(|s| s.id == session) {
        *g = None;
    }
}

pub fn stop_all() {
    *STATE.lock() = None;
}

#[cfg(test)]
pub fn is_running() -> bool {
    STATE.lock().is_some()
}

fn unix_ms_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

pub fn sample(session: u64, roots: Vec<Root>) -> Result<Snapshot, String> {
    let began = Instant::now();
    {
        let g = STATE.lock();
        match g.as_ref() {
            None => return Err("procmon: no active session".into()),
            Some(s) if s.id != session => return Err("procmon: stale session".into()),
            Some(_) => {}
        }
    }

    // ── pass 1: the whole pid table, one snapshot ──
    let table = process_table();
    let ppid: HashMap<u32, u32> = table.iter().map(|(&pid, e)| (pid, e.ppid)).collect();
    let comm: HashMap<u32, String> = table.iter().map(|(&pid, e)| (pid, e.name.clone())).collect();

    // ── pass 2: date and measure only what hangs off one of our roots ──
    let root_pids: Vec<u32> = roots.iter().map(|r| r.pid).collect();
    let mut stats: HashMap<u32, Option<PidStats>> = HashMap::new();
    let children = adopted(&root_pids, &build_child_map(&ppid), &mut |pid| {
        (*stats.entry(pid).or_insert_with(|| pid_stats(pid))).map(|s| s.created)
    });

    // ── subtrees ──
    let us = std::process::id();
    // See the module doc: a webview app with no WebView2 process under it
    // is sharing another instance's.
    let webkit_unavailable = roots.iter().any(|r| r.pid == us)
        && !collect_subtree(us, &children, &EMPTY_SET)
            .iter()
            .any(|pid| comm.get(pid).is_some_and(|n| n.eq_ignore_ascii_case(WEBVIEW2)));
    let pty_root_pids: HashSet<u32> =
        roots.iter().filter(|r| r.pty_id.is_some()).map(|r| r.pid).collect();
    let now_wall = Instant::now();
    let now_file = now_filetime();
    let now_unix = unix_ms_now();

    let mut g = STATE.lock();
    let Some(sess) = g.as_mut() else {
        return Err("procmon: session ended".into());
    };
    if sess.id != session {
        return Err("procmon: stale session".into());
    }
    // 100ns units, the same as a process's cpu time, so `cpu_ratio` divides
    // like by like.
    let delta_wall = sess
        .prev_wall
        .map(|prev| (now_wall.duration_since(prev).as_nanos() / 100) as u64)
        .unwrap_or(0);
    let have_baseline = delta_wall > 0;

    let mut next_cpu: HashMap<u32, u64> = HashMap::new();
    let mut rows: Vec<ProcRow> = Vec::with_capacity(roots.len());
    let mut seen_keys: HashSet<String> = HashSet::with_capacity(roots.len());

    for root in &roots {
        let stop: &HashSet<u32> = if root.pid == us { &pty_root_pids } else { &EMPTY_SET };
        let members = collect_subtree(root.pid, &children, stop);

        let mut cpu_total = 0u64;
        let mut cpu_delta = 0u64;
        let mut mem = 0u64;
        let mut rss = 0u64;
        let mut threads = 0u32;
        let mut alive = false;
        let mut created = 0u64;
        let mut kids: Vec<ChildRow> = Vec::new();

        for &pid in &members {
            let Some(st) = stats.get(&pid).copied().flatten() else { continue };
            alive = true;
            if pid == root.pid {
                created = st.created;
            }
            cpu_total = cpu_total.saturating_add(st.cpu);
            mem = mem.saturating_add(st.mem);
            rss = rss.saturating_add(st.rss);
            threads = threads.saturating_add(table.get(&pid).map(|e| e.threads).unwrap_or(0));
            let prev = sess.prev_cpu.get(&pid).copied().unwrap_or(0);
            let d = st.cpu.saturating_sub(prev.min(st.cpu));
            cpu_delta = cpu_delta.saturating_add(d);
            next_cpu.insert(pid, st.cpu);
            let child_pct = if have_baseline {
                Some(cpu_ratio(d, delta_wall))
            } else {
                None
            };
            kids.push(ChildRow {
                pid,
                label: comm.get(&pid).cloned().unwrap_or_else(|| "?".into()),
                cpu_pct: child_pct,
                mem_bytes: st.mem,
            });
        }

        kids.sort_by(|a, b| {
            b.cpu_pct
                .unwrap_or(0.0)
                .partial_cmp(&a.cpu_pct.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.mem_bytes.cmp(&a.mem_bytes))
                .then(a.pid.cmp(&b.pid))
        });
        let proc_count = kids.len() as u32;
        kids.truncate(MAX_CHILDREN);

        let cpu_pct = if have_baseline {
            Some(cpu_ratio(cpu_delta, delta_wall))
        } else {
            None
        };

        let out_bps = match (root.out_bytes, sess.prev_out.get(&root.key)) {
            (Some(now_bytes), Some(&(prev_bytes, prev_ms))) if now_unix > prev_ms => {
                let secs = (now_unix - prev_ms) / 1000.0;
                Some(now_bytes.saturating_sub(prev_bytes) as f64 / secs)
            }
            _ => None,
        };
        if let Some(b) = root.out_bytes {
            sess.prev_out.insert(root.key.clone(), (b, now_unix));
        }

        let h = sess.hist.entry(root.key.clone()).or_default();
        h.push(cpu_pct.unwrap_or(0.0));
        if h.len() > HISTORY_LEN {
            let drop = h.len() - HISTORY_LEN;
            h.drain(0..drop);
        }

        seen_keys.insert(root.key.clone());
        rows.push(ProcRow {
            key: root.key.clone(),
            kind: root.kind.clone(),
            pty_id: root.pty_id.clone(),
            task_id: root.task_id.clone(),
            tab_id: root.tab_id.clone(),
            pid: root.pid,
            label: label_for(root.pid, &children, &comm),
            cpu_pct,
            mem_bytes: mem,
            rss_bytes: rss,
            proc_count,
            threads,
            cpu_ms: cpu_total / 10_000,
            uptime_ms: if created > 0 {
                now_file.saturating_sub(created) / 10_000
            } else {
                0
            },
            out_bps,
            alive,
            cpu_history: h.clone(),
            children: kids,
            is_docker: false,
        });
    }

    sess.hist.retain(|k, _| seen_keys.contains(k));
    sess.prev_out.retain(|k, _| seen_keys.contains(k));
    sess.prev_cpu = next_cpu;
    sess.prev_wall = Some(now_wall);
    drop(g);

    Ok(Snapshot {
        session,
        unix_ms: now_unix,
        rows,
        sample_ms: began.elapsed().as_secs_f64() * 1000.0,
        webkit_unavailable,
    })
}

// ───────────────────────────── signals ─────────────────────────────

/// What a signal name means here (see the module doc).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Kill,
    Suspend,
    Resume,
}

fn action_from_name(name: &str) -> Option<Action> {
    match name {
        "TERM" | "KILL" => Some(Action::Kill),
        "STOP" => Some(Action::Suspend),
        "CONT" => Some(Action::Resume),
        _ => None,
    }
}

/// pid -> creation time of every process WE suspended and have not resumed.
///
/// A suspend is a COUNT on Windows, not a state: suspending twice needs two
/// resumes, where a second SIGSTOP is a no-op. Remembering what is already
/// suspended makes the pause button idempotent, so one Resume always undoes
/// it. The creation time is what tells a suspended process from a later one
/// that was handed the same pid.
static SUSPENDED: Mutex<Option<HashMap<u32, u64>>> = Mutex::new(None);

fn nt_call(pid: u32, f: unsafe extern "system" fn(HANDLE) -> i32) -> Result<(), String> {
    // SAFETY: a handle with exactly the access the call needs, closed before
    // return. An NTSTATUS is negative on failure.
    unsafe {
        let h = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if h.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let status = f(h);
        CloseHandle(h);
        if status < 0 {
            return Err(format!("NTSTATUS {:#010x}", status as u32));
        }
    }
    Ok(())
}

/// Act on `pid`, but ONLY if it sits inside the subtree of a PTY we spawned
/// — same refusal logic and reasoning as procmon.rs's `signal`.
pub fn signal(roots: &[Root], pid: u32, sig_name: &str) -> Result<(), String> {
    let Some(action) = action_from_name(sig_name) else {
        return Err(format!("unsupported signal {sig_name}"));
    };
    if pid == 0 || pid == std::process::id() {
        return Err("refusing to signal Termic itself".into());
    }
    let table = process_table();
    let ppid: HashMap<u32, u32> = table.iter().map(|(&p, e)| (p, e.ppid)).collect();
    let pty_roots: Vec<u32> = roots.iter().filter(|r| r.pty_id.is_some()).map(|r| r.pid).collect();
    let mut born: HashMap<u32, Option<u64>> = HashMap::new();
    let children = adopted(&pty_roots, &build_child_map(&ppid), &mut |p| {
        *born.entry(p).or_insert_with(|| pid_stats(p).map(|s| s.created))
    });
    let owned = pty_roots
        .iter()
        .any(|&r| collect_subtree(r, &children, &EMPTY_SET).contains(&pid));
    if !owned {
        return Err("pid is not part of a Termic terminal".into());
    }
    if action == Action::Kill {
        // A suspended process dies like any other, so nothing to resume first.
        crate::proc_ctl::signal_pid(pid as i32, crate::proc_ctl::Sig::Kill);
        return Ok(());
    }

    // The pid itself first: frozen, it cannot start anything new while the
    // rest of its subtree is being walked.
    let mut members = collect_subtree(pid, &children, &EMPTY_SET);
    members.retain(|&m| m != pid);
    members.insert(0, pid);

    let mut g = SUSPENDED.lock();
    let suspended = g.get_or_insert_with(HashMap::new);
    // Forget whatever has exited since (or was killed while suspended).
    suspended.retain(|p, created| born.get(p).copied().flatten() == Some(*created)
        || pid_stats(*p).is_some_and(|s| s.created == *created));

    let mut result = Ok(());
    for m in members {
        let Some(created) = born.get(&m).copied().flatten() else { continue };
        let already = suspended.get(&m) == Some(&created);
        let done = match action {
            Action::Suspend if !already => nt_call(m, NtSuspendProcess).map(|()| {
                suspended.insert(m, created);
            }),
            Action::Resume if already => nt_call(m, NtResumeProcess).map(|()| {
                suspended.remove(&m);
            }),
            _ => Ok(()),
        };
        // The row's own process is the one the button was pressed on; a
        // child that exited mid-walk is not a failure worth reporting.
        if m == pid {
            result = done;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session is process-global (there is one Activity window), so the
    /// tests that drive it must not run concurrently with each other.
    static SESSION_TEST: Mutex<()> = Mutex::new(());

    fn root(key: &str, pid: u32, pty: bool) -> Root {
        Root {
            key: key.into(),
            kind: if pty { "shell".into() } else { "app".into() },
            pty_id: pty.then(|| key.to_string()),
            task_id: None,
            tab_id: None,
            pid,
            out_bytes: None,
            docker_container: None,
        }
    }

    fn raw(pairs: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
        build_child_map(&pairs.iter().copied().collect())
    }

    #[test]
    fn image_name_drops_the_exe_suffix_only() {
        let wide = |s: &str| s.encode_utf16().chain([0, b'x' as u16]).collect::<Vec<u16>>();
        assert_eq!(image_name(&wide("node.exe")), "node");
        assert_eq!(image_name(&wide("PING.EXE")), "PING");
        assert_eq!(image_name(&wide("System")), "System");
        assert_eq!(image_name(&wide(".exe")), "");
        assert_eq!(image_name(&wide("exe")), "exe");
    }

    #[test]
    fn adopted_keeps_children_and_drops_reused_parent_pids() {
        // 10 -> 11 -> 13, 10 -> 12. 14 claims 10 as its parent but was
        // created BEFORE it: a stranger whose real parent died and whose pid
        // 10 was handed out again. 15 cannot be dated at all.
        let t = raw(&[(11, 10), (12, 10), (13, 11), (14, 10), (15, 10), (20, 1)]);
        let mut born = |p: u32| match p {
            14 => Some(1),
            10 => Some(5),
            15 => None,
            _ => Some(9),
        };
        let kids = adopted(&[10], &t, &mut born);
        assert_eq!(collect_subtree(10, &kids, &EMPTY_SET), vec![10, 11, 12, 13]);
    }

    #[test]
    fn adopted_gives_a_dead_root_no_children() {
        // The root exited and its pid was reused by nothing we can date: the
        // processes still naming it as parent are not a tree we can vouch for.
        let t = raw(&[(11, 10), (12, 11)]);
        let mut born = |p: u32| if p == 10 { None } else { Some(9) };
        let kids = adopted(&[10], &t, &mut born);
        assert_eq!(collect_subtree(10, &kids, &EMPTY_SET), vec![10]);
    }

    #[test]
    fn only_known_signals_are_allowed() {
        assert!(action_from_name("TERM") == Some(Action::Kill));
        assert!(action_from_name("STOP") == Some(Action::Suspend));
        assert!(action_from_name("CONT") == Some(Action::Resume));
        // No console to deliver a Ctrl+C to from here.
        assert!(action_from_name("INT").is_none());
        assert!(action_from_name("SIGKILL").is_none());
        assert!(action_from_name("").is_none());
    }

    #[test]
    fn signal_refuses_our_own_pid() {
        let err = signal(&[], std::process::id(), "TERM").unwrap_err();
        assert!(err.contains("Termic itself"), "{err}");
    }

    #[test]
    fn signal_refuses_a_pid_we_do_not_own() {
        // pid 4 is the System process: emphatically not one of our terminals.
        let err = signal(&[], 4, "TERM").unwrap_err();
        assert!(err.contains("not part of"), "{err}");
    }

    #[test]
    fn reads_the_real_process_table() {
        let table = process_table();
        assert!(table.len() > 5, "expected a populated pid table, got {}", table.len());
        let us = table.get(&std::process::id()).expect("our own entry");
        assert!(us.ppid > 0);
        assert!(us.threads >= 1);
        assert!(!us.name.is_empty() && !us.name.ends_with(".exe"), "{}", us.name);
    }

    #[test]
    fn reads_our_own_stats() {
        let st = pid_stats(std::process::id()).expect("own stats");
        assert!(st.rss > 0, "working set should be non-zero");
        assert!(st.mem > 0, "private working set should be non-zero");
        // Private pages are a subset of the working set.
        assert!(st.mem <= st.rss, "private {} > working set {}", st.mem, st.rss);
        let age = now_filetime().saturating_sub(st.created);
        assert!(st.created > 0 && age < 3600 * 10_000_000, "created {} ticks ago", age);
    }

    /// End-to-end check that the CPU math produces a REAL percentage: peg
    /// one core and the row must report something near 100, not fractions
    /// of it (a unit mismatch) and not thousands (the inverse).
    #[test]
    fn cpu_percent_tracks_a_busy_core() {
        let app = || vec![root("app", std::process::id(), false)];
        let _guard = SESSION_TEST.lock();
        let base = start(app());
        let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f = stop_flag.clone();
        let spinner = std::thread::spawn(move || {
            let mut x = 0u64;
            while !f.load(Ordering::Relaxed) {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
            }
            x
        });
        std::thread::sleep(std::time::Duration::from_millis(400));
        let hot = sample(base.session, app()).expect("sample while busy");
        stop_flag.store(true, Ordering::Relaxed);
        let _ = spinner.join();
        stop(base.session);

        let pct = hot.rows[0].cpu_pct.expect("cpu after a baseline");
        assert!(
            (25.0..400.0).contains(&pct),
            "one pegged core should read near 100%, got {pct}"
        );
        assert!(hot.rows[0].cpu_ms > 0, "cumulative cpu time should be non-zero");
        assert!(hot.sample_ms < 500.0, "sampling took {}ms", hot.sample_ms);
    }

    #[test]
    fn session_lifecycle_holds_no_state_when_stopped() {
        let app = || vec![root("app", std::process::id(), false)];
        let _guard = SESSION_TEST.lock();
        let snap = start(app());
        assert!(is_running());
        assert_eq!(snap.rows.len(), 1);
        assert!(snap.rows[0].cpu_pct.is_none());
        assert!(snap.rows[0].mem_bytes > 0);
        assert!(snap.rows[0].threads >= 1);
        assert!(snap.rows[0].alive);
        // The test process stands in for the app and hosts no webview, which
        // is the shape of an instance sharing someone else's WebView2.
        assert!(snap.webkit_unavailable);

        let second = sample(snap.session, app()).expect("second sample");
        assert!(second.rows[0].cpu_pct.is_some(), "second sample must have a delta");
        assert_eq!(second.rows[0].cpu_history.len(), 2);

        assert!(sample(snap.session + 999, Vec::new()).is_err());

        stop(snap.session);
        assert!(!is_running());
        assert!(sample(snap.session, Vec::new()).is_err());
    }

    /// CPU the row burned over `ms`, as a percentage of one core.
    fn cpu_over(session: u64, roots: &[Root], ms: u64) -> f64 {
        sample(session, roots.to_vec()).expect("baseline");
        std::thread::sleep(std::time::Duration::from_millis(ms));
        let snap = sample(session, roots.to_vec()).expect("reading");
        snap.rows[0].cpu_pct.expect("cpu after a baseline")
    }

    /// The whole reason this file is not the unix one: a real child tree,
    /// suspended, resumed and killed through `signal`.
    #[test]
    fn suspends_resumes_and_kills_a_real_child_tree() {
        use std::os::windows::process::CommandExt;
        let _guard = SESSION_TEST.lock();
        // cmd.exe spinning in a `for` that never ends, started through a
        // second cmd.exe: the outer one is the shim a PTY row's pid usually
        // is, and it idles while its child does the work.
        let mut child = crate::proc_ctl::command("cmd")
            .raw_arg("/d /c cmd /d /c for /l %i in (1,0,2) do @rem")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd");
        // Ends the tree even when an assertion below fails first: a leaked
        // one keeps spinning (or stays frozen) and holds the test runner's
        // output pipe open, so the run never returns. Declared after `child`
        // so it runs while that handle still pins the pid.
        struct KillOnDrop(u32);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                crate::proc_ctl::signal_pid(self.0 as i32, crate::proc_ctl::Sig::Kill);
            }
        }
        let _reaper = KillOnDrop(child.id());
        let roots = vec![root("pty:test", child.id(), true)];
        let base = start(roots.clone());

        let busy = |snap: &Snapshot| snap.rows[0].proc_count >= 2;
        let mut snap = base.clone();
        for _ in 0..50 {
            if busy(&snap) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            snap = sample(base.session, roots.clone()).expect("sample");
        }
        assert!(busy(&snap), "the inner cmd never showed up under the outer one");
        assert!(snap.rows[0].alive);
        assert_eq!(snap.rows[0].label, "cmd");
        let inner = snap.rows[0].children.iter().find(|c| c.pid != child.id()).expect("inner").pid;

        let running = cpu_over(base.session, &roots, 400);
        assert!(running > 25.0, "the loop should peg a core, got {running}%");

        // Twice on purpose: a suspend is a count, and one resume has to undo
        // both presses.
        signal(&roots, child.id(), "STOP").expect("suspend");
        signal(&roots, child.id(), "STOP").expect("suspend again");
        let frozen = cpu_over(base.session, &roots, 400);
        assert!(frozen < 5.0, "a suspended tree should burn nothing, got {frozen}%");

        signal(&roots, child.id(), "CONT").expect("resume");
        let resumed = cpu_over(base.session, &roots, 400);
        assert!(resumed > 25.0, "one resume should undo two suspends, got {resumed}%");

        // The inner process is ours to signal too; a stranger's is not.
        assert!(signal(&roots, inner, "USR1").unwrap_err().contains("unsupported signal"));
        assert!(signal(&roots, 4, "TERM").unwrap_err().contains("not part of"));

        signal(&roots, child.id(), "TERM").expect("kill");
        let _ = child.wait();
        // `child` still holds the process handle, which is exactly the case
        // `pid_stats` checks the exit code for.
        let after = sample(base.session, roots.clone()).expect("sample after kill");
        stop(base.session);
        assert!(!after.rows[0].alive, "the row must read as exited");
        assert_eq!(after.rows[0].proc_count, 0);
        assert!(pid_stats(inner).is_none(), "the kill must reach the whole tree");
    }
}

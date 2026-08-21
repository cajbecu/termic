//! Linux implementation of the Activity monitor's process sampler. Reads
//! `/proc` directly — plain text files, no `unsafe` FFI needed at all,
//! unlike `procmon.rs`'s macOS libproc/mach calls. Mirrors that module's
//! session/delta/history bookkeeping (kept as its own copy rather than a
//! shared abstraction — the two only really overlap in *shape*, not in the
//! actual stat-gathering, and forcing that into one trait was more
//! machinery than the duplication it would save). The pure logic that IS
//! identical (subtree walk, cpu_ratio, label_for, signal_from_name) lives
//! in procmon_common.rs and both platforms use it from there.
//!
//! Two known gaps versus the macOS version:
//! - **No `phys_footprint` equivalent.** Linux has no kernel-provided
//!   "unique, not double-counted" memory figure the way `ri_phys_footprint`
//!   is on macOS, so `mem_bytes` here is just `VmRSS` (same as `rss_bytes`)
//!   — a process tree sharing pages (a node agent and its children sharing
//!   the runtime + every loaded module) reads a little high, the same
//!   caveat any `ps`/`top` on Linux carries.
//! - **No WebKit-sidecar attribution.** macOS's GPU/Networking/WebContent
//!   rows come from a private `responsibility_get_pid_responsible_for_pid`
//!   symbol with no Linux equivalent; WebKitGTK's own multi-process split
//!   would need separate research. `webkit_unavailable` is always true, so
//!   the "Termic itself" row is honest about missing that slice.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use parking_lot::Mutex;

use crate::procmon_common::{build_child_map, collect_subtree, cpu_ratio, label_for, signal_from_name, EMPTY_SET};
// Re-exported: lib.rs reaches these as `procmon::Root` / `procmon::Snapshot`
// regardless of which platform module `procmon` resolves to.
pub use crate::procmon_common::{ChildRow, ProcRow, Root, Snapshot};

/// `sysconf(_SC_CLK_TCK)` — how many "clock ticks" per second `/proc/<pid>/
/// stat`'s utime/stime/starttime are counted in. 100 on every Linux this
/// app is likely to run on, but read it rather than assume: it is the one
/// number that would silently misreport CPU% if it were ever wrong.
fn clk_tck() -> i64 {
    static V: OnceLock<i64> = OnceLock::new();
    *V.get_or_init(|| {
        let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if v > 0 { v } else { 100 }
    })
}

/// ticks -> milliseconds, using the real tick rate (see `clk_tck`).
fn ticks_to_ms(ticks: u64) -> u64 {
    (ticks.saturating_mul(1000)) / clk_tck().max(1) as u64
}

/// Ticks since boot, right now. Same epoch `/proc/<pid>/stat`'s `starttime`
/// field already uses, so both a wall-clock delta between two samples AND
/// `now - a process's starttime` (its uptime) are a plain subtraction with
/// no epoch reconciliation needed.
fn now_boot_ticks() -> u64 {
    let secs = fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|s| s.split_whitespace().next().map(str::to_string))
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    (secs * clk_tck() as f64) as u64
}

/// Every pid currently in `/proc` — its numeric entries are exactly the
/// live process list, no listpids-style syscall needed.
fn all_pids() -> Vec<u32> {
    let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .collect()
}

struct StatFields {
    comm: String,
    ppid: u32,
    utime: u64,
    stime: u64,
    num_threads: u32,
    starttime: u64,
}

/// Parse `/proc/<pid>/stat`. `comm` is bounded by the FIRST `(` and the
/// LAST `)` — the kernel does not escape it, so a process named e.g.
/// `a) (b` would otherwise desync every field after it. Field indices below
/// are counted from state (field 3, the first one after the closing paren):
/// see `man 5 proc`.
fn read_stat(pid: u32) -> Option<StatFields> {
    let raw = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = raw.find('(')?;
    let close = raw.rfind(')')?;
    let comm = raw[open + 1..close].to_string();
    let fields: Vec<&str> = raw[close + 1..].trim_start().split_whitespace().collect();
    let get = |field_num: usize| fields.get(field_num - 3).copied();
    Some(StatFields {
        comm,
        ppid: get(4)?.parse().ok()?,
        utime: get(14)?.parse().ok()?,
        stime: get(15)?.parse().ok()?,
        num_threads: get(20)?.parse().ok()?,
        starttime: get(22)?.parse().ok()?,
    })
}

/// `VmRSS` from `/proc/<pid>/status`, converted from the kernel's kB to
/// bytes. `0` (rather than `None`) for a process that raced us and exited,
/// or a kernel thread with no RSS line at all — same "missing reads as
/// nothing to add" shape as the macOS fallback.
fn read_rss_bytes(pid: u32) -> u64 {
    let Ok(raw) = fs::read_to_string(format!("/proc/{pid}/status")) else { return 0 };
    for line in raw.lines() {
        let Some(rest) = line.strip_prefix("VmRSS:") else { continue };
        let Some(kb_str) = rest.trim().strip_suffix("kB").map(str::trim) else { continue };
        if let Ok(kb) = kb_str.parse::<u64>() {
            return kb.saturating_mul(1024);
        }
    }
    0
}

struct PidStats {
    /// utime+stime, in clock ticks (see `clk_tck`).
    cpu: u64,
    threads: u32,
    rss: u64,
    /// Ticks since boot — same epoch as `now_boot_ticks()`.
    start_ticks: u64,
}

fn pid_stats(pid: u32) -> Option<PidStats> {
    let st = read_stat(pid)?;
    Some(PidStats {
        cpu: st.utime.saturating_add(st.stime),
        threads: st.num_threads,
        rss: read_rss_bytes(pid),
        start_ticks: st.starttime,
    })
}

// ───────────────────────────── session ─────────────────────────────
// Identical shape to procmon.rs's — see that module for the reasoning
// behind each field (delta bookkeeping, output rate, capped history).

const HISTORY_LEN: usize = 90;
const MAX_CHILDREN: usize = 8;

struct Session {
    id: u64,
    prev_cpu: HashMap<u32, u64>,
    prev_wall: u64,
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
        prev_wall: 0,
        prev_out: HashMap::new(),
        hist: HashMap::new(),
    });
    sample(id, roots).unwrap_or_else(|_| Snapshot {
        session: id,
        unix_ms: unix_ms_now(),
        rows: Vec::new(),
        sample_ms: 0.0,
        webkit_unavailable: true,
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
    let began = std::time::Instant::now();
    {
        let g = STATE.lock();
        match g.as_ref() {
            None => return Err("procmon: no active session".into()),
            Some(s) if s.id != session => return Err("procmon: stale session".into()),
            Some(_) => {}
        }
    }

    // ── pass 1: the whole pid table, cheap fields only ──
    let pids = all_pids();
    let mut ppid: HashMap<u32, u32> = HashMap::with_capacity(pids.len());
    let mut comm: HashMap<u32, String> = HashMap::with_capacity(pids.len());
    for pid in pids {
        let Some(st) = read_stat(pid) else { continue };
        ppid.insert(pid, st.ppid);
        comm.insert(pid, st.comm);
    }
    let children = build_child_map(&ppid);

    // No WebKit-sidecar pass here — see the module doc.
    let webkit_unavailable = true;

    // ── subtrees ──
    let us = std::process::id();
    let pty_root_pids: HashSet<u32> =
        roots.iter().filter(|r| r.pty_id.is_some()).map(|r| r.pid).collect();
    let now_wall = now_boot_ticks();
    let now_unix = unix_ms_now();

    let mut g = STATE.lock();
    let Some(sess) = g.as_mut() else {
        return Err("procmon: session ended".into());
    };
    if sess.id != session {
        return Err("procmon: stale session".into());
    }
    let delta_wall = now_wall.saturating_sub(sess.prev_wall);
    let have_baseline = sess.prev_wall != 0 && delta_wall > 0;

    let mut next_cpu: HashMap<u32, u64> = HashMap::new();
    let mut rows: Vec<ProcRow> = Vec::with_capacity(roots.len());
    let mut seen_keys: HashSet<String> = HashSet::with_capacity(roots.len());

    for root in &roots {
        let stop: &HashSet<u32> = if root.pid == us { &pty_root_pids } else { &EMPTY_SET };
        let members = collect_subtree(root.pid, &children, stop);

        let mut cpu_ticks_total = 0u64;
        let mut cpu_delta = 0u64;
        let mut rss = 0u64;
        let mut threads = 0u32;
        let mut alive = false;
        let mut start_ticks = 0u64;
        let mut kids: Vec<ChildRow> = Vec::new();

        for &pid in &members {
            let Some(st) = pid_stats(pid) else { continue };
            alive = true;
            if pid == root.pid {
                start_ticks = st.start_ticks;
            }
            cpu_ticks_total = cpu_ticks_total.saturating_add(st.cpu);
            rss = rss.saturating_add(st.rss);
            threads = threads.saturating_add(st.threads);
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
                mem_bytes: st.rss,
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
            // No phys_footprint equivalent on Linux — see the module doc.
            mem_bytes: rss,
            rss_bytes: rss,
            proc_count,
            threads,
            cpu_ms: ticks_to_ms(cpu_ticks_total),
            uptime_ms: if start_ticks > 0 {
                ticks_to_ms(now_wall.saturating_sub(start_ticks))
            } else {
                0
            },
            out_bps,
            alive,
            cpu_history: h.clone(),
            children: kids,
        });
    }

    sess.hist.retain(|k, _| seen_keys.contains(k));
    sess.prev_out.retain(|k, _| seen_keys.contains(k));
    sess.prev_cpu = next_cpu;
    sess.prev_wall = now_wall;
    drop(g);

    Ok(Snapshot {
        session,
        unix_ms: now_unix,
        rows,
        sample_ms: began.elapsed().as_secs_f64() * 1000.0,
        webkit_unavailable,
    })
}

/// Send `sig` to `pid`, but ONLY if it sits inside the subtree of a PTY we
/// spawned — same refusal logic and reasoning as procmon.rs's `signal`.
pub fn signal(roots: &[Root], pid: u32, sig_name: &str) -> Result<(), String> {
    let Some(sig) = signal_from_name(sig_name) else {
        return Err(format!("unsupported signal {sig_name}"));
    };
    if pid == 0 || pid == std::process::id() {
        return Err("refusing to signal Termic itself".into());
    }
    let mut ppid: HashMap<u32, u32> = HashMap::new();
    for p in all_pids() {
        if let Some(st) = read_stat(p) {
            ppid.insert(p, st.ppid);
        }
    }
    let children = build_child_map(&ppid);
    let owned = roots.iter().filter(|r| r.pty_id.is_some()).any(|r| {
        collect_subtree(r.pid, &children, &EMPTY_SET).contains(&pid)
    });
    if !owned {
        return Err("pid is not part of a Termic terminal".into());
    }
    // SAFETY: kill(2) is async-signal-safe and the pid is validated above.
    let rc = unsafe { libc::kill(pid as libc::c_int, sig) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session is process-global (there is one Activity window), so the
    /// tests that drive it must not run concurrently with each other.
    static SESSION_TEST: Mutex<()> = Mutex::new(());

    /// `/proc/uptime` carries two decimals, so the tick counter the sampler
    /// diffs against only moves every 10ms. Two back-to-back samples can land
    /// inside the SAME tick, where `delta_wall == 0` means "no time passed"
    /// and every row honestly reports no CPU delta. Production never hits it
    /// (the window samples at 1Hz), but a test that samples twice in a row
    /// does, and it is why this used to fail only on CI's faster /proc.
    fn wait_for_a_tick() {
        let start = now_boot_ticks();
        while now_boot_ticks() == start {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn signal_refuses_our_own_pid() {
        let err = signal(&[], std::process::id(), "TERM").unwrap_err();
        assert!(err.contains("Termic itself"), "{err}");
    }

    #[test]
    fn signal_refuses_a_pid_we_do_not_own() {
        // pid 1 (init/systemd) is emphatically not one of our terminals.
        let err = signal(&[], 1, "TERM").unwrap_err();
        assert!(err.contains("not part of"), "{err}");
    }

    #[test]
    fn reads_the_real_process_table() {
        let pids = all_pids();
        assert!(pids.len() > 5, "expected a populated pid table, got {}", pids.len());
        let us = std::process::id();
        assert!(pids.contains(&us));
        let st = read_stat(us).expect("own stat");
        assert!(st.ppid > 0);
        assert!(!st.comm.is_empty());
    }

    #[test]
    fn reads_our_own_stats() {
        let st = pid_stats(std::process::id()).expect("own stats");
        assert!(st.threads >= 1);
        assert!(st.rss > 0, "RSS should be non-zero");
        assert!(st.start_ticks > 0, "starttime should be populated");
    }

    #[test]
    fn clk_tck_is_sane() {
        // Every real Linux reports 100; this just guards the sysconf call
        // itself resolving to something usable.
        assert!(clk_tck() > 0);
    }

    /// End-to-end check that the CPU math produces a REAL percentage: peg
    /// one core and the row must report something near 100, not fractions
    /// of it (a tick-rate mismatch) and not thousands (the inverse).
    #[test]
    fn cpu_percent_tracks_a_busy_core() {
        fn app_root() -> Vec<Root> {
            vec![Root {
                key: "app".into(),
                kind: "app".into(),
                pty_id: None,
                task_id: None,
                tab_id: None,
                pid: std::process::id(),
                out_bytes: None,
            }]
        }
        let _guard = SESSION_TEST.lock();
        let base = start(app_root());
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
        let hot = sample(base.session, app_root()).expect("sample while busy");
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
        let _guard = SESSION_TEST.lock();
        let snap = start(vec![Root {
            key: "app".into(),
            kind: "app".into(),
            pty_id: None,
            task_id: None,
            tab_id: None,
            pid: std::process::id(),
            out_bytes: None,
        }]);
        assert!(is_running());
        assert_eq!(snap.rows.len(), 1);
        assert!(snap.rows[0].cpu_pct.is_none());
        assert!(snap.rows[0].alive);

        wait_for_a_tick();
        let second = sample(snap.session, vec![Root {
            key: "app".into(),
            kind: "app".into(),
            pty_id: None,
            task_id: None,
            tab_id: None,
            pid: std::process::id(),
            out_bytes: None,
        }])
        .expect("second sample");
        assert!(second.rows[0].cpu_pct.is_some(), "second sample must have a delta");
        assert_eq!(second.rows[0].cpu_history.len(), 2);

        assert!(sample(snap.session + 999, Vec::new()).is_err());

        stop(snap.session);
        assert!(!is_running());
        assert!(sample(snap.session, Vec::new()).is_err());
    }
}

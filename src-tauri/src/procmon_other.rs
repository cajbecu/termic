//! Non-macOS stand-in for `procmon.rs`. The real implementation is pure
//! libproc/mach FFI (`proc_pidinfo`, `mach_absolute_time`, …), which only
//! exists on Darwin — linking it into a Linux/Windows build fails outright,
//! it isn't just inaccurate there. This mirrors the real module's public
//! surface so `lib.rs`'s `procmon_start`/`sample`/`stop`/`signal` commands
//! need no `#[cfg]` of their own: they always exist, they just report "the
//! Activity monitor is macOS-only" instead of a process table.

use serde::Serialize;

#[derive(Clone, Debug)]
pub struct Root {
    pub key: String,
    pub kind: String,
    pub pty_id: Option<String>,
    pub task_id: Option<String>,
    pub tab_id: Option<String>,
    pub pid: u32,
    pub out_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct ChildRow {
    pub pid: u32,
    pub label: String,
    pub cpu_pct: Option<f64>,
    pub mem_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pub key: String,
    pub kind: String,
    pub pty_id: Option<String>,
    pub task_id: Option<String>,
    pub tab_id: Option<String>,
    pub pid: u32,
    pub label: String,
    pub cpu_pct: Option<f64>,
    pub mem_bytes: u64,
    pub rss_bytes: u64,
    pub proc_count: u32,
    pub threads: u32,
    pub cpu_ms: u64,
    pub uptime_ms: u64,
    pub out_bps: Option<f64>,
    pub alive: bool,
    pub cpu_history: Vec<f64>,
    pub children: Vec<ChildRow>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session: u64,
    pub unix_ms: f64,
    pub rows: Vec<ProcRow>,
    pub sample_ms: f64,
    pub webkit_unavailable: bool,
}

/// Always "session 0, no rows" — there is nothing to sample on this OS.
pub fn start(_roots: Vec<Root>) -> Snapshot {
    Snapshot { session: 0, unix_ms: 0.0, rows: Vec::new(), sample_ms: 0.0, webkit_unavailable: false }
}

pub fn stop(_session: u64) {}
pub fn stop_all() {}

pub fn sample(_session: u64, _roots: Vec<Root>) -> Result<Snapshot, String> {
    Err("Activity monitor is only available on macOS".into())
}

pub fn signal(_roots: &[Root], _pid: u32, _sig_name: &str) -> Result<(), String> {
    Err("Activity monitor is only available on macOS".into())
}

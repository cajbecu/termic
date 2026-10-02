//! Stand-in for `procmon.rs` on every OS that isn't macOS, Linux or Windows.
//! None of the real implementations' syscalls exist there, so this just
//! answers "unsupported" — see lib.rs's `mod procmon` cfg split.

pub use crate::procmon_common::{ProcRow, Root, Snapshot};
#[cfg(test)]
pub use crate::procmon_common::ChildRow;

pub fn start(_roots: Vec<Root>) -> Snapshot {
    Snapshot { session: 0, unix_ms: 0.0, rows: Vec::new(), sample_ms: 0.0, webkit_unavailable: true }
}

pub fn stop(_session: u64) {}
pub fn stop_all() {}

pub fn sample(_session: u64, _roots: Vec<Root>) -> Result<Snapshot, String> {
    Err("Activity monitor is not available on this OS".into())
}

pub fn signal(_roots: &[Root], _pid: u32, _sig_name: &str) -> Result<(), String> {
    Err("Activity monitor is not available on this OS".into())
}

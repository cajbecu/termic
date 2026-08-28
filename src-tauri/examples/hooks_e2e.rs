//! Drives the REAL install/remove path against whatever `$HOME` points at, so
//! the hook lab can prove the generated artifact works end to end with a live
//! agent rather than a hand-written copy of it.
//!
//! Local only, never CI. Usage:
//!   HOME=/scratch cargo run --example hooks_e2e -- install|status|remove
use termic_lib::agent_hooks::{self, Target};

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "status".into());
    let t = Target::Host;
    match arg.as_str() {
        "install" => match agent_hooks::install(&t) {
            Ok(()) => println!("installed"),
            Err(e) => { eprintln!("install failed: {e}"); std::process::exit(1); }
        },
        "remove" => match agent_hooks::remove(&t) {
            Ok(()) => println!("removed"),
            Err(e) => { eprintln!("remove failed: {e}"); std::process::exit(1); }
        },
        _ => {}
    }
    let s = agent_hooks::status(&t);
    println!("installed={} settings={} scripts={} disabled_all={} err={:?}",
             s.installed, s.settings_path, s.script_dir, s.disabled_all, s.error);
}

//! Agent lifecycle hooks: one hook, installed into Claude's own config, that
//! tells termic the moment the agent is blocked on the user.
//!
//! Why this exists: Claude paints its IDLE glyph while it is waiting on a
//! permission prompt, a question, or plan approval. termic reads that title,
//! arms its 5s settle, and fires a "done" badge about a second before the
//! native OSC 9 notify (6.0s late) corrects it to "needs you". Measured; see
//! `docs/plans/agent-hooks.md`.
//!
//! The transport is deliberately not IPC. A Claude hook's stdout JSON may carry
//! a `terminalSequence`, which Claude writes to its own PTY, and `TerminalPane`
//! already parses OSC 777 into `goAttention` (which calls `cancelSettle`, and
//! that is what kills the false done). So there is no socket, no callback
//! binary, no Seatbelt grant and no Docker plumbing: the channel is the terminal
//! the agent already owns, and it behaves identically caged and uncaged.
//!
//! Two things here are load-bearing and easy to undo by accident:
//!
//! 1. The script lives in the agent's OWN config dir, never the termic data
//!    dir. Seatbelt denies the data dir read AND write, and `$HOME/.config` is
//!    not in `sandbox::system_read_roots()`, so a caged agent could exec a
//!    script in neither. `~/.claude` is already readable in the cage.
//! 2. The script bails unless `TERMIC_TASK_ID` is set and `GROK_HOOK_EVENT` is
//!    not. The install is GLOBAL, so without the first gate we would write OSC
//!    into every terminal the user runs claude in; and Grok reads
//!    `~/.claude/settings.json` too (measured), so without the second we would
//!    silently change an agent the user never opted in for.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bump when the script body or the settings entry shape changes. Recorded in
/// the manifest so a later version knows an older install is stale and replaces
/// it rather than appending a second entry.
pub const SCHEMA_VERSION: u32 = 1;

/// The single event we register. See the plan for why `UserPromptSubmit`,
/// `Stop` and `SessionStart` are all deliberately absent: termic already has
/// each of those signals at the same instant or better, so registering them
/// would buy nothing and cost a process spawn per turn.
const EVENT: &str = "PermissionRequest";

/// Directory we create inside the agent's config dir. Also the prefix that
/// identifies our entries for removal, which is why it must never be renamed
/// without a `SCHEMA_VERSION` bump and a migration.
const SCRIPT_DIR: &str = "termic-hooks";
const SCRIPT_NAME: &str = "permission-request.sh";
const MANIFEST_NAME: &str = "manifest.json";
const BACKUP_NAME: &str = "settings.json.termic-backup";

/// Where a given install writes. Host is the user's real `~/.claude`; Docker is
/// the termic-owned config dir that gets bind-mounted into the container, which
/// is why a Docker install needs no consent (it mutates nothing of the user's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Host,
    /// Carries the agent's OWN id (a clone keeps its own folder), not the base
    /// id. `docker.rs` documents why conflating the two makes clones unusable.
    Docker(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub schema_version: u32,
    /// Absolute path we wrote into `settings.json`. Host or container form.
    pub command: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HookStatus {
    pub installed: bool,
    /// `settings.json` we would write, so the UI can name it BEFORE writing.
    pub settings_path: String,
    pub script_dir: String,
    /// True when the user has set `disableAllHooks`. An install is then a no-op
    /// and the UI must say so rather than report success.
    pub disabled_all: bool,
    /// Set when the config could not be read or parsed. Install is refused.
    pub error: Option<String>,
    pub schema_version: Option<u32>,
}

// ─────────────────────────── The script ────────────────────────────────

/// The hook body. `printf '%s'` with a single-quoted argument so the shell
/// never touches the backslashes: the escape and bell reach Claude as the JSON
/// escapes `` / ``, never as raw control bytes, which keeps the file
/// greppable and diffable.
pub fn script_body() -> String {
    // OSC 777 is what TerminalPane already handles. The body must NOT match
    // `BUILTIN_NOTIFY_IGNORE.claude` (`["is waiting for your input"]`) or
    // `notificationWantsAttention` filters it out and the whole feature dies
    // silently. `src/lib/agentHooks.test.ts` pins that.
    let seq = "\\u001b]777;notify;termic;agent needs your input\\u0007";
    format!(
        r#"#!/bin/sh
# termic agent hook (generated, schema v{SCHEMA_VERSION}). Safe to delete.
#
# Tells termic the agent is blocked on you, by writing one OSC sequence to the
# agent's own terminal. No network, no files, no arguments, no stdin parsing.
# Exits 0 on every path: a hook must never be why an agent stalls.

# Not spawned by a termic PTY (this file is installed globally, so it also runs
# in iTerm, Ghostty and CI). Stay silent there.
[ -n "$TERMIC_TASK_ID" ] || exit 0

# Grok reads ~/.claude/settings.json too, with a camelCase payload and an output
# contract that has no terminalSequence. Emitting ours there is useless, and the
# user never opted Grok in. Measured; see docs/plans/agent-hooks.md.
[ -z "$GROK_HOOK_EVENT" ] || exit 0

printf '%s' '{{"terminalSequence":"{seq}"}}'
exit 0
"#
    )
}

// ───────────────────────── Pure JSON surgery ───────────────────────────
//
// Kept pure and separate from the filesystem so the merge rules can be tested
// exhaustively without a HOME fixture. These are the functions that must not
// eat a user's hand-written hooks.

/// True when this hook entry is one of ours, decided by the `command` path
/// prefix rather than a marker key. A marker would need Claude's schema to
/// tolerate unknown fields (Codex's rejects the whole file over one), and a
/// path survives the user reformatting their config.
fn is_ours(entry: &Value, prefix: &str) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.starts_with(prefix))
}

/// Strip every entry of ours from `hooks.<EVENT>`, dropping groups and keys
/// that become empty. Returns true when anything was removed.
fn strip_ours(root: &mut Value, prefix: &str) -> bool {
    let mut removed = false;
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    if let Some(groups) = hooks.get_mut(EVENT).and_then(Value::as_array_mut) {
        for group in groups.iter_mut() {
            if let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                let before = list.len();
                list.retain(|e| !is_ours(e, prefix));
                removed |= list.len() != before;
            }
        }
        // A group whose hook list we emptied was ours alone; drop it. A group
        // that still holds user hooks stays exactly as it was.
        groups.retain(|g| {
            g.get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|l| !l.is_empty())
        });
        if groups.is_empty() {
            hooks.remove(EVENT);
        }
    }
    if hooks.is_empty() {
        root.as_object_mut().map(|o| o.remove("hooks"));
    }
    removed
}

/// Insert our entry, replacing any older one of ours. Every unknown key at
/// every level is preserved: we only ever touch `hooks.<EVENT>`.
pub fn merge(existing: &Value, command: &str, prefix: &str) -> Value {
    let mut root = if existing.is_object() {
        existing.clone()
    } else {
        Value::Object(Map::new())
    };
    strip_ours(&mut root, prefix);

    let entry = serde_json::json!({
        "type": "command",
        "command": command,
        "timeout": 5,
        "statusMessage": "termic: reporting that you are needed",
    });

    let obj = root.as_object_mut().expect("root is an object");
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks.as_object_mut().expect("hooks is an object");
    let groups = hooks.entry(EVENT).or_insert_with(|| Value::Array(vec![]));
    if !groups.is_array() {
        *groups = Value::Array(vec![]);
    }
    groups
        .as_array_mut()
        .expect("groups is an array")
        .push(serde_json::json!({ "hooks": [entry] }));
    root
}

/// Remove our entry. Returns `None` when there was nothing of ours to remove,
/// so the caller can leave the file completely untouched.
pub fn unmerge(existing: &Value, prefix: &str) -> Option<Value> {
    let mut root = existing.clone();
    if !strip_ours(&mut root, prefix) {
        return None;
    }
    Some(root)
}

/// Whether the user has switched every hook off. Install must respect it and
/// say so, rather than writing a file that will never fire.
pub fn disable_all_hooks(root: &Value) -> bool {
    root.get("disableAllHooks")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

// ─────────────────────────── Paths ─────────────────────────────────────

/// Host config dir for claude (`~/.claude`), from the same table Seatbelt and
/// Docker read, so the three cannot drift.
///
/// The e2e build lets `TERMIC_E2E_AGENT_HOME` stand in for `$HOME`. Without it
/// the suite's only way to exercise install/remove would be to write into the
/// developer's REAL `~/.claude/settings.json`, which is not a test, it is a
/// hazard. Feature-gated so no release binary can be pointed anywhere but the
/// user's own home. Indexed in `docs/tech-debt.md`.
fn host_config_dir() -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    let home = match std::env::var_os("TERMIC_E2E_AGENT_HOME") {
        Some(v) => PathBuf::from(v),
        None => dirs::home_dir().ok_or_else(|| "no home directory".to_string())?,
    };
    #[cfg(not(feature = "e2e"))]
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    let first = crate::agent_dirs::state_dirs("claude")
        .first()
        .ok_or_else(|| "claude has no known state dir".to_string())?;
    Ok(home.join(first))
}

/// The directory we write into, on the host filesystem, for a given target.
pub fn config_dir(target: &Target) -> Result<PathBuf, String> {
    match target {
        Target::Host => host_config_dir(),
        Target::Docker(agent_id) => Ok(crate::docker::agent_config_host_dir(agent_id)),
    }
}

/// The `command` string written INTO settings.json. For Docker this must be the
/// path as the CONTAINER sees it, not the host path: the config dir is
/// bind-mounted at `CONTAINER_HOME/.claude`, so a host path would not resolve
/// inside the cage.
pub fn command_path(target: &Target) -> Result<String, String> {
    Ok(match target {
        Target::Host => config_dir(target)?
            .join(SCRIPT_DIR)
            .join(SCRIPT_NAME)
            .to_string_lossy()
            .into_owned(),
        Target::Docker(_) => {
            let first = crate::agent_dirs::state_dirs("claude")
                .first()
                .ok_or_else(|| "claude has no known state dir".to_string())?;
            format!(
                "{}/{}/{}/{}",
                crate::docker::CONTAINER_HOME,
                first,
                SCRIPT_DIR,
                SCRIPT_NAME
            )
        }
    })
}

/// Everything under this prefix is ours. Used for removal matching.
pub fn command_prefix(target: &Target) -> Result<String, String> {
    let full = command_path(target)?;
    Ok(full
        .strip_suffix(SCRIPT_NAME)
        .map(str::to_string)
        .unwrap_or(full))
}

fn settings_path(target: &Target) -> Result<PathBuf, String> {
    Ok(config_dir(target)?.join("settings.json"))
}

fn script_dir(target: &Target) -> Result<PathBuf, String> {
    Ok(config_dir(target)?.join(SCRIPT_DIR))
}

// ─────────────────────────── Filesystem ────────────────────────────────

/// NOTE: `serde_json` is built with `preserve_order` (see `Cargo.toml`).
/// Without it `Map` is a `BTreeMap` and every install silently re-sorts the
/// user's `settings.json` into alphabetical order, which is a visible,
/// pointless rewrite of a file they hand-wrote, and it also defeats the
/// byte-identical restore below.
///
/// Write via a temp file in the SAME directory then rename, so a crash or a
/// full disk can never leave a half-written `settings.json` behind. That file
/// breaks the user's agent, not just termic.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.termic-tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create temp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write temp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync temp: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename into place: {e}"))
}

/// Read and parse settings.json. A missing file is an empty object; malformed
/// JSON is an ERROR, never an empty object, because overwriting a config we
/// failed to understand would destroy the user's own hooks.
fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("read {}: {e}", path.display())),
        Ok(s) if s.trim().is_empty() => Ok(Value::Object(Map::new())),
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display())),
    }
}

pub fn status(target: &Target) -> HookStatus {
    let settings = settings_path(target);
    let script = script_dir(target);
    let (settings_path_s, script_dir_s) = (
        settings
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        script
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    let mut out = HookStatus {
        installed: false,
        settings_path: settings_path_s,
        script_dir: script_dir_s,
        disabled_all: false,
        error: None,
        schema_version: None,
    };
    let (Ok(settings), Ok(script)) = (settings, script) else {
        out.error = Some("could not resolve the claude config directory".into());
        return out;
    };
    let root = match read_settings(&settings) {
        Ok(v) => v,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    out.disabled_all = disable_all_hooks(&root);
    let Ok(prefix) = command_prefix(target) else {
        return out;
    };
    // Installed means the settings entry is present. A stray script directory
    // without the entry is not an install; removal cleans both anyway.
    out.installed = root
        .get("hooks")
        .and_then(|h| h.get(EVENT))
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|l| l.iter().any(|e| is_ours(e, &prefix)))
            })
        });
    out.schema_version = std::fs::read_to_string(script.join(MANIFEST_NAME))
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        .map(|m| m.schema_version);
    out
}

pub fn install(target: &Target) -> Result<(), String> {
    let settings = settings_path(target)?;
    let dir = script_dir(target)?;
    let command = command_path(target)?;
    let prefix = command_prefix(target)?;

    // Refuse rather than clobber a config we could not parse.
    let root = read_settings(&settings)?;
    if disable_all_hooks(&root) {
        return Err(
            "disableAllHooks is set in this config, so a hook would never run. \
             Clear it first."
                .into(),
        );
    }

    // Back the original up once, before the first write, so a botched merge is
    // recoverable and removal can restore byte-for-byte.
    let backup = dir.join(BACKUP_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    if !backup.exists() && settings.exists() {
        std::fs::copy(&settings, &backup).map_err(|e| format!("back up settings.json: {e}"))?;
    }

    let script = dir.join(SCRIPT_NAME);
    write_atomic(&script, script_body().as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod hook script: {e}"))?;
    }

    let merged = merge(&root, &command, &prefix);
    let mut bytes = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_atomic(&settings, &bytes)?;

    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        command,
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    write_atomic(
        &dir.join(MANIFEST_NAME),
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
}

pub fn remove(target: &Target) -> Result<(), String> {
    let settings = settings_path(target)?;
    let dir = script_dir(target)?;
    let prefix = command_prefix(target)?;

    let root = read_settings(&settings)?;
    if let Some(stripped) = unmerge(&root, &prefix) {
        // If what remains matches the pre-install backup, restore the backup's
        // BYTES: that is the only way "removal leaves the file byte-identical"
        // survives our own pretty-printer reformatting the user's spacing.
        let backup = dir.join(BACKUP_NAME);
        let restored = std::fs::read(&backup).ok().filter(|b| {
            serde_json::from_slice::<Value>(b).is_ok_and(|orig| orig == stripped)
        });
        match restored {
            Some(bytes) => write_atomic(&settings, &bytes)?,
            None => {
                let mut bytes = serde_json::to_vec_pretty(&stripped).map_err(|e| e.to_string())?;
                bytes.push(b'\n');
                write_atomic(&settings, &bytes)?;
            }
        }
    }
    // Remove our directory whether or not the settings entry was there: a user
    // who hand-deleted the entry still wants the scripts gone.
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

// ─────────────────────────── Commands ──────────────────────────────────

/// Agents this build can wire. Phase 1 is claude alone; the UI reads this so a
/// row can say "not supported yet" rather than offering a button that fails.
pub const SUPPORTED: &[&str] = &["claude"];

fn check_supported(agent_id: &str) -> Result<(), String> {
    if SUPPORTED.contains(&agent_id) {
        Ok(())
    } else {
        Err(format!("hooks are not supported for {agent_id} yet"))
    }
}

/// Per-agent status across BOTH targets. One toggle governs the pair, so the UI
/// needs to see both to render a single honest row.
#[derive(Debug, Clone, Serialize)]
pub struct AgentHookStatus {
    pub agent_id: String,
    pub supported: bool,
    pub host: HookStatus,
    pub docker: HookStatus,
}

#[tauri::command]
pub fn agent_hooks_status(agent_id: String) -> AgentHookStatus {
    AgentHookStatus {
        supported: SUPPORTED.contains(&agent_id.as_str()),
        host: status(&Target::Host),
        docker: status(&Target::Docker(agent_id.clone())),
        agent_id,
    }
}

/// Install for one agent, covering host AND its Docker config dir. Docker needs
/// no separate consent (termic owns that dir) but must never be installed for an
/// agent the user declined, which is why it rides this one call.
#[tauri::command]
pub fn agent_hooks_install(agent_id: String) -> Result<AgentHookStatus, String> {
    check_supported(&agent_id)?;
    install(&Target::Host)?;
    // A Docker failure must not leave the host half installed and the UI lying,
    // so roll the host back and report the real error.
    if let Err(e) = install(&Target::Docker(agent_id.clone())) {
        let _ = remove(&Target::Host);
        return Err(format!("installed for the host but not for Docker, so nothing was kept: {e}"));
    }
    Ok(agent_hooks_status(agent_id))
}

/// Remove for one agent, both targets. Deliberately NOT gated on `SUPPORTED`:
/// a user who downgrades termic, or who had a since-dropped agent wired, must
/// still be able to clean up.
#[tauri::command]
pub fn agent_hooks_remove(agent_id: String) -> Result<AgentHookStatus, String> {
    let host = remove(&Target::Host);
    let docker = remove(&Target::Docker(agent_id.clone()));
    host.and(docker)?;
    Ok(agent_hooks_status(agent_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "/home/u/.claude/termic-hooks/";
    const C: &str = "/home/u/.claude/termic-hooks/permission-request.sh";

    fn ours_count(v: &Value) -> usize {
        v.get("hooks")
            .and_then(|h| h.get(EVENT))
            .and_then(Value::as_array)
            .map(|groups| {
                groups
                    .iter()
                    .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                    .flatten()
                    .filter(|e| is_ours(e, P))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn installs_into_an_empty_config() {
        let out = merge(&serde_json::json!({}), C, P);
        assert_eq!(ours_count(&out), 1);
        let entry = &out["hooks"][EVENT][0]["hooks"][0];
        assert_eq!(entry["type"], "command");
        assert_eq!(entry["command"], C);
        // Never a control field: we observe, we do not gate.
        assert!(entry.get("decision").is_none());
        assert!(entry.get("async").is_none());
    }

    #[test]
    fn users_own_hooks_survive_verbatim() {
        let before = serde_json::json!({
            "model": "opus",
            "hooks": {
                "PermissionRequest": [
                    { "hooks": [{ "type": "command", "command": "/usr/local/bin/audit" }] }
                ],
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "/usr/local/bin/done" }] }
                ]
            }
        });
        let after = merge(&before, C, P);
        assert_eq!(after["model"], "opus", "unknown top-level keys preserved");
        assert_eq!(after["hooks"]["Stop"], before["hooks"]["Stop"], "other events untouched");
        assert_eq!(
            after["hooks"][EVENT][0], before["hooks"][EVENT][0],
            "the user's own entry for OUR event is untouched"
        );
        assert_eq!(ours_count(&after), 1);
    }

    #[test]
    fn install_is_idempotent() {
        let once = merge(&serde_json::json!({}), C, P);
        let twice = merge(&once, C, P);
        assert_eq!(ours_count(&twice), 1, "no duplicate entry");
        assert_eq!(once, twice);
    }

    #[test]
    fn an_older_entry_of_ours_is_replaced_not_appended() {
        let stale = serde_json::json!({
            "hooks": { EVENT: [
                { "hooks": [{ "type": "command", "command": format!("{P}old-name.sh"), "timeout": 1 }] }
            ]}
        });
        let out = merge(&stale, C, P);
        assert_eq!(ours_count(&out), 1);
        assert_eq!(out["hooks"][EVENT][0]["hooks"][0]["command"], C);
    }

    #[test]
    fn removal_restores_the_original_value() {
        let before = serde_json::json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "/x" }] }] }
        });
        let after = merge(&before, C, P);
        let back = unmerge(&after, P).expect("something of ours to remove");
        assert_eq!(back, before, "byte-identical after a round trip");
    }

    #[test]
    fn removal_from_a_config_that_was_empty_leaves_it_empty() {
        let after = merge(&serde_json::json!({}), C, P);
        let back = unmerge(&after, P).unwrap();
        assert_eq!(back, serde_json::json!({}), "our own hooks key is cleaned up");
    }

    #[test]
    fn removal_is_a_noop_when_nothing_is_ours() {
        let theirs = serde_json::json!({
            "hooks": { EVENT: [{ "hooks": [{ "type": "command", "command": "/usr/local/bin/audit" }] }] }
        });
        assert!(unmerge(&theirs, P).is_none(), "left completely alone");
    }

    #[test]
    fn a_user_edited_entry_of_ours_is_still_matched_by_path() {
        // They changed the timeout and the status message but not the path.
        let edited = serde_json::json!({
            "hooks": { EVENT: [
                { "hooks": [{ "type": "command", "command": C, "timeout": 99, "note": "mine now" }] }
            ]}
        });
        assert_eq!(unmerge(&edited, P).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn a_user_entry_sharing_our_group_survives_removal() {
        let mixed = serde_json::json!({
            "hooks": { EVENT: [
                { "hooks": [
                    { "type": "command", "command": C },
                    { "type": "command", "command": "/usr/local/bin/audit" }
                ]}
            ]}
        });
        let back = unmerge(&mixed, P).unwrap();
        assert_eq!(ours_count(&back), 0);
        assert_eq!(back["hooks"][EVENT][0]["hooks"][0]["command"], "/usr/local/bin/audit");
    }

    #[test]
    fn a_non_object_root_does_not_panic() {
        let out = merge(&serde_json::json!([1, 2, 3]), C, P);
        assert_eq!(ours_count(&out), 1);
    }

    #[test]
    fn disable_all_hooks_is_detected() {
        assert!(disable_all_hooks(&serde_json::json!({ "disableAllHooks": true })));
        assert!(!disable_all_hooks(&serde_json::json!({ "disableAllHooks": false })));
        assert!(!disable_all_hooks(&serde_json::json!({})));
    }

    #[test]
    fn docker_writes_the_container_path_not_the_host_path() {
        let host = command_path(&Target::Host).unwrap();
        let docker = command_path(&Target::Docker("claude".into())).unwrap();
        assert!(docker.starts_with(crate::docker::CONTAINER_HOME), "{docker}");
        assert!(docker.ends_with(SCRIPT_NAME));
        assert_ne!(host, docker, "a host path would not resolve inside the cage");
        // The host FILE still lands in the termic-owned docker-agents dir.
        let dir = config_dir(&Target::Docker("claude".into())).unwrap();
        assert!(dir.to_string_lossy().contains("docker-agents"), "{dir:?}");
    }

    #[test]
    fn a_cloned_agent_gets_its_own_directory() {
        let a = config_dir(&Target::Docker("claude".into())).unwrap();
        let b = config_dir(&Target::Docker("claude-review".into())).unwrap();
        assert_ne!(a, b, "clones keep their own login state");
        // ...but both write claude's container path, because the SHAPE is claude's.
        assert_eq!(
            command_path(&Target::Docker("claude".into())).unwrap(),
            command_path(&Target::Docker("claude-review".into())).unwrap()
        );
    }

    #[test]
    fn the_script_gates_on_both_env_vars_and_always_exits_zero() {
        let s = script_body();
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains(r#"[ -n "$TERMIC_TASK_ID" ] || exit 0"#));
        assert!(s.contains(r#"[ -z "$GROK_HOOK_EVENT" ] || exit 0"#));
        assert!(s.contains("exit 0\n"));
        // The sequence must be JSON escapes, never raw control bytes.
        assert!(s.contains("\\u001b]777;notify;termic;"));
        assert!(!s.contains('\u{1b}'), "no raw ESC in the generated file");
        assert!(!s.contains('\u{7}'), "no raw BEL in the generated file");
        // The body must not match BUILTIN_NOTIFY_IGNORE.claude or the
        // notification is filtered out and the feature dies silently.
        assert!(!s.contains("is waiting for your input"));
    }

    #[test]
    fn read_settings_refuses_malformed_json_rather_than_replacing_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(read_settings(&p).is_err());
        // Missing and empty both mean "nothing yet", not an error.
        std::fs::write(&p, b"").unwrap();
        assert_eq!(read_settings(&p).unwrap(), serde_json::json!({}));
        assert_eq!(
            read_settings(&dir.path().join("nope.json")).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn write_atomic_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        write_atomic(&p, b"{}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{}\n");
        let strays: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("termic-tmp"))
            .collect();
        assert!(strays.is_empty(), "temp file left behind");
    }
}

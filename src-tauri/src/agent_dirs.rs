//! Single source of truth for "where does this agent's persistent state
//! actually live". Two very different consumers used to hand-maintain
//! their own copy of this and could silently drift apart:
//!
//! - Seatbelt's default `Agent.sandbox_allowed_paths` (`lib.rs`'s
//!   `default_agents()`) — real `$HOME` paths on the host, allow-listed
//!   for `sandbox-exec` to read/write directly.
//! - Docker's per-agent config-dir mount (`docker.rs`'s `agent_config()`)
//!   — container `/root` paths, bind-mounted from a termic-owned host dir
//!   that is never the host's real `$HOME`.
//!
//! Docker only wants the CONFIRMED state dirs (login, sessions, MCP
//! config — the ones `docs/plans/docker-sandbox/findings.md` actually
//! verified hold real state): it mounts a termic-owned dir, not the real
//! `$HOME`, so persisting a cache dir there buys nothing. Seatbelt allows
//! these same dirs, PLUS its own macOS-only extras (XDG-style
//! `.config`/`.local/share` paths some agents may or may not ever use,
//! `Library/Application Support/*`, regex-covered sidecar files like
//! claude's `.claude.json`) that have no Docker-container equivalent and
//! stay hand-authored in `default_agents()`.
//!
//! Keeping the CONFIRMED subset here means a renamed or added state dir
//! is a one-line change in one place, not two files quietly falling out
//! of sync.

/// One agent's confirmed state dirs, relative to its home (`$HOME` on the
/// host, `/root` inside the Docker image — both conventions land on the
/// same relative subpath). Order matters for an agent with no config-dir
/// relocation env var: the FIRST entry is Docker's primary mount, every
/// entry after it is an `extra_dirs` mount alongside it.
pub fn state_dirs(agent_id: &str) -> &'static [&'static str] {
    match agent_id {
        // claude and codex relocate their ENTIRE config dir via an env var
        // (CLAUDE_CONFIG_DIR / CODEX_HOME — see docker.rs's `agent_config`),
        // which folds HOME-root dotfiles in too (claude's `.claude.json`
        // sits inside `$CLAUDE_CONFIG_DIR` once relocated) — one dir covers
        // everything, so there is nothing else to list.
        "claude" => &[".claude"],
        "codex" => &[".codex"],
        "copilot" => &[".copilot"],
        // agy shares the `.gemini` config shape (Gemini-family CLI) plus
        // its own `.antigravity`.
        "agy" | "antigravity" => &[".gemini", ".antigravity"],
        // opencode follows XDG: config in `.config/opencode`, auth +
        // session DB in `.local/share/opencode`.
        "opencode" => &[".config/opencode", ".local/share/opencode"],
        // grok: binary, bundled skills, and config all live under `.grok`
        // with no clean relocation env. Listed here for Seatbelt (which
        // allows the real path regardless); `docker::agent_config` still
        // declines to support it — see findings.md's "outlier" writeup.
        "grok" => &[".grok"],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_agents_have_at_least_one_dir() {
        for id in ["claude", "codex", "copilot", "agy", "antigravity", "opencode", "grok"] {
            assert!(!state_dirs(id).is_empty(), "{id} should list at least one state dir");
        }
    }

    #[test]
    fn unknown_agent_has_no_dirs() {
        assert!(state_dirs("not-a-real-agent").is_empty());
    }

    #[test]
    fn every_entry_is_a_relative_dotfile_path() {
        // Every consumer prefixes these with either "$HOME/" or "/root/",
        // so a leading slash or a bare (non-dotfile) name here would
        // silently produce a wrong mount/allow-list path in both places.
        for id in ["claude", "codex", "copilot", "agy", "opencode", "grok"] {
            for dir in state_dirs(id) {
                assert!(dir.starts_with('.'), "{id}'s {dir} should be a relative dotfile path");
                assert!(!dir.starts_with('/'), "{id}'s {dir} should not be absolute");
            }
        }
    }
}

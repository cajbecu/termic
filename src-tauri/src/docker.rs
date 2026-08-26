// Docker sandbox mode (opt-in, experimental). Parallel to `sandbox.rs`,
// but the isolation boundary is a Docker container instead of macOS
// Seatbelt: the agent CLI runs inside `docker run` and can only touch the
// paths we bind-mount (the worktree, its parent `.git`, composition
// members, and a persistent per-agent config dir). Default-deny by
// construction.
//
// This module is PURE command construction + image/container lifecycle.
// No long-running daemon (consistent with the "no backend daemon" rule —
// we only shell out to the user's `docker`). `render_argv` is the single
// source of truth: the argv previewed in the UI and the argv actually
// spawned come from the same function, so they can never drift.
//
// Design: docs/plans/docker-sandbox/design.md

use crate::sandbox::{canonicalize_or_keep, parent_git_dir_for_worktree, subst_path};
use crate::{data_dir, Task};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;

/// Tag prefix for every image we build. Cleanup and listing filter on this.
const IMAGE_REPO: &str = "termic-sandbox";
/// Label key stamped on every container we run, so cleanup can find them
/// robustly even if the `--name` was munged.
const LABEL_KEY: &str = "termic.task";

// ───────────────────────────── Mounts ──────────────────────────────────

/// Why a mount exists — surfaced per-row in the dialog so the user can
/// always answer "what can this container see, and why?". `Implicit`
/// mounts are added by termic; `User` mounts come from extra-args / the
/// editable mount list.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MountProvenance {
    Implicit,
    User,
}

/// A single bind mount: host path -> container path, with rw/ro and the
/// human explanation shown in the mount list + command-preview comment.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mount {
    pub host: String,
    pub container: String,
    pub read_only: bool,
    pub provenance: MountProvenance,
    /// Plain-language reason shown in the dialog row and as the trailing
    /// `# comment` in the command preview.
    pub why: String,
    /// Load-bearing implicit mounts (worktree, parent `.git`) are shown
    /// but warn-on-remove rather than silently removable.
    pub load_bearing: bool,
}

impl Mount {
    fn implicit(host: String, container: String, read_only: bool, why: &str, load_bearing: bool) -> Self {
        Mount {
            host,
            container,
            read_only,
            provenance: MountProvenance::Implicit,
            why: why.to_string(),
            load_bearing,
        }
    }
}

// ───────────────────────────── Spec ────────────────────────────────────

/// Everything needed to render one `docker run` invocation for a task
/// agent spawn. Produced by `build_spec`; rendered to argv by `render_argv`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DockerSpec {
    /// `termic-{taskId}` (stable, human-facing).
    pub container_name: String,
    /// `termic.task={taskId}` — what cleanup filters on.
    pub label: String,
    /// `termic-sandbox:{dockerfileHash}`.
    pub image: String,
    /// host -> container bind mounts (rw/ro), with provenance + why.
    pub mounts: Vec<Mount>,
    /// Working dir inside the container — MUST equal the host cwd (same
    /// absolute path) so the worktree `.git` pointer + session cwd-key line up.
    pub workdir: String,
    /// Env injected via `-e` (TERM and config-dir relocation only — NEVER
    /// secrets; credentials arrive via the config-dir mount).
    pub env: Vec<(String, String)>,
    /// User-appended `docker run` args, inserted at a defined point.
    pub extra_args: Vec<String>,
}

// ─────────────────────── Per-agent config dir ──────────────────────────

/// How a given agent's persistent config dir is wired into the container.
/// `env_relocation` uses the agent's own relocation env var (cleanest —
/// folds even HOME-root dotfiles into the one mounted dir); the others are
/// direct dir mounts. NEVER mount the whole container HOME — it shadows
/// agent binaries baked into HOME at build time (grok in ~/.grok/bin, agy
/// in ~/.local/bin). See findings.md.
struct AgentConfig {
    /// Container path the config dir is mounted at.
    container_dir: String,
    /// `Some(VAR)` when the agent supports a config-dir relocation env var
    /// (claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`) — its value is
    /// always `container_dir`, so there is nothing else to store.
    relocation_env: Option<&'static str>,
    /// Extra container dirs to also mount from the same host config dir
    /// (e.g. agy needs `.antigravity` alongside `.gemini`; opencode splits
    /// its XDG config/data dirs).
    extra_dirs: Vec<String>,
}

/// Every agent this module has a CONFIRMED state dir for and mounts
/// unconditionally — no opt-in needed, because `agent_dirs::state_dirs`
/// only lists dirs `docs/plans/docker-sandbox/findings.md` actually
/// verified. grok is the one exception still declined outright: binary +
/// skills + config all live under `~/.grok`, no clean relocation env.
pub const KNOWN_SAFE_AGENTS: &[&str] = &["claude", "codex", "copilot", "agy", "antigravity", "opencode", "pi"];

/// Whether an agent OUTSIDE `KNOWN_SAFE_AGENTS` can even be offered the
/// opt-in "persist config in Docker mode" toggle at all. `false` for grok
/// specifically (see `agent_config`'s doc comment on why it's a permanent
/// exception) - `true` for everything else, including agents this module
/// has genuinely never heard of, since it can't rule those out.
pub fn persist_offerable(agent_id: &str) -> bool {
    agent_id != "grok"
}

/// The agent id whose Docker SHAPE applies: an agent's own id, unless it is a
/// clone, in which case the agent it extends. Follows the chain (a clone of a
/// clone) with a hop cap, so a cycle in `extends` cannot spin here.
pub fn base_agent_id<'a>(agents: &'a [crate::Agent], id: &'a str) -> &'a str {
    let mut cur = id;
    for _ in 0..8 {
        let Some(a) = agents.iter().find(|a| a.id == cur) else { return cur };
        match a.extends.as_deref() {
            Some(parent) if !parent.is_empty() && parent != cur => cur = parent,
            _ => return cur,
        }
    }
    cur
}

/// Map an agent id to its config-dir wiring.
///
/// A `KNOWN_SAFE_AGENTS` id gets its confirmed dir from
/// `agent_dirs::state_dirs` (shared with Seatbelt's default allow-list —
/// see that module's doc comment) plus any user-added extras, mounted
/// unconditionally.
///
/// Anything else — including every custom agent a user adds — has NO
/// confirmed state dir, so nothing is mounted for it unless BOTH
/// `persist_enabled` is true AND the user has listed at least one extra
/// dir themselves (Settings → Docker Sandbox → "Per-agent config dirs").
/// This is opt-in on purpose: guessing a config dir for an unknown agent
/// risks the exact failure `agent_dirs.rs` documents for grok/agy — an
/// empty dir mounted over a path that ALSO holds a binary baked into the
/// image at build time silently shadows it, and there is no way to know
/// in advance whether a given path is safe for an agent this module has
/// never seen.
/// `agent_id` names WHERE state is stored (its own host folder, which is what
/// gives a clone its own separate login). `base_id` names WHAT the agent is:
/// a clone of claude runs the claude binary and has claude's config shape, so
/// it must inherit claude's dirs and relocation var. They differ exactly for
/// a cloned agent, and conflating them is what made clones unusable in Docker
/// mode: matching on the clone's own id fell through to the unknown-agent
/// path, so nothing was mounted, nothing was relocated, and the agent wrote
/// its login into the container's throwaway filesystem (into `/root`, which
/// the non-root container user cannot even write - the EACCES a user sees).
fn agent_config(agent_id: &str, base_id: &str, user_extra_dirs: &[String], persist_enabled: bool) -> Option<AgentConfig> {
    // grok is a PERMANENT exception, not merely "not yet known safe": its
    // binary lives at `~/.grok/bin` inside its own config dir, so the
    // opt-in path below would let a user type ".grok" as an extra dir and
    // silently shadow the binary the image just installed there — the
    // exact failure mode this whole opt-in gate exists to prevent, just
    // reachable through the front door instead of a guess. No warning
    // text can fully substitute for actually knowing this in advance, so
    // it's blocked outright rather than left to the opt-in + warning.
    if base_id == "grok" {
        return None;
    }
    let sanitized: Vec<String> = user_extra_dirs.iter().filter_map(|d| sanitize_extra_dir(d)).collect();
    if KNOWN_SAFE_AGENTS.contains(&base_id) {
        let (first, rest) = crate::agent_dirs::state_dirs(base_id).split_first()?;
        let relocation_env = match base_id {
            "claude" => Some("CLAUDE_CONFIG_DIR"),
            "codex" => Some("CODEX_HOME"),
            _ => None,
        };
        let extra_dirs = rest
            .iter()
            .map(|d| format!("/root/{d}"))
            .chain(sanitized.iter().map(|d| format!("/root/{d}")))
            .collect();
        return Some(AgentConfig { container_dir: format!("/root/{first}"), relocation_env, extra_dirs });
    }
    if !persist_enabled {
        return None;
    }
    let (first, rest) = sanitized.split_first()?;
    Some(AgentConfig {
        container_dir: format!("/root/{first}"),
        relocation_env: None,
        extra_dirs: rest.iter().map(|d| format!("/root/{d}")).collect(),
    })
}

/// Reject anything that isn't a plain relative dotfile-style path before it
/// can become a mount TARGET inside the container. Without this, a stray
/// `../..` in a user-added extra dir would resolve outside `/root` (e.g.
/// `/root/../../etc` -> `/etc`), silently bind-mounting an agent's config
/// folder over an unrelated container path. Returns the trimmed, leading-
/// dot-stripped-of-slashes relative path, or `None` if it doesn't look
/// like one.
fn sanitize_extra_dir(d: &str) -> Option<String> {
    let d = d.trim();
    if d.is_empty() || d.starts_with('/') || d.contains("..") || d.contains('\0') {
        return None;
    }
    Some(d.trim_start_matches("./").to_string())
}

/// Container paths a task-level extra mount can never target: everything
/// under `/root` is already spoken for by the per-agent config dir wiring
/// (`agent_config`), and the rest are system dirs where an empty (or
/// unrelated) mount would either shadow something the image needs to boot
/// or reach for privilege-relevant files. This is a denylist of ROOTS -
/// checked by prefix, not exact match, so `/root/x` is rejected the same
/// as `/root` itself.
const UNSAFE_MOUNT_TARGET_ROOTS: &[&str] = &[
    "/root", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/var", "/opt", "/boot",
];

/// Parse + validate one `host_path:container_path` entry from
/// `Task.docker_extra_mounts`. Unlike `sanitize_extra_dir` (a name relative
/// to an agent's own config dir), this is a full user-chosen pair with two
/// independent halves to check:
/// - host: `$HOME`/`~`/`$WORKSPACE` expanded, then must resolve to a
///   non-empty absolute path (relative host paths have no fixed base to
///   resolve against the way the config-dir helpers do).
/// - container: absolute, no `..`, and not under `UNSAFE_MOUNT_TARGET_ROOTS`
///   - the container half is a deliberate user choice (see docker.rs's
///   `Task.docker_extra_mounts` doc comment for why this isn't forced to
///   match the host path), so it needs its own real validation rather than
///   reusing the host half's.
/// Returns `(host, container)` or `None` for a malformed/unsafe entry -
/// callers drop those silently rather than surfacing a spawn-time error,
/// same as every other sandbox list parser in this file.
fn sanitize_extra_mount(raw: &str, home: &str, task_path: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let (host_raw, container_raw) = raw.split_once(':')?;
    let host_raw = host_raw.trim();
    let container_raw = container_raw.trim();
    if host_raw.is_empty() || container_raw.is_empty() {
        return None;
    }
    let host = canonicalize_or_keep(&subst_path(host_raw, home, task_path));
    if host.is_empty() || !host.starts_with('/') {
        return None;
    }
    if !container_raw.starts_with('/') || container_raw.contains("..") || container_raw.contains('\0') {
        return None;
    }
    let container = container_raw.trim_end_matches('/');
    if container.is_empty()
        || UNSAFE_MOUNT_TARGET_ROOTS.iter().any(|root| container == *root || container.starts_with(&format!("{root}/")))
    {
        return None;
    }
    Some((host, container.to_string()))
}

/// Host directory that persists an agent's login + sessions + MCP config
/// ACROSS every Docker task of that agent. The sameness of this path
/// IS the cross-task sharing. termic-owned, never the host's real
/// `~/.claude` (full isolation from the OS agent).
pub fn agent_config_host_dir(agent_id: &str) -> PathBuf {
    // `data_dir()` already respects the dev/prod (`termic_dev`/`termic`)
    // split, so dev and release don't share login state.
    let base = data_dir()
        .map(|d| d.join("docker-agents"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker-agents"));
    base.join(agent_id)
}

// ──────────────────────────── build_spec ───────────────────────────────

/// Build the full `DockerSpec` for a task agent spawn. `cmd`/`args`
/// are the agent argv (unchanged from the Seatbelt path); `cwd` is the
/// host working dir (mounted + `-w` at the identical absolute path).
pub fn build_spec(
    task: &Task,
    agent_id: &str,
    image: &str,
    cwd: &str,
    extra_args: Vec<String>,
    spawn_env: &std::collections::HashMap<String, String>,
    agent_extra_dirs: &[String],
    agent_persist_enabled: bool,
    // The task's LIVE sandbox allow-list (`live_sandbox_lists` in
    // lib.rs: global Settings defaults + the task's own pinned paths +
    // the project's `.termic.yaml`, re-read fresh on every spawn) - the
    // exact same list Seatbelt's `sandbox::provision` reads. Docker mode
    // used to ignore this entirely, so switching a task from Seatbelt to
    // Docker silently dropped every extra allowed directory. Mounted rw
    // at its own resolved absolute path (same convention as the worktree
    // and composition members). `regex:`-prefixed entries are Seatbelt-
    // only (no literal path to mount) and are skipped.
    allowed_paths: &[String],
    // Task-level extra Docker mounts (`Task.docker_extra_mounts`), each
    // `host_path:container_path` - see that field's doc comment for why
    // these are a dedicated list rather than reusing `allowed_paths`.
    // Mainly for persisting something a fresh container otherwise loses on
    // every restart that `agent_config`'s built-in list doesn't cover (an
    // MCP server's own data dir, say).
    extra_mounts: &[String],
    // The PTY id this spawn is for. A task can host SEVERAL agent tabs
    // (TabBar.spawnTab), and each one gets its own container, so the
    // container's `--name` has to be unique per TAB, not per task. Keyed on
    // task id alone, tab B's spawn collided with tab A's live container on
    // `--name` and the pre-spawn label sweep tore A down mid-session
    // (GH #231). The task label below stays task-scoped on purpose: archive
    // and the Docker toggle DO want to reap every container of one task.
    pty_id: &str,
    // The agent whose config SHAPE applies - see `agent_config`. Equal to
    // `agent_id` for everything except a cloned agent.
    base_id: &str,
) -> DockerSpec {
    let mut mounts: Vec<Mount> = Vec::new();

    // 1. The worktree itself, at the SAME absolute path inside the
    //    container (required for the worktree `.git` pointer + session
    //    cwd-key to resolve).
    let task_path = canonicalize_or_keep(&task.path);
    mounts.push(Mount::implicit(
        task_path.clone(),
        task_path.clone(),
        false,
        "your code (the task)",
        true,
    ));

    // 2. Parent `.git` for a worktree (pointer file holds an absolute
    //    path into <parent>/.git/worktrees/<name>). Same-path mount or git
    //    breaks. Reuses the exact Seatbelt logic.
    if let Some(parent_git) = parent_git_dir_for_worktree(&task.path) {
        mounts.push(Mount::implicit(
            parent_git.clone(),
            parent_git,
            false,
            "git metadata, required for worktrees to work",
            true,
        ));
    }

    // 3. Composition members (linked repos in a multi-repo task),
    //    each at its identical absolute path.
    for m in &task.composition {
        if m.path.is_empty() {
            continue;
        }
        let p = canonicalize_or_keep(&m.path);
        if p == task_path {
            continue; // host member == task wrapper, already mounted
        }
        mounts.push(Mount::implicit(
            p.clone(),
            p,
            false,
            "linked repo in this task",
            true,
        ));
        if let Some(parent_git) = parent_git_dir_for_worktree(&m.path) {
            mounts.push(Mount::implicit(
                parent_git.clone(),
                parent_git,
                false,
                "git metadata for a linked repo",
                true,
            ));
        }
    }

    // 3.5. The task's live sandbox allow-list - same source Seatbelt uses
    //    (`live_sandbox_lists`), unified so extra directories configured
    //    per-task, per-project, or via a repo's committed `.termic.yaml`
    //    aren't silently lost when a task runs in Docker instead.
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    for raw in allowed_paths {
        let raw = raw.trim();
        // Seatbelt-only: a regex pattern has no literal path to mount.
        if raw.is_empty() || raw.starts_with("regex:") {
            continue;
        }
        let p = canonicalize_or_keep(&subst_path(raw, &home, &task_path));
        if p.is_empty() || mounts.iter().any(|m| m.host == p) {
            continue;
        }
        // Skip what isn't there. Seatbelt tolerates a stale entry in the
        // allow-list (it is just a rule that never matches), so these lists
        // accumulate paths from long-deleted projects - but `docker run -v`
        // does NOT: one missing host path fails the whole run with an opaque
        // daemon error, which would make EVERY Docker task in that config
        // unlaunchable because of a directory nobody has needed for months.
        if !std::path::Path::new(&p).exists() {
            continue;
        }
        mounts.push(Mount::implicit(
            p.clone(),
            p,
            false,
            "extra allowed directory (from your sandbox config / .termic.yaml)",
            false,
        ));
    }

    // 4. The persistent per-agent config dir (login + sessions + MCP +
    //    customizations), shared across all Docker tasks of this
    //    agent. rw. Plus relocation env if the agent supports it.
    let mut env: Vec<(String, String)> = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        // `render_argv` runs the container as the HOST user's own uid:gid
        // (see its `-u` flag) rather than root, so agents that refuse
        // `--dangerously-skip-permissions` under root (Claude Code) work in
        // Docker mode too. That uid has no matching /etc/passwd entry
        // inside the container, so HOME/USER don't auto-resolve the way
        // they do for root - every agent's config still lives under
        // `/root` (that's what `agent_config`/`agent_config_host_dir`
        // mount into), so HOME is pinned there explicitly rather than
        // moved to a uid-specific home directory.
        ("HOME".to_string(), "/root".to_string()),
        ("USER".to_string(), "agent".to_string()),
    ];
    if let Some(cfg) = agent_config(agent_id, base_id, agent_extra_dirs, agent_persist_enabled) {
        let host_cfg = agent_config_host_dir(agent_id).to_string_lossy().into_owned();
        // Create it OURSELVES, as the app user, before it becomes a `-v`
        // source. A missing bind-mount source is created by the daemon
        // instead, and who owns the result is the daemon's business: Docker
        // Desktop on macOS happens to map it to the host user, which is the
        // only reason this ever worked, while a Linux daemon creates it
        // ROOT-owned. The container runs as the host uid (`--user`), so a
        // root-owned config dir means the agent cannot write its own login or
        // transcripts into it - EACCES, and a login that never persists.
        let _ = std::fs::create_dir_all(&host_cfg);
        mounts.push(Mount::implicit(
            host_cfg.clone(),
            cfg.container_dir.clone(),
            false,
            "your Docker agent: login, MCP servers, settings, history (shared across all your Docker tasks)",
            false,
        ));
        for extra in &cfg.extra_dirs {
            // Extra dirs share the same host config dir subtree by name.
            //
            // Strip `/root/` (the container prefix), NOT `/root/.`. With the
            // dot in the pattern, an entry that does not begin with one -
            // `config/mytool`, which `sanitize_extra_dir` accepts - matched
            // nothing, so the "relative" name stayed `/root/config/mytool`,
            // and `Path::join` with an ABSOLUTE argument discards the base:
            // the host side silently became `/root/config/mytool` instead of
            // a path inside termic's own agent folder. On macOS that fails
            // the run outright; on Linux it bind-mounts a root-owned path.
            //
            // The separate leading-dot strip keeps the host layout it has
            // always had (`.antigravity` -> `<agent>/antigravity`), so this
            // fix does not orphan anyone's existing state.
            let rel = extra.strip_prefix("/root/").unwrap_or(extra);
            let rel = rel.strip_prefix('.').unwrap_or(rel);
            let sub = PathBuf::from(&host_cfg)
                .join(rel)
                .to_string_lossy()
                .into_owned();
            // Same reasoning as the config dir above: ours to create, not
            // the daemon's.
            let _ = std::fs::create_dir_all(&sub);
            mounts.push(Mount::implicit(
                sub,
                extra.clone(),
                false,
                "additional config dir for this agent",
                false,
            ));
        }
        if let Some(var) = cfg.relocation_env {
            env.push((var.to_string(), cfg.container_dir.clone()));
        }
    }

    // 5. Task-level extra Docker mounts (Settings → Docker Sandbox has the
    //    per-AGENT equivalent; this is per-TASK, user-chosen host:container
    //    pairs). Runs LAST among the mount steps so it can dedupe against
    //    every mount already staged above, including the agent config dir
    //    step just above - a mount whose CONTAINER path collides with an
    //    already-claimed one is dropped rather than silently shadowing it.
    for raw in extra_mounts {
        let Some((host, container)) = sanitize_extra_mount(raw, &home, &task_path) else { continue };
        if mounts.iter().any(|m| m.host == host || m.container == container) {
            continue;
        }
        mounts.push(Mount::implicit(
            host,
            container,
            false,
            "extra mount for this task (persists across container restarts)",
            false,
        ));
    }

    // Per-spawn env overlay: TERMIC_* bookkeeping vars, the extra named
    // ports, and (this is the part that used to be silently dropped) the
    // agent's own configured env block from Settings -> Agents & Terminals
    // (`envForCli`, TerminalPane.tsx). The Seatbelt/unsandboxed spawn path
    // gets this exact same map via `cmd.env`; Docker mode was only ever
    // getting TERM/COLORTERM/relocation_env above, so a user's per-agent
    // env vars silently never reached the container. Appended LAST so it
    // wins on key collision, same precedence as the unsandboxed path -
    // last `-e KEY=VAL` for a given key wins with `docker run`. Deliberately
    // NOT the raw host env (unlike the unsandboxed path): Docker's own
    // isolation model relies on the mounted config dir for credentials
    // instead of inherited secrets, and this keeps that boundary intact.
    for (k, v) in spawn_env {
        env.push((k.clone(), v.clone()));
    }

    DockerSpec {
        // task id keeps the name recognisable in `docker ps`; the pty id
        // makes it unique per tab. Both are uuids, so the result is always
        // a legal container name.
        container_name: format!("termic-{}-{}", task.id, short_id(pty_id)),
        label: format!("{LABEL_KEY}={}", task.id),
        image: image.to_string(),
        mounts,
        workdir: canonicalize_or_keep(cwd),
        env,
        extra_args,
    }
}

/// Flag prefixes that would let a task's own `docker_extra_args` widen or
/// disable the cage the container is supposed to provide (root-equivalent
/// capabilities, host networking/PID/IPC namespaces, arbitrary extra bind
/// mounts, or swapping the entrypoint/user). Checked case-insensitively
/// against each argument on its own — these are argv elements, not a shell
/// string, so there's no injection risk, just a policy gate on which
/// `docker run` flags a task is allowed to add for itself.
const UNSAFE_EXTRA_ARG_PREFIXES: &[&str] = &[
    "--privileged",
    "--cap-add",
    "--network",
    "--net",
    "--pid",
    "--ipc",
    "--uts",
    "--userns",
    "--security-opt",
    "--device",
    "--volume",
    "-v",
    "--mount",
    "--entrypoint",
    "--user",
    "-u",
    "--cap-drop",
    "--pids-limit",
    // Siblings of flags already listed, and just as capable of widening the
    // boundary: `--volumes-from` mounts another container's volumes wholesale
    // (the `-v`/`--mount` hole through a different door), and
    // `--device-cgroup-rule` grants device access the way `--device` does.
    "--volumes-from",
    "--device-cgroup-rule",
];

/// Reject any `docker_extra_args` entry that could weaken the container
/// boundary `render_argv` builds. Returns the offending argument in the
/// error so the caller (`task_set_docker`) can surface it to the user.
pub fn validate_extra_args(args: &[String]) -> Result<(), String> {
    for a in args {
        let lower = a.to_ascii_lowercase();
        let flag = lower.split('=').next().unwrap_or(&lower);
        if UNSAFE_EXTRA_ARG_PREFIXES.iter().any(|p| flag == *p) {
            return Err(format!(
                "\"{a}\" isn't allowed in Docker extra args: it can widen or disable the container's isolation boundary."
            ));
        }
    }
    Ok(())
}

/// Command-level syntax check for `Task.docker_extra_mounts` entries, run at
/// save time (`task_set_docker`) so a malformed entry surfaces as an error to
/// the user instead of being silently dropped at spawn time the way
/// `sanitize_extra_mount` drops bad entries. Checks the same shape rules
/// `sanitize_extra_mount` enforces on the container half, without resolving
/// `$HOME`/`$WORKSPACE`/symlinks on the host half - those are always valid
/// at save time regardless of which task's path they'll later be resolved
/// against, so only the fully task-agnostic checks run here.
pub fn validate_extra_mounts(mounts: &[String]) -> Result<(), String> {
    for raw in mounts {
        let raw_t = raw.trim();
        let Some((host_raw, container_raw)) = raw_t.split_once(':') else {
            return Err(format!("\"{raw}\" isn't a valid mount: expected host_path:container_path."));
        };
        let host_raw = host_raw.trim();
        let container_raw = container_raw.trim();
        if host_raw.is_empty() || container_raw.is_empty() {
            return Err(format!("\"{raw}\" isn't a valid mount: both the host and container path are required."));
        }
        if !container_raw.starts_with('/') || container_raw.contains("..") || container_raw.contains('\0') {
            return Err(format!("\"{raw}\" isn't a valid mount: the container path must be an absolute path with no \"..\"."));
        }
        let container = container_raw.trim_end_matches('/');
        if container.is_empty()
            || UNSAFE_MOUNT_TARGET_ROOTS.iter().any(|root| container == *root || container.starts_with(&format!("{root}/")))
        {
            return Err(format!(
                "\"{raw}\" isn't allowed: {container} is reserved for the container's own config/system files."
            ));
        }
    }
    Ok(())
}

/// The `docker run --user` value: the HOST process's own uid:gid, so the
/// container's file access matches the host user that already owns every
/// bind-mounted path (worktree, agent config dir). `getuid`/`getgid` are
/// unix-only in `libc` (Windows has no uid concept); Docker sandbox mode is
/// currently exercised on macOS/Linux hosts only, so a Windows build falls
/// back to `0:0` (root) rather than failing to compile - this flag has no
/// meaning there yet.
#[cfg(unix)]
fn host_uid_gid() -> String {
    format!("{}:{}", unsafe { libc::getuid() }, unsafe { libc::getgid() })
}

#[cfg(not(unix))]
fn host_uid_gid() -> String {
    "0:0".to_string()
}

// ──────────────────────────── render_argv ──────────────────────────────

/// Render the spec to the exact argv we spawn. THE single source of truth:
/// the UI preview is just this output pretty-printed (see `render_preview`).
/// Spawned argv == previewed argv, always.
pub fn render_argv(spec: &DockerSpec, cmd: &str, args: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "-i".into(),
        "-t".into(),
        "--name".into(),
        spec.container_name.clone(),
        "--label".into(),
        spec.label.clone(),
    ];
    for m in &spec.mounts {
        argv.push("-v".into());
        let suffix = if m.read_only { ":ro" } else { "" };
        argv.push(format!("{}:{}{}", m.host, m.container, suffix));
    }
    argv.push("-w".into());
    argv.push(spec.workdir.clone());
    for (k, v) in &spec.env {
        argv.push("-e".into());
        argv.push(format!("{k}={v}"));
    }
    // Harden the container itself: no Linux capabilities beyond the
    // agent's baseline needs, no privilege escalation via setuid
    // binaries, and a cap on forkbomb-style PID exhaustion. This is
    // orthogonal to the (currently unrestricted) network egress — see
    // the "Known gap" callout in docs/sandbox.md — but it meaningfully
    // narrows what a container-escape exploit can reach even so.
    argv.push("--cap-drop".into());
    argv.push("ALL".into());
    argv.push("--security-opt".into());
    argv.push("no-new-privileges:true".into());
    argv.push("--pids-limit".into());
    argv.push("512".into());
    // Run as the HOST user's own uid:gid, not root. Two reasons: (1) Claude
    // Code (and presumably others) refuse `--dangerously-skip-permissions`
    // under root, which broke every YOLO-auto-on Docker task; (2) the
    // worktree/git-metadata/agent-config-dir mounts are all bind-mounted
    // from paths this same host user already owns, so matching uid:gid
    // exactly means the container sees the identical ownership/permissions
    // the host process already has - no chown, no `--user`-vs-bind-mount
    // guessing. `Dockerfile.default` world-permissions `/root` (where every
    // agent's config/binaries live, `HOME` above) at build time so an
    // arbitrary runtime uid with no matching `/etc/passwd` entry can still
    // read/write it. `-u`/`--user` is in `UNSAFE_EXTRA_ARG_PREFIXES` so a
    // task can never override this from `docker_extra_args`.
    argv.push("--user".into());
    argv.push(host_uid_gid());
    argv.extend(spec.extra_args.iter().cloned());
    argv.push(spec.image.clone());
    argv.push(cmd.to_string());
    argv.extend(args.iter().cloned());
    argv
}

// ─────────────────────── Dockerfile storage ────────────────────────────

/// Directory holding the editable Dockerfile + build metadata.
fn docker_dir() -> PathBuf {
    data_dir()
        .map(|d| d.join("docker"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker"))
}

/// Path to the user-editable Dockerfile (one generic file, all agents).
pub fn dockerfile_path() -> PathBuf {
    docker_dir().join("Dockerfile")
}

/// The shipped default Dockerfile (validated: builds + runs all agents).
/// Ship this as reset-to-default; the commented regions are the user's
/// customization surface.
pub const DEFAULT_DOCKERFILE: &str = include_str!("../assets/Dockerfile.default");

/// Read the current Dockerfile, falling back to (and persisting) the
/// shipped default on first run / missing file.
pub fn read_dockerfile() -> String {
    let path = dockerfile_path();
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            let _ = write_dockerfile(DEFAULT_DOCKERFILE);
            DEFAULT_DOCKERFILE.to_string()
        }
    }
}

/// Persist an edited Dockerfile.
pub fn write_dockerfile(contents: &str) -> Result<(), String> {
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("Dockerfile"), contents).map_err(|e| e.to_string())
}

// ──────────────────────────── Image build ──────────────────────────────

/// Construct the `docker build` Command + the tag it will produce, writing
/// the Dockerfile to disk first. The caller drives execution (the command
/// layer streams its output line-by-line off a background thread; never on
/// the synchronous Tauri path). `no_cache` => `--no-cache --pull`.
pub fn build_command(dockerfile: &str, no_cache: bool) -> Result<(Command, String), String> {
    let tag = image_tag(dockerfile);
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let df_path = dir.join("Dockerfile");
    std::fs::write(&df_path, dockerfile).map_err(|e| e.to_string())?;

    let mut cmd = Command::new("docker");
    // --progress=plain so the streamed log is line-based (not a TTY redraw).
    cmd.args(["build", "--progress=plain", "-t", &tag, "-f"]);
    cmd.arg(&df_path);
    if no_cache {
        cmd.args(["--no-cache", "--pull"]);
    }
    // Build context is the docker dir (lets users `COPY` baked skills etc.
    // from a path they control next to the Dockerfile).
    cmd.arg(&dir);
    Ok((cmd, tag))
}

// ─────────────────────── Image tag + availability ──────────────────────

/// Content-addressed image tag: `termic-sandbox:{hash}`. Editing the
/// Dockerfile changes the hash, so a stale build no longer matches —
/// surfaced as a "rebuild to apply" warning in Settings. DefaultHasher is
/// fixed-seed (stable across runs); a non-crypto hash is sufficient for
/// cache-keying (we only need "did the Dockerfile change?").
pub fn image_tag(dockerfile: &str) -> String {
    let mut h = DefaultHasher::new();
    dockerfile.hash(&mut h);
    format!("{IMAGE_REPO}:{:016x}", h.finish())
}

/// Result of `docker_check`: is the binary present, is the daemon up?
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DockerStatus {
    /// `docker` binary resolvable on PATH.
    pub binary: bool,
    /// `docker info` succeeds (daemon reachable).
    pub daemon: bool,
    /// `docker --version` string, when available.
    pub version: Option<String>,
}

/// Probe for the `docker` binary + a running daemon. Cheap; no build.
pub fn check() -> DockerStatus {
    let version = Command::new("docker")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let binary = version.is_some();
    let daemon = binary
        && Command::new("docker")
            .arg("info")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    DockerStatus { binary, daemon, version }
}

/// Does an image with this tag already exist locally? (Drives dropdown
/// availability + the "not built / rebuild" Settings state.)
pub fn image_exists(tag: &str) -> bool {
    Command::new("docker")
        .args(["image", "inspect", tag])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// File recording the tag of the last successful build. Lets us keep the
/// last-built image available in the dropdown even after the Dockerfile is
/// edited (the edit only takes effect on the next build).
fn last_built_file() -> PathBuf {
    docker_dir().join("last_built_tag")
}

/// File recording the LOCAL calendar date of the last successful build
/// (`YYYY-MM-DD`), independent of which tag it was. Drives the daily-rebuild
/// nudge: an agent CLI publishes new releases continuously, so an image
/// built yesterday can already be running a stale binary even though its
/// Dockerfile (and therefore its content-addressed tag) hasn't changed.
fn last_built_date_file() -> PathBuf {
    docker_dir().join("last_built_date")
}

/// Record a successfully built tag, and today's date as the build date.
pub fn record_built_tag(tag: &str) {
    let _ = std::fs::create_dir_all(docker_dir());
    let _ = std::fs::write(last_built_file(), tag);
    let _ = std::fs::write(last_built_date_file(), chrono::Local::now().date_naive().to_string());
}

/// The tag of the last successful build, if any.
pub fn last_built_tag() -> Option<String> {
    std::fs::read_to_string(last_built_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parse a recorded build-date string (`YYYY-MM-DD`, possibly with
/// trailing whitespace from the file write). Split out from `last_built_date`
/// so the format is unit-testable without touching the filesystem.
fn parse_build_date(s: &str) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

/// LOCAL calendar date (`YYYY-MM-DD`) any image was last successfully
/// built, if ever / parsable. Whether that counts as "due for a rebuild"
/// is a policy call (depends on `Settings.docker_rebuild_frequency`, which
/// this module knows nothing about) - left to the frontend, which prompts
/// the user rather than silently rebuilding. `None` covers both "never
/// built" (which `spawn_image_tag`'s own refusal already handles) and
/// "recorded but unparsable" (a version upgrade edge case, not a normal
/// path) identically - the caller should treat either as "definitely due".
pub fn last_built_date() -> Option<String> {
    std::fs::read_to_string(last_built_date_file())
        .ok()
        .and_then(|s| parse_build_date(&s))
        .map(|d| d.to_string())
}

/// Image state for the Settings Docker section + dropdown gating.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DockerImageStatus {
    /// Content tag of the CURRENT (possibly-edited) Dockerfile.
    pub current_tag: String,
    /// Is the current Dockerfile's image built?
    pub current_built: bool,
    /// Tag of the last successful build (may differ from current_tag).
    pub last_built_tag: Option<String>,
    /// Does the last-built image still exist locally?
    pub last_built_exists: bool,
    /// Dockerfile edited since the last successful build (built image is
    /// stale). Drives the "rebuild to apply" warning in Settings.
    pub stale: bool,
    /// Is the current Dockerfile byte-identical to the shipped default?
    pub is_default: bool,
    /// Whether Docker mode should be offered in the task dropdown at
    /// all (a usable built image exists).
    pub available: bool,
    /// LOCAL calendar date (`YYYY-MM-DD`) of the last successful build, if
    /// any. Drives the rebuild-frequency nudge before an agent launch - see
    /// `Settings::docker_rebuild_frequency`.
    pub last_built_date: Option<String>,
}

/// Compute the current image status from the on-disk Dockerfile + docker.
pub fn image_status() -> DockerImageStatus {
    let dockerfile = read_dockerfile();
    let current_tag = image_tag(&dockerfile);
    let current_built = image_exists(&current_tag);
    let last = last_built_tag();
    let last_built_exists = last.as_deref().map(image_exists).unwrap_or(false);
    let stale = match &last {
        Some(t) => last_built_exists && *t != current_tag,
        None => false,
    };
    DockerImageStatus {
        current_tag,
        current_built,
        is_default: dockerfile == DEFAULT_DOCKERFILE,
        // Dropdown availability: any usable built image (current OR the
        // last-built one we keep around after an edit).
        available: current_built || last_built_exists,
        last_built_tag: last,
        last_built_exists,
        stale,
        last_built_date: last_built_date(),
    }
}

/// The tag a spawn should actually run: prefer the current Dockerfile's
/// image; fall back to the last-built image (kept available after an edit).
/// `None` => nothing usable is built; the spawn must refuse.
pub fn spawn_image_tag() -> Option<String> {
    let dockerfile = read_dockerfile();
    let current = image_tag(&dockerfile);
    if image_exists(&current) {
        return Some(current);
    }
    last_built_tag().filter(|t| image_exists(t))
}

// ──────────────────────────── Cleanup ──────────────────────────────────

/// `docker rm -f` every container labeled for this task. Non-fatal.
pub fn cleanup_task(task_id: &str) {
    rm_by_filter(&format!("label={LABEL_KEY}={task_id}"));
}

/// First 8 chars of an id, for a readable-but-unique container name.
/// Falls back to the whole string when it is shorter than that.
fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// `docker rm -f` every termic-labeled container (app quit). Non-fatal.
pub fn cleanup_all() {
    rm_by_filter(&format!("label={LABEL_KEY}"));
}

fn rm_by_filter(filter: &str) {
    let ids = Command::new("docker")
        .args(["ps", "-aq", "--filter", filter])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    for id in ids.lines().filter(|l| !l.trim().is_empty()) {
        let _ = Command::new("docker").args(["rm", "-f", id]).output();
    }
}

// ────────────────────── Activity monitor integration ──────────────────────
//
// The host pid tree procmon.rs walks is close to meaningless for a
// Docker-sandboxed agent: the pid it finds is the `docker run` client, which
// sits nearly idle no matter how busy the agent is, because the real work
// happens inside the daemon's VM, a process table the host cannot see into.
// So `merge_stats` runs AFTER a normal sample, replacing every row whose
// root carried a `docker_container` name with numbers from `docker stats`
// instead — one batched invocation for however many Docker tasks are live,
// not one per row.

use crate::procmon::{ProcRow, Snapshot};
use parking_lot::Mutex;
use std::collections::HashMap;

/// One container's live usage, as `docker stats --no-stream` reports it.
struct ContainerStats {
    cpu_pct: f64,
    mem_bytes: u64,
    pids: u32,
}

/// cpu_pct history per row key, kept here because by the time `merge_stats`
/// sees a snapshot, procmon.rs's own sampler already built (and baked into
/// the row) a history using the wrong host-based numbers — this is the only
/// place that ever computes the right ones. Mirrors procmon.rs's `hist` but
/// scoped to Docker rows only. Cleared by `reset_history`, which lib.rs
/// calls alongside every `procmon::start`/`stop`/`stop_all`, so it costs
/// nothing while the Activity window is closed (same rule procmon.rs's
/// module doc holds itself to).
static HISTORY: std::sync::LazyLock<Mutex<HashMap<String, Vec<f64>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Matches procmon.rs's own `HISTORY_LEN`; the sparklines are drawn from the
/// same session length regardless of which rows are Docker rows.
const HISTORY_LEN: usize = 90;

/// Forget every row's sparkline history. Call whenever a procmon session
/// starts or ends, so a closed-then-reopened Activity window (or a
/// long-since-exited Docker task) cannot leave rows behind forever.
pub fn reset_history() {
    HISTORY.lock().clear();
}

/// Overwrite every Docker row in `snap` with a fresh `docker stats` query.
/// `containers` maps a `Snapshot` row's `key` to its container `--name`,
/// built by lib.rs from the same `PtySlot`s the row itself came from.
/// Rows with no entry in `containers` (every non-Docker row) pass through
/// untouched. Blocking (shells out to `docker`) — callers MUST run this off
/// the IPC thread, same discipline as any other Docker command.
pub fn merge_stats(mut snap: Snapshot, containers: &HashMap<String, String>) -> Snapshot {
    if containers.is_empty() {
        return snap;
    }
    let names: Vec<String> = containers.values().cloned().collect();
    let stats = query_stats(&names);
    let mut hist = HISTORY.lock();
    for row in &mut snap.rows {
        let Some(name) = containers.get(&row.key) else { continue };
        apply(row, stats.get(name), &mut hist, HISTORY_LEN);
    }
    // Drop history for rows this snapshot no longer carries (task closed,
    // agent exited) — otherwise a long session accumulates one entry per
    // Docker PTY that ever existed.
    let live: std::collections::HashSet<&String> = containers.keys().collect();
    hist.retain(|k, _| live.contains(k));
    snap
}

fn apply(
    row: &mut ProcRow,
    stats: Option<&ContainerStats>,
    hist: &mut HashMap<String, Vec<f64>>,
    cap: usize,
) {
    row.is_docker = true;
    // A container's real process tree lives in the daemon's VM; the host
    // children we sampled are just the `docker` CLI itself, so showing them
    // would read as "the agent spawned nothing" every time.
    row.children.clear();
    let Some(s) = stats else {
        // Transient miss (container starting up, or `docker stats` failed) —
        // keep last known numbers rather than flashing the row to zero.
        return;
    };
    row.cpu_pct = Some(s.cpu_pct);
    row.mem_bytes = s.mem_bytes;
    row.rss_bytes = s.mem_bytes;
    row.proc_count = s.pids;
    row.alive = true;
    let h = hist.entry(row.key.clone()).or_default();
    h.push(s.cpu_pct);
    if h.len() > cap {
        let drop = h.len() - cap;
        h.drain(0..drop);
    }
    row.cpu_history = h.clone();
}

/// One `docker stats` invocation for every named container. Missing/gone
/// containers are silently absent from the result — an agent that exited
/// between the PTY snapshot and this call is not an error for the others.
fn query_stats(names: &[String]) -> HashMap<String, ContainerStats> {
    if names.is_empty() {
        return HashMap::new();
    }
    let out = Command::new("docker")
        .arg("stats")
        .arg("--no-stream")
        .arg("--format")
        .arg("{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}")
        .args(names)
        .output();
    let Ok(out) = out else { return HashMap::new() };
    if !out.status.success() {
        return HashMap::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_stats_line)
        .collect()
}

fn parse_stats_line(line: &str) -> Option<(String, ContainerStats)> {
    let mut cols = line.split('\t');
    let name = cols.next()?.trim().to_string();
    let cpu_pct = cols.next()?.trim().trim_end_matches('%').parse::<f64>().ok()?;
    let mem_bytes = parse_mem_usage(cols.next()?.trim())?;
    let pids = cols.next()?.trim().parse::<u32>().unwrap_or(0);
    Some((name, ContainerStats { cpu_pct, mem_bytes, pids }))
}

/// `docker stats`' MemUsage column reads like "12.3MiB / 1.943GiB" — the
/// used half, before the slash, is what we want; the limit half is dropped
/// since the row already has its own "of what" context in the UI.
fn parse_mem_usage(s: &str) -> Option<u64> {
    parse_byte_size(s.split('/').next()?.trim())
}

fn parse_byte_size(s: &str) -> Option<u64> {
    let split = s.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult = match unit.trim() {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0_f64.powi(4),
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        _ => return None,
    };
    Some((n * mult) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_args_rejects_cage_widening_flags() {
        for bad in [
            "--privileged",
            "--cap-add=ALL",
            "--network=host",
            "--net=host",
            "--pid=host",
            "-v",
            "--volume",
            "--mount",
            "--entrypoint",
            "--user=root",
            "-u",
        ] {
            let err = validate_extra_args(&[bad.to_string()]);
            assert!(err.is_err(), "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn extra_args_rejects_case_insensitively() {
        assert!(validate_extra_args(&["--Privileged".to_string()]).is_err());
    }

    #[test]
    fn extra_args_allows_benign_flags() {
        for ok in ["--memory", "4g", "--cpus=2", "--label=foo=bar"] {
            assert!(validate_extra_args(&[ok.to_string()]).is_ok(), "expected {ok:?} to be allowed");
        }
    }

    #[test]
    fn extra_args_checks_every_element() {
        let args = vec!["--memory".to_string(), "4g".to_string(), "--privileged".to_string()];
        assert!(validate_extra_args(&args).is_err());
    }

    #[test]
    fn parse_build_date_accepts_iso_date() {
        let d = parse_build_date("2026-08-19").expect("should parse");
        assert_eq!(d.to_string(), "2026-08-19");
    }

    #[test]
    fn parse_build_date_trims_whitespace() {
        assert!(parse_build_date("2026-08-19\n").is_some());
        assert!(parse_build_date("  2026-08-19  ").is_some());
    }

    #[test]
    fn parse_build_date_rejects_garbage() {
        for bad in ["", "not-a-date", "2026/08/19", "08-19-2026"] {
            assert!(parse_build_date(bad).is_none(), "expected {bad:?} to fail to parse");
        }
    }

    fn stub_task(id: &str, path: &str) -> Task {
        Task { id: id.to_string(), path: path.to_string(), ..Task::default() }
    }

    /// An Agent carrying only the two fields `base_agent_id` reads.
    fn stub_agent(id: &str, extends: Option<&str>) -> crate::Agent {
        let mut a = crate::default_agents().into_iter().next().unwrap();
        a.id = id.to_string();
        a.extends = extends.map(|s| s.to_string());
        a
    }

    #[test]
    fn a_cloned_agent_inherits_its_base_shape_but_keeps_its_own_folder() {
        // The whole point of cloning claude is a SEPARATE login (work vs
        // personal), which means: same config shape, different storage.
        // Resolving the shape on the clone's own id fell through to the
        // unknown-agent path - nothing mounted, no CLAUDE_CONFIG_DIR - so the
        // agent wrote its login to /root inside the container, where it both
        // vanishes on exit and is not writable by the non-root container user.
        let agents = vec![
            stub_agent("claude", None),
            stub_agent("next-claude", Some("claude")),
        ];
        assert_eq!(base_agent_id(&agents, "next-claude"), "claude");
        assert_eq!(base_agent_id(&agents, "claude"), "claude");
        // An agent that extends nothing, and one nobody has heard of.
        assert_eq!(base_agent_id(&agents, "stranger"), "stranger");

        let task = stub_task("t-clone", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "next-claude", "img", &task.path, vec![], &env, &[], false,
            &[], &[], "pty-clone0001", "claude");

        // claude's shape: the config dir is mounted and relocated onto it, so
        // `.claude.json` (which lives at HOME root until relocated) is inside
        // the mount rather than in the throwaway layer.
        assert!(spec.mounts.iter().any(|m| m.container == "/root/.claude"),
            "a claude clone must get claude's config dir mounted");
        assert!(spec.env.iter().any(|(k, v)| k == "CLAUDE_CONFIG_DIR" && v == "/root/.claude"),
            "without the relocation var the login lands outside the mount");

        // ...but stored under the CLONE's own id, which is what keeps the two
        // logins apart. Mounting claude's own folder here would defeat the
        // reason the clone exists.
        let cfg_mount = spec.mounts.iter().find(|m| m.container == "/root/.claude").unwrap();
        assert!(cfg_mount.host.ends_with("docker-agents/next-claude"), "{}", cfg_mount.host);
    }

    #[test]
    fn the_agent_config_host_dir_exists_before_it_becomes_a_mount() {
        // A missing `-v` source is created by the DAEMON, and its ownership
        // is the daemon's business: Docker Desktop on macOS maps it to the
        // host user (which is the only reason this ever worked), a Linux
        // daemon creates it root-owned. The container runs as the host uid,
        // so a root-owned config dir means the agent cannot write its login
        // or its transcripts: EACCES, and a login that never sticks.
        let task = stub_task("t-mk", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false,
            &[], &[], "pty-mkdir0001", "claude");
        let cfg = spec.mounts.iter().find(|m| m.container == "/root/.claude").unwrap();
        assert!(std::path::Path::new(&cfg.host).is_dir(),
            "host config dir must exist before docker sees it: {}", cfg.host);
    }

    #[test]
    fn a_clone_of_grok_stays_excluded() {
        // grok's exclusion is about its layout (binary inside its config
        // dir), so it has to follow the clone rather than the id.
        let agents = vec![stub_agent("grok", None), stub_agent("my-grok", Some("grok"))];
        assert_eq!(base_agent_id(&agents, "my-grok"), "grok");
        assert!(agent_config("my-grok", "grok", &[".grok".to_string()], true).is_none());
    }

    #[test]
    fn base_agent_id_survives_a_cycle() {
        // Hand-edited settings could point two agents at each other; the
        // resolver must not spin.
        let agents = vec![stub_agent("a", Some("b")), stub_agent("b", Some("a"))];
        let _ = base_agent_id(&agents, "a");
    }

    #[test]
    fn pi_persists_its_config_and_does_not_repeat_groks_mistake() {
        // pi keeps settings.json + trust.json under ~/.pi/agent/, so `.pi` is
        // the config dir. It qualifies for persistence ONLY because the image
        // installs it from npm (binary in the global prefix, outside HOME).
        // pi's own install.sh can drop the binary in ~/.pi/agent/bin, which
        // is precisely why grok is excluded - mounting a config dir over the
        // binary's own directory shadows the binary.
        assert!(KNOWN_SAFE_AGENTS.contains(&"pi"));
        assert_eq!(crate::agent_dirs::state_dirs("pi"), &[".pi"]);

        let task = stub_task("t-pi", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "pi", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-pi000001", "pi");
        assert!(spec.mounts.iter().any(|m| m.container == "/root/.pi"),
            "pi's config dir must be mounted, or every Docker launch re-authenticates");
        // No relocation env var is claimed for pi: the docs describe no
        // single variable that moves the whole config dir (only the session
        // dir), so the mount IS the mechanism.
        assert!(!spec.env.iter().any(|(k, _)| k.starts_with("PI_")),
            "no PI_* var should be invented here without one in pi's docs");

        // grok stays excluded, deliberately.
        assert!(!KNOWN_SAFE_AGENTS.contains(&"grok"));
        assert!(!persist_offerable("grok"));
    }

    #[test]
    fn build_spec_names_the_container_per_pty_not_per_task() {
        // A task can host several agent tabs, each with its own container.
        // Keyed on task id alone, tab B's `--name` collided with tab A's live
        // container, and the task-scoped label sweep on spawn tore A down
        // mid-session (GH #231). The LABEL stays task-scoped on purpose:
        // archive and the Docker toggle do want to reap the whole task.
        let task = stub_task("task-1", "/tmp/termic-docker-test-does-not-exist");
        let env = std::collections::HashMap::new();
        let a = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "aaaaaaaa-1111-2222-3333-444444444444", "claude");
        let b = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "bbbbbbbb-1111-2222-3333-444444444444", "claude");
        assert_ne!(a.container_name, b.container_name,
            "two tabs of one task must not share a container name");
        assert!(a.container_name.starts_with("termic-task-1-"));
        assert_eq!(a.label, b.label, "the task label is shared, so archive reaps both");
        assert_eq!(a.label, "termic.task=task-1");
    }

    #[test]
    fn short_id_is_safe_for_ids_shorter_than_the_cut() {
        assert_eq!(short_id("aaaaaaaa-bbbb"), "aaaaaaaa");
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id(""), "");
    }

    #[test]
    fn build_spec_forwards_the_per_spawn_env_overlay() {
        // The per-agent env block from Settings -> Agents & Terminals
        // (envForCli) rides in as SpawnArgs.env, same as the Seatbelt path.
        // It used to be dropped entirely for Docker mode - only TERM /
        // COLORTERM / the agent's relocation var ever reached the container.
        let task = stub_task("t1", "/tmp/termic-docker-test-does-not-exist");
        let mut spawn_env = std::collections::HashMap::new();
        spawn_env.insert("MY_CUSTOM_VAR".to_string(), "hello".to_string());
        let spec = build_spec(&task, "claude", "termic-sandbox:abc", &task.path, vec![], &spawn_env, &[], false, &[], &[], "pty-aaaa1111", "claude");
        assert!(spec.env.iter().any(|(k, v)| k == "MY_CUSTOM_VAR" && v == "hello"));
        assert!(spec.env.iter().any(|(k, _)| k == "TERM"));
    }

    #[test]
    fn build_spec_overlay_wins_on_key_collision() {
        // Appended AFTER the base TERM/COLORTERM, matching `docker run`'s
        // own last-`-e`-wins semantics for a duplicate key - and matching
        // the Seatbelt/unsandboxed path's "per-agent env wins" precedence.
        let task = stub_task("t2", "/tmp/termic-docker-test-does-not-exist-2");
        let mut spawn_env = std::collections::HashMap::new();
        spawn_env.insert("TERM".to_string(), "dumb".to_string());
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &spawn_env, &[], false, &[], &[], "pty-aaaa1111", "claude");
        let term_values: Vec<&str> = spec.env.iter().filter(|(k, _)| k == "TERM").map(|(_, v)| v.as_str()).collect();
        assert_eq!(term_values, vec!["xterm-256color", "dumb"]);
    }

    /// `agent_config()` now derives its mount paths from
    /// `agent_dirs::state_dirs` instead of its own hardcoded table
    /// (dedup with Seatbelt's default allow-list, see agent_dirs.rs's
    /// module doc). Pins the exact container paths + relocation env
    /// every agent produced before that refactor, so a future edit to
    /// the shared table can't silently change what actually gets
    /// mounted into a running container.
    #[test]
    fn agent_config_mounts_match_the_pre_dedup_paths() {
        let task = stub_task("t3", "/tmp/termic-docker-test-does-not-exist-3");
        let env = std::collections::HashMap::new();
        let cases: &[(&str, &str, &[&str])] = &[
            ("claude", "/root/.claude", &[]),
            ("codex", "/root/.codex", &[]),
            ("copilot", "/root/.copilot", &[]),
            ("agy", "/root/.gemini", &["/root/.antigravity"]),
            ("opencode", "/root/.config/opencode", &["/root/.local/share/opencode"]),
        ];
        for (agent, primary, extras) in cases {
            let spec = build_spec(&task, agent, "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", agent);
            let mounted: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
            assert!(mounted.contains(primary), "{agent}: expected {primary} in {mounted:?}");
            for e in *extras {
                assert!(mounted.contains(e), "{agent}: expected {e} in {mounted:?}");
            }
        }
        // grok stays unsupported in Docker mode regardless of what
        // agent_dirs lists for Seatbelt's sake.
        let grok_spec = build_spec(&task, "grok", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", "grok");
        assert!(!grok_spec.mounts.iter().any(|m| m.container.contains("grok")));
    }

    #[test]
    fn relocation_env_value_always_matches_the_container_dir() {
        let task = stub_task("t4", "/tmp/termic-docker-test-does-not-exist-4");
        let env = std::collections::HashMap::new();
        for (agent, var) in [("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME")] {
            let spec = build_spec(&task, agent, "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", agent);
            let val = spec.env.iter().find(|(k, _)| k == var).map(|(_, v)| v.as_str());
            assert_eq!(val, Some(format!("/root/.{agent}").as_str()));
        }
    }

    #[test]
    fn sanitize_extra_dir_accepts_plain_relative_paths() {
        assert_eq!(sanitize_extra_dir(".mytool"), Some(".mytool".to_string()));
        assert_eq!(sanitize_extra_dir(".config/mytool"), Some(".config/mytool".to_string()));
        assert_eq!(sanitize_extra_dir("./.mytool"), Some(".mytool".to_string()));
        assert_eq!(sanitize_extra_dir("  .mytool  "), Some(".mytool".to_string()));
    }

    #[test]
    fn sanitize_extra_dir_rejects_escapes_and_absolutes() {
        for bad in ["", "   ", "/etc", "../../etc", ".foo/../../etc", "/root/.claude"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn render_argv_runs_as_the_host_uid_gid_with_home_pinned_to_root() {
        // Claude Code (and presumably others) refuse
        // --dangerously-skip-permissions under root - `render_argv` runs
        // the container as the HOST user's own uid:gid instead so YOLO
        // auto-on works in Docker mode too, matching ownership of every
        // bind-mounted path along the way. HOME/USER have to be pinned
        // explicitly since that uid has no /etc/passwd entry in the image.
        let task = stub_task("t13", "/tmp/termic-docker-test-does-not-exist-13");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", "claude");
        let argv = render_argv(&spec, "claude", &[]);
        let user_idx = argv.iter().position(|a| a == "--user").expect("--user flag missing");
        assert_eq!(argv[user_idx + 1], host_uid_gid());
        assert!(spec.env.iter().any(|(k, v)| k == "HOME" && v == "/root"));
        assert!(spec.env.iter().any(|(k, _)| k == "USER"));
    }

    #[test]
    fn sanitize_extra_mount_accepts_a_valid_host_container_pair() {
        let got = sanitize_extra_mount("/tmp/mcp-data:/data/mcp", "/Users/x", "/tmp/task");
        assert_eq!(got, Some(("/tmp/mcp-data".to_string(), "/data/mcp".to_string())));
    }

    #[test]
    fn sanitize_extra_mount_expands_home_and_workspace_on_the_host_half() {
        let got = sanitize_extra_mount("$HOME/mcp-data:/data/mcp", "/Users/x", "/tmp/task");
        assert_eq!(got, Some(("/Users/x/mcp-data".to_string(), "/data/mcp".to_string())));
    }

    #[test]
    fn sanitize_extra_mount_trims_a_trailing_slash_on_the_container_half() {
        let got = sanitize_extra_mount("/tmp/mcp-data:/data/mcp/", "/Users/x", "/tmp/task");
        assert_eq!(got, Some(("/tmp/mcp-data".to_string(), "/data/mcp".to_string())));
    }

    #[test]
    fn sanitize_extra_mount_rejects_malformed_entries() {
        for bad in ["", "no-colon-here", "/only-host:", ":/only-container", "  :  "] {
            assert_eq!(sanitize_extra_mount(bad, "/Users/x", "/tmp/task"), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn sanitize_extra_mount_rejects_a_relative_or_traversing_container_half() {
        for bad in ["/tmp/mcp-data:data/mcp", "/tmp/mcp-data:/data/../etc", "/tmp/mcp-data:/data/mcp\0"] {
            assert_eq!(sanitize_extra_mount(bad, "/Users/x", "/tmp/task"), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn sanitize_extra_mount_rejects_denylisted_container_roots() {
        for root in ["/root", "/root/x", "/etc", "/etc/passwd", "/var", "/dev"] {
            let raw = format!("/tmp/mcp-data:{root}");
            assert_eq!(sanitize_extra_mount(&raw, "/Users/x", "/tmp/task"), None, "expected {root:?} to be rejected");
        }
    }

    #[test]
    fn task_extra_mounts_are_added_and_deduped_by_container_path() {
        let task = stub_task("t11", "/tmp/termic-docker-test-does-not-exist-11");
        let env = std::collections::HashMap::new();
        let extras = vec![
            "/tmp/mcp-data:/data/mcp".to_string(),
            "/tmp/other:/data/mcp".to_string(), // same container path - dropped
            "/etc:/data/unsafe".to_string(),    // denylisted host isn't the point; container is fine, host stays as-is
            "not-an-entry".to_string(),         // malformed - dropped
        ];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-aaaa1111", "claude");
        let containers: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
        assert_eq!(containers.iter().filter(|c| **c == "/data/mcp").count(), 1, "{containers:?}");
        let mcp_mount = spec.mounts.iter().find(|m| m.container == "/data/mcp").unwrap();
        assert_eq!(mcp_mount.host, "/tmp/mcp-data");
    }

    #[test]
    fn task_extra_mounts_cannot_shadow_the_agent_config_dir_mount() {
        let task = stub_task("t12", "/tmp/termic-docker-test-does-not-exist-12");
        let env = std::collections::HashMap::new();
        let extras = vec!["/tmp/whatever:/root/.claude".to_string()];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-aaaa1111", "claude");
        let claude_mounts: Vec<&str> = spec
            .mounts
            .iter()
            .filter(|m| m.container == "/root/.claude")
            .map(|m| m.host.as_str())
            .collect();
        assert_eq!(claude_mounts.len(), 1, "{claude_mounts:?}");
        assert_ne!(claude_mounts[0], "/tmp/whatever");
    }

    #[test]
    fn user_extra_dirs_are_mounted_alongside_the_builtin_ones() {
        // copilot is KNOWN_SAFE_AGENTS - its extras are always mounted
        // regardless of persist_enabled, which only gates non-builtin agents.
        let task = stub_task("t5", "/tmp/termic-docker-test-does-not-exist-5");
        let env = std::collections::HashMap::new();
        let extras = vec![".mytool".to_string(), "../escape".to_string(), "/etc".to_string()];
        let spec = build_spec(&task, "copilot", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-aaaa1111", "copilot");
        let mounted: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
        assert!(mounted.contains(&"/root/.copilot"), "{mounted:?}");
        assert!(mounted.contains(&"/root/.mytool"), "{mounted:?}");
        // The two unsafe entries never became mounts at all.
        assert!(!mounted.iter().any(|m| m.contains("escape") || *m == "/etc"), "{mounted:?}");
    }

    #[test]
    fn grok_stays_blocked_even_with_persist_enabled_and_extra_dirs() {
        // The one permanent exception: opting in can never resurrect grok,
        // because its binary lives inside its own config dir (~/.grok/bin)
        // and an opt-in mount would silently shadow it - see agent_config's
        // doc comment.
        let task = stub_task("t6", "/tmp/termic-docker-test-does-not-exist-6");
        let env = std::collections::HashMap::new();
        let extras = vec![".grok".to_string()];
        let spec = build_spec(&task, "grok", "img", &task.path, vec![], &env, &extras, true, &[], &[], "pty-aaaa1111", "grok");
        assert!(!spec.mounts.iter().any(|m| m.container.contains("grok")));
        assert!(!persist_offerable("grok"));
    }

    #[test]
    fn custom_agent_extra_dirs_need_persist_enabled_to_mount() {
        let task = stub_task("t7", "/tmp/termic-docker-test-does-not-exist-7");
        let env = std::collections::HashMap::new();
        let extras = vec![".mytool".to_string()];
        // Off by default: an unrecognized agent id with extras configured
        // but the opt-in switch still off mounts nothing at all.
        let off = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-aaaa1111", "my-custom-agent");
        assert!(off.mounts.iter().all(|m| !m.container.contains("mytool")));

        // Once opted in, the user's own dirs become the mount (there is no
        // confirmed built-in dir to fall back on for an agent this module
        // has never seen).
        let on = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &extras, true, &[], &[], "pty-aaaa1111", "my-custom-agent");
        let mounted: Vec<&str> = on.mounts.iter().map(|m| m.container.as_str()).collect();
        assert!(mounted.contains(&"/root/.mytool"), "{mounted:?}");
    }

    #[test]
    fn custom_agent_persist_enabled_with_no_dirs_mounts_nothing() {
        let task = stub_task("t8", "/tmp/termic-docker-test-does-not-exist-8");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &[], true, &[], &[], "pty-aaaa1111", "my-custom-agent");
        // Only the always-there worktree/.git mounts - no agent config dir.
        assert!(spec.mounts.iter().all(|m| !m.why.contains("Docker agent")));
    }

    #[test]
    fn live_allowed_paths_are_mounted_at_their_own_absolute_path() {
        // The task's live sandbox allow-list (lib.rs's live_sandbox_lists -
        // global Settings + task pin + .termic.yaml) used to be completely
        // invisible to Docker mode. It's now mounted the same way Seatbelt
        // allows it: at its own resolved path, unified across both engines.
        // A REAL directory: `docker run -v` cannot mount a path that is not
        // there, so only existing entries are staged (see the next case).
        let shared = tempfile::tempdir().unwrap();
        let shared_path = shared.path().to_string_lossy().into_owned();
        let task = stub_task("t9", "/tmp/termic-docker-test-does-not-exist-9");
        let env = std::collections::HashMap::new();
        let allowed = vec![shared_path.clone()];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &allowed, &[], "pty-aaaa1111", "claude");
        let mounted: Vec<String> = spec.mounts.iter().map(|m| m.container.clone()).collect();
        let canon = canonicalize_or_keep(&shared_path);
        assert!(mounted.contains(&canon), "{mounted:?}");
    }

    #[test]
    fn a_stale_allowed_path_is_skipped_instead_of_failing_the_whole_run() {
        // Seatbelt tolerates an allow-list entry whose directory is long
        // gone - it is just a rule that never matches - so these lists
        // accumulate paths from deleted projects. `docker run -v` does not:
        // one missing host path fails the entire run with an opaque daemon
        // error, which would make EVERY Docker task in that config
        // unlaunchable because of a directory nobody has needed for months.
        let gone = "/tmp/termic-docker-test-definitely-not-here-9f3a2b";
        assert!(!std::path::Path::new(gone).exists(), "fixture assumption");
        let task = stub_task("t9b", "/tmp/termic-docker-test-does-not-exist-9b");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false,
            &[gone.to_string()], &[], "pty-aaaa1111", "claude");
        assert!(!spec.mounts.iter().any(|m| m.host == gone),
            "a vanished allow-list entry must not become a -v flag");
    }

    #[test]
    fn live_allowed_paths_skip_regex_entries_and_dedupe_against_implicit_mounts() {
        let task = stub_task("t10", "/tmp/termic-docker-test-does-not-exist-10");
        let env = std::collections::HashMap::new();
        // A regex: entry (Seatbelt-only, no literal path) and the task's own
        // path (already mounted implicitly as step 1) should both be no-ops.
        let allowed = vec!["regex:^$HOME/\\.foo$".to_string(), task.path.clone()];
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &allowed, &[], "pty-aaaa1111", "claude");
        let host_paths: Vec<&str> = spec.mounts.iter().map(|m| m.host.as_str()).collect();
        // No stray mount was added for either entry - just the one implicit
        // worktree mount already covering task.path.
        let task_path_count = host_paths.iter().filter(|p| **p == task.path).count();
        assert_eq!(task_path_count, 1, "{host_paths:?}");
        assert!(!host_paths.iter().any(|p| p.contains("regex:") || p.contains("\\.foo")), "{host_paths:?}");
    }

    // ── Activity monitor integration ──────────────────────────────────

    #[test]
    fn byte_size_parses_binary_and_decimal_units() {
        assert_eq!(parse_byte_size("12.3MiB"), Some((12.3 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_byte_size("1.943GiB"), Some((1.943 * 1024.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_byte_size("500B"), Some(500));
        assert_eq!(parse_byte_size("2GB"), Some(2_000_000_000));
        assert_eq!(parse_byte_size("garbage"), None);
    }

    #[test]
    fn mem_usage_takes_the_used_half_before_the_slash() {
        assert_eq!(parse_mem_usage("10MiB / 1.9GiB"), parse_byte_size("10MiB"));
    }

    #[test]
    fn stats_line_parses_dockers_actual_column_order() {
        let (name, s) = parse_stats_line("termic-abc123\t3.14%\t10MiB / 1.9GiB\t7")
            .expect("valid line");
        assert_eq!(name, "termic-abc123");
        assert!((s.cpu_pct - 3.14).abs() < 1e-9);
        assert_eq!(s.mem_bytes, parse_byte_size("10MiB").unwrap());
        assert_eq!(s.pids, 7);
    }

    #[test]
    fn stats_line_rejects_a_short_row() {
        assert!(parse_stats_line("termic-abc123\t3.14%").is_none());
    }

    fn stub_row(key: &str) -> ProcRow {
        ProcRow {
            key: key.to_string(),
            kind: "claude".into(),
            pty_id: Some(key.to_string()),
            task_id: None,
            tab_id: None,
            pid: 4242,
            label: "docker".into(),
            cpu_pct: Some(0.0),
            mem_bytes: 1234,
            rss_bytes: 1234,
            proc_count: 1,
            threads: 1,
            cpu_ms: 0,
            uptime_ms: 0,
            out_bps: None,
            alive: true,
            cpu_history: vec![],
            children: vec![crate::procmon::ChildRow {
                pid: 4242,
                label: "docker".into(),
                cpu_pct: Some(0.0),
                mem_bytes: 1234,
            }],
            is_docker: false,
        }
    }

    #[test]
    fn merge_stats_is_a_noop_with_no_docker_rows() {
        let snap = Snapshot {
            session: 1,
            unix_ms: 0.0,
            rows: vec![stub_row("pty:1")],
            sample_ms: 0.0,
            webkit_unavailable: false,
        };
        let out = merge_stats(snap, &HashMap::new());
        assert!(!out.rows[0].is_docker);
        assert_eq!(out.rows[0].mem_bytes, 1234);
    }

    #[test]
    fn apply_overwrites_row_and_clears_the_host_children() {
        let mut row = stub_row("pty:1");
        let mut hist = HashMap::new();
        let stats = ContainerStats { cpu_pct: 42.0, mem_bytes: 999, pids: 3 };
        apply(&mut row, Some(&stats), &mut hist, 90);
        assert!(row.is_docker);
        assert!(row.children.is_empty());
        assert_eq!(row.cpu_pct, Some(42.0));
        assert_eq!(row.mem_bytes, 999);
        assert_eq!(row.rss_bytes, 999);
        assert_eq!(row.proc_count, 3);
        assert_eq!(row.cpu_history, vec![42.0]);
    }

    #[test]
    fn apply_keeps_last_known_numbers_on_a_transient_miss() {
        let mut row = stub_row("pty:1");
        row.mem_bytes = 555;
        let mut hist = HashMap::new();
        apply(&mut row, None, &mut hist, 90);
        // Still marked as a Docker row (children cleared) even though this
        // particular tick could not reach the daemon.
        assert!(row.is_docker);
        assert!(row.children.is_empty());
        assert_eq!(row.mem_bytes, 555);
        assert!(row.cpu_history.is_empty());
    }

    #[test]
    fn apply_caps_history_at_the_configured_length() {
        let mut row = stub_row("pty:1");
        let mut hist = HashMap::new();
        for i in 0..5 {
            let stats = ContainerStats { cpu_pct: i as f64, mem_bytes: 1, pids: 1 };
            apply(&mut row, Some(&stats), &mut hist, 3);
        }
        assert_eq!(row.cpu_history, vec![2.0, 3.0, 4.0]);
    }
}

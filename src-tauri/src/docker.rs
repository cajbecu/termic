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
    /// Things the user should know about this spec: a value that could not
    /// mean what it says inside a container, and what termic did about it.
    /// Surfaced by the command preview, which is the one place a person can
    /// see what a launch will actually do.
    #[serde(default)]
    pub warnings: Vec<String>,
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
/// `base_agent_id` for callers that do not already hold the registry. Loads it
/// and returns an owned-by-'static id, since every base we care about is a
/// built-in name. Falls back to the id itself when the registry cannot be read,
/// which is the same answer `base_agent_id` gives for an unknown agent.
pub fn base_agent_id_str(id: &str) -> &'static str {
    const BUILTINS: &[&str] = &["claude", "codex", "copilot", "agy", "antigravity", "opencode", "pi", "grok", "gemini"];
    let agents = crate::load_settings_inner().agents;
    let base = base_agent_id(&agents, id);
    BUILTINS.iter().copied().find(|b| *b == base).unwrap_or("claude")
}

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
/// Takes `base_id` (WHAT the agent is), never the agent's own id. An agent id
/// answers a different question - WHERE its state is stored - and that one is
/// the caller's, via `agent_config_host_dir`. The two differ exactly for a
/// cloned agent: a clone of claude runs the claude binary and has claude's
/// config shape, but must keep its own folder, which is the whole reason to
/// clone an agent. Conflating them is what made clones unusable in Docker
/// mode: matching on the clone's own id fell through to the unknown-agent
/// path, so nothing was mounted, nothing was relocated, and the agent wrote
/// its login into the container's throwaway filesystem (into `/root`, which
/// the non-root container user cannot even write - the EACCES a user sees).
/// The parameter is deliberately named for what it must be, so a future
/// caller cannot pass the wrong id without noticing.
fn agent_config(base_id: &str, user_extra_dirs: &[String], persist_enabled: bool) -> Option<AgentConfig> {
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
        // `state_dirs` entries are home-relative names; `sanitized` entries
        // are already full container paths (they may point outside HOME).
        let extra_dirs = rest
            .iter()
            .map(|d| format!("{CONTAINER_HOME}/{d}"))
            .chain(sanitized.iter().cloned())
            .collect();
        return Some(AgentConfig {
            container_dir: format!("{CONTAINER_HOME}/{first}"),
            relocation_env,
            extra_dirs,
        });
    }
    if !persist_enabled {
        return None;
    }
    let (first, rest) = sanitized.split_first()?;
    Some(AgentConfig {
        container_dir: first.clone(),
        relocation_env: None,
        extra_dirs: rest.to_vec(),
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
    if d.is_empty() || d.contains("..") || d.contains('\0') {
        return None;
    }
    // An ABSOLUTE path is taken as the container path verbatim, so a
    // directory can be persisted anywhere, not only under the agent's home.
    // A bare name is still accepted and means what it always did - the
    // agent's home - because `.claude` reads better than `/root/.claude` and
    // is what every existing entry looks like.
    let container = if d.starts_with('/') {
        d.trim_end_matches('/').to_string()
    } else {
        format!("{CONTAINER_HOME}/{}", d.trim_start_matches("./").trim_end_matches('/'))
    };
    // `/` alone, or anything that normalised away to nothing.
    if container.is_empty() || container == CONTAINER_HOME { return None; }
    if !persist_target_allowed(&container) { return None; }
    Some(container)
}

/// Roots an empty persist mount must never land on or inside: shadowing any
/// of these with a fresh directory either breaks the container outright or
/// hides something privilege-relevant the image put there.
const PERSIST_FORBIDDEN_ROOTS: &[&str] = &[
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/boot",
];

/// Roots a persist entry MAY live under. `/root` is the agent's home and the
/// common case; the rest are the conventional places a program keeps data it
/// would like to survive a restart. Anything else is refused rather than
/// guessed at - the cost of a wrong guess is a container that will not boot,
/// and the user can always pick a path under one of these.
const PERSIST_ALLOWED_ROOTS: &[&str] = &[
    "/root", "/home", "/opt", "/srv", "/mnt", "/data", "/workspace", "/var", "/tmp",
];

fn persist_target_allowed(container: &str) -> bool {
    let under = |root: &str| container == root || container.starts_with(&format!("{root}/"));
    if PERSIST_FORBIDDEN_ROOTS.iter().any(|r| under(r)) { return false; }
    // Never a bare root itself, even an allowed one: mounting over all of
    // `/var` or `/home` is not what anyone means by persisting a directory.
    if PERSIST_ALLOWED_ROOTS.iter().any(|r| container == *r) { return false; }
    PERSIST_ALLOWED_ROOTS.iter().any(|r| under(r))
}

/// HOME inside the container. Bare persist entries resolve against it.
pub const CONTAINER_HOME: &str = "/root";

/// Where a container path is stored on the host, under this agent's own
/// folder. The container path is MIRRORED (`/opt/cache` ->
/// `<agent>/opt/cache`) so two entries can never collide, and a leading dot
/// on a home-relative entry is dropped to keep the layout every existing
/// install already has (`.antigravity` -> `<agent>/antigravity`).
fn host_subpath_for(container: &str) -> String {
    let rel = container.strip_prefix(&format!("{CONTAINER_HOME}/"))
        .map(|r| r.strip_prefix('.').unwrap_or(r).to_string())
        .unwrap_or_else(|| container.trim_start_matches('/').to_string());
    rel
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

/// Root of the SHARED config dirs (`Settings.docker_shared_config_dirs`,
/// seeded with gh + glab). Sibling of `docker-agents/`, not a child of it:
/// what lives here belongs to the user and is used by whichever agent
/// happens to be running, so it is keyed on nothing. Each entry sits at its
/// mirrored container path underneath (`/root/.config/gh` ->
/// `docker-forge/config/gh`). See `build_spec` step 4b for why the host's
/// real `~/.config/gh` is never the thing that gets mounted, and why this
/// is a list of named dirs rather than all of `/root/.config`.
pub fn forge_config_host_dir() -> PathBuf {
    // Same dev/prod split as `agent_config_host_dir` - a dev build must not
    // pick up (or clobber) the release build's forge login.
    data_dir()
        .map(|d| d.join("docker-forge"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/termic-docker-forge"))
}

/// The shared config dirs a fresh install starts with. Both are forge CLIs
/// (`assets/Dockerfile.default` installs them), and both fall back to a
/// plaintext token file inside their own config dir when no OS keyring is
/// reachable, which is the case inside the image (no dbus, no keyring), so a
/// login performed in one container is readable by the next one.
///
/// This is a DEFAULT, not the whole list: `Settings.docker_shared_config_dirs`
/// is what `build_spec` actually reads, and a user can add anything else that
/// should be shared by every agent rather than copied per agent
/// (`.config/nvim`, a cloud CLI's config dir, and so on).
pub fn default_shared_config_dirs() -> Vec<String> {
    vec![".config/gh".to_string(), ".config/glab-cli".to_string()]
}

/// The config-dir env var for a shared dir, when its CLI has one. Keyed on
/// the dir's BASENAME rather than the full path, so someone who moves gh's
/// config somewhere else in the list still gets `GH_CONFIG_DIR` pointing at
/// wherever they put it. An entry with no known CLI just gets mounted, which
/// is all most tools need (they read `$HOME/.config/<name>` anyway).
fn shared_config_relocation_env(container: &str) -> Option<&'static str> {
    match container.rsplit('/').next()? {
        "gh" => Some("GH_CONFIG_DIR"),
        "glab-cli" => Some("GLAB_CONFIG_DIR"),
        _ => None,
    }
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
    // `Settings.docker_shared_config_dirs`: home-relative (or absolute)
    // container dirs mounted into EVERY container from one shared host dir
    // each, regardless of agent. See step 4b.
    shared_config_dirs: &[String],
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
    let mut relocation: Option<(String, String)> = None;
    if let Some(cfg) = agent_config(base_id, agent_extra_dirs, agent_persist_enabled) {
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
            let sub = PathBuf::from(&host_cfg)
                .join(host_subpath_for(extra))
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
            relocation = Some((var.to_string(), cfg.container_dir.clone()));
        }
    }

    // 4b. SHARED config dirs: mounted into every container, for every agent,
    //    from one host directory each. `Settings.docker_shared_config_dirs`
    //    (Settings → Docker Sandbox → "Shared config dirs") owns the list;
    //    `default_shared_config_dirs` seeds it with `.config/gh` and
    //    `.config/glab-cli`.
    //
    //    Shared rather than per-agent because the thing being persisted here
    //    belongs to the USER, not to an agent vendor: a GitHub token is the
    //    same token whichever agent pushes with it, and on the host every
    //    agent already reads one `~/.config/gh`. Per-agent copies would mean
    //    logging in again for each agent AND each clone of one, to end up
    //    holding the same credential in five places.
    //
    //    Note what this is NOT: a mount of the whole `/root/.config`. Nesting
    //    would work (Docker orders mounts by depth, so a per-agent
    //    `.config/opencode` still applies underneath a blanket mount), but an
    //    empty dir over the whole tree SHADOWS what the image put there at
    //    build time - `/root/.config/fish/completions/grok.fish` today, and
    //    whatever an unpinned installer drops there next. That is the exact
    //    failure `agent_dirs.rs` documents for grok, and it would also hand
    //    every agent every credential any other agent ever created, which is
    //    the opposite of the per-agent split above. One named dir at a time,
    //    each one a deliberate choice, is the whole point.
    //
    //    The host's real `~/.config/gh` is never what gets mounted, for three
    //    independent reasons: on macOS `gh` keeps the token in the Keychain
    //    (`hosts.yml` holds no `oauth_token` at all), so the mount would hand
    //    the container an unauthenticated gh; a container-side `gh auth
    //    logout` would take out the login `forge.rs` runs termic's own PR
    //    panel on; and Seatbelt hard-denies that same file (`sandbox.rs`), so
    //    mounting it here would make the container the looser of the two
    //    cages. These are termic's own directories, empty until someone logs
    //    in inside a container once.
    for raw in shared_config_dirs {
        // Same validator the per-agent extra dirs use: rejects `..`, `\0`,
        // and any target under a system root an empty mount could shadow.
        let Some(container) = sanitize_extra_dir(raw) else { continue };
        // Set the config-dir env even when the mount below is skipped: the
        // value is the same container path either way, and being explicit
        // survives an agent env block that sets its own XDG_CONFIG_HOME.
        // Pushed HERE, before the per-spawn overlay below, so a user who
        // deliberately sets GH_CONFIG_DIR for an agent still wins.
        if let Some(var) = shared_config_relocation_env(&container) {
            env.push((var.to_string(), container.clone()));
        }
        // A user who already mounted their own copy at this path (a
        // `.config/gh` entry in the agent's extra dirs) keeps it: an explicit
        // per-agent choice outranks this shared default, and two mounts on
        // one container path is not something to resolve by luck.
        if mounts.iter().any(|m| m.container == container) {
            continue;
        }
        // Host layout MIRRORS the container path (`/root/.config/gh` ->
        // `docker-forge/config/gh`), same convention as the per-agent extra
        // dirs, so two entries can never collide on the host side.
        let host = forge_config_host_dir()
            .join(host_subpath_for(&container))
            .to_string_lossy()
            .into_owned();
        // Ours to create, not the daemon's - same reasoning as the agent
        // config dir above (a root-owned dir on a Linux daemon means the
        // container cannot write the login it just performed).
        let _ = std::fs::create_dir_all(&host);
        mounts.push(Mount::implicit(
            host,
            container,
            false,
            "shared config dir (every agent, every task; log in once inside a container and it persists)",
            false,
        ));
    }

    // 4c. Attachments (`crate::attachments_dir`): files staged from a drop
    //    and images pasted into a terminal, mounted READ-ONLY at the
    //    IDENTICAL absolute path, same convention as the worktree.
    //
    //    Both gestures have the same problem: the file the user means lives
    //    somewhere the agent cannot reach. A dropped `~/Desktop/shot.png` is
    //    not mounted here and is hard-denied by Seatbelt, and an image paste
    //    cannot even reach the agent as text - xterm.js sends only bytes it
    //    was given down the PTY, and the agent inside the container is a
    //    Linux process whose own clipboard reader shells out to xclip /
    //    wl-paste with no route to the Mac's pasteboard. So termic copies (or
    //    writes) the file into one place all three cages can read and types
    //    THAT path. Same path on both sides means the frontend does not have
    //    to know which cage a task is in to know what to type.
    //
    //    Read-only: the app is the only writer.
    {
        let attachments = crate::attachments_dir().to_string_lossy().into_owned();
        if !attachments.is_empty() && !mounts.iter().any(|m| m.container == attachments) {
            mounts.push(Mount::implicit(
                attachments.clone(),
                attachments,
                true,
                "files you drop or paste into the terminal (read-only)",
                false,
            ));
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

    // The config-dir relocation var is termic's to set, so it is re-asserted
    // HERE, after the agent's own env block rather than before it.
    //
    // termic mounted that directory; a value pointing anywhere else cannot
    // work, because nothing else is mounted. A `CLAUDE_CONFIG_DIR` naming a
    // path on the Mac is the common case (it is right on the host, and people
    // set it to keep a cloned agent's login separate) and inside the container
    // it names a path that does not exist, whose parent is root-owned - so the
    // agent cannot even create it. The symptom is a login that reports success
    // and is gone a second later, plus "Transcript writes are failing
    // (permission denied - EACCES)", with the mounted directory sitting empty.
    //
    // A value that IS covered by a mount is left alone: that user arranged
    // somewhere real for it to go, and knows something we do not.
    let mut warnings: Vec<String> = Vec::new();
    if let Some((var, want)) = relocation.clone() {
        if let Some(pos) = env.iter().rposition(|(k, _)| *k == var) {
            let have = env[pos].1.clone();
            let mounted = mounts.iter().any(|m| have == m.container
                || have.starts_with(&format!("{}/", m.container)));
            if have != want && !mounted {
                warnings.push(format!(
                    "{var} was set to {have}, which is not mounted in the container.                      Using {want} instead, which is where termic mounts this agent's                      config. Set it in the agent's Docker environment if you need a                      different path, and add a mount for it."
                ));
                env.push((var, want));
            }
        }
    }

    DockerSpec {
        warnings,
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

/// Helper to construct a `Command` targeting the `docker` binary, configured
/// with the login-shell-resolved PATH and any `DOCKER_*` environment variables.
///
/// On macOS, GUI apps inherit a bare `/usr/bin:/bin:/usr/sbin:/sbin` PATH from
/// launchd, which misses `/usr/local/bin`, `/opt/homebrew/bin`, `~/.docker/bin`,
/// OrbStack, and custom DOCKER_HOST / DOCKER_CONTEXT settings in shell profiles.
pub fn docker_cmd() -> Command {
    let mut cmd = Command::new("docker");
    let (path, inject) = crate::shell_env::spawn_env();
    cmd.env("PATH", path);
    for (k, v) in inject {
        if k.starts_with("DOCKER_") || k == "COLIMA_PROFILE" {
            cmd.env(k, v);
        }
    }
    cmd
}

/// Construct the `docker build` Command + the tag it will produce, writing
/// the Dockerfile to disk first. The caller drives execution (the command
/// layer streams its output line-by-line off a background thread; never on
/// the synchronous Tauri path). `no_cache` => `--no-cache --pull`.
/// The build arg the shipped Dockerfile declares just above its agent
/// installs. Passing a fresh value invalidates from that line down.
pub const AGENT_REFRESH_ARG: &str = "TERMIC_AGENT_REFRESH";

pub fn build_command(dockerfile: &str, no_cache: bool) -> Result<(Command, String), String> {
    let tag = image_tag(dockerfile);
    let dir = docker_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let df_path = dir.join("Dockerfile");
    std::fs::write(&df_path, dockerfile).map_err(|e| e.to_string())?;

    let mut cmd = docker_cmd();
    // --progress=plain so the streamed log is line-based (not a TTY redraw).
    cmd.args(["build", "--progress=plain", "-t", &tag, "-f"]);
    cmd.arg(&df_path);
    if no_cache {
        // "Update agents" only needs the AGENT layers re-run. Docker
        // invalidates a layer and everything after it, so `--no-cache` also
        // re-pulls the base image and re-runs the apt install - minutes of
        // work that almost never changed. When the Dockerfile declares the
        // refresh arg, bump it instead: the agent installs re-run (they are
        // unpinned, which is the whole reason this action exists) and the
        // expensive layers above stay cached.
        //
        // A Dockerfile that does NOT declare it falls back to `--no-cache`,
        // because the arg would be silently unconsumed - docker only warns -
        // and the user would get a fully cached build that updates nothing.
        // That covers anyone whose saved Dockerfile predates this.
        if dockerfile.contains(AGENT_REFRESH_ARG) {
            cmd.arg("--build-arg");
            cmd.arg(format!("{AGENT_REFRESH_ARG}={}", refresh_token()));
        } else {
            cmd.args(["--no-cache", "--pull"]);
        }
    }
    // Build context is the docker dir (lets users `COPY` baked skills etc.
    // from a path they control next to the Dockerfile).
    cmd.arg(&dir);
    Ok((cmd, tag))
}

/// A value that differs from the last one, so the layer below the arg is
/// invalidated. Seconds since the epoch: monotonic in practice and readable
/// in `docker history`, which beats a random number when someone is trying to
/// work out why a layer rebuilt.
fn refresh_token() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
    let version = docker_cmd()
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let binary = version.is_some();
    let daemon = binary
        && docker_cmd()
            .arg("info")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    DockerStatus { binary, daemon, version }
}

/// Does an image with this tag already exist locally? (Drives dropdown
/// availability + the "not built / rebuild" Settings state.)
pub fn image_exists(tag: &str) -> bool {
    docker_cmd()
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

/// `docker rm -f` ONE container by name. Used when a PTY goes away: the
/// container is named per-PTY, so this cannot touch a sibling tab's.
///
/// Necessary because killing the PTY only kills the local `docker run`
/// CLIENT: it is attached in the foreground with no `-d`, so the container
/// keeps running server-side, and `--rm` only fires on the container's own
/// clean exit. Without this, closing a tab leaked its container - and since
/// every container of one agent mounts the SAME config dir, the leaked ones
/// keep running an agent that fights the live one over anything singleton in
/// there (Claude Code's Remote Control session, for instance, which reports
/// "another connection took over" and disconnects).
///
/// Off-thread at every call site: it shells out to the daemon.
pub fn rm_container(name: &str) {
    let _ = docker_cmd().args(["rm", "-f", name]).output();
}

/// `docker rm -f` every termic-labeled container (app quit). Non-fatal.
pub fn cleanup_all() {
    rm_by_filter(&format!("label={LABEL_KEY}"));
}

fn rm_by_filter(filter: &str) {
    let ids = docker_cmd()
        .args(["ps", "-aq", "--filter", filter])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    for id in ids.lines().filter(|l| !l.trim().is_empty()) {
        let _ = docker_cmd().args(["rm", "-f", id]).output();
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
#[derive(Clone, Debug, PartialEq)]
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
    let out = docker_cmd()
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
    fn a_host_path_config_dir_cannot_override_the_mounted_one() {
        // The real failure this prevents: CLAUDE_CONFIG_DIR set to a path on
        // the Mac (right on the host, and how people keep a cloned agent's
        // login separate) rides into the container, where that path does not
        // exist and its parent is root-owned. The agent then cannot write its
        // login or transcripts at all - EACCES - and the directory termic
        // mounted for it stays empty.
        let task = stub_task("t-env", "/tmp/termic-docker-test-does-not-exist");
        let mut env = std::collections::HashMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "/Users/me/.next-claude".to_string());
        let spec = with_scratch_data_dir(|| build_spec(&task, "next-claude", "img", &task.path,
            vec![], &env, &[], false, &[], &[], "pty-env000001", "claude", &[]));

        // LAST value wins with `docker run -e`, so the last one is the one
        // that counts.
        let effective = spec.env.iter().rev()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| v.clone()).unwrap();
        assert_eq!(effective, "/root/.claude");
        assert!(spec.warnings.iter().any(|w| w.contains("/Users/me/.next-claude")),
            "silently correcting it would be its own surprise: {:?}", spec.warnings);
    }

    #[test]
    fn a_config_dir_inside_a_mount_is_left_alone() {
        // Someone who pointed it at a path they actually mounted knows
        // something we do not; only unmounted paths are overridden.
        let task = stub_task("t-env2", "/tmp/termic-docker-test-does-not-exist");
        let mut env = std::collections::HashMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "/root/.claude/alt".to_string());
        let spec = with_scratch_data_dir(|| build_spec(&task, "claude", "img", &task.path,
            vec![], &env, &[], false, &[], &[], "pty-env000002", "claude", &[]));
        let effective = spec.env.iter().rev()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| v.clone()).unwrap();
        assert_eq!(effective, "/root/.claude/alt");
        assert!(spec.warnings.is_empty(), "{:?}", spec.warnings);
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
        let spec = with_scratch_data_dir(|| build_spec(&task, "next-claude", "img", &task.path,
            vec![], &env, &[], false, &[], &[], "pty-clone0001", "claude", &[]));

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

    /// Point `data_dir()` at a scratch profile for the duration of a test.
    /// `build_spec` CREATES the agent config dir now, and `data_dir()` in a
    /// test otherwise resolves to the developer's REAL profile - so without
    /// this the suite silently made folders in
    /// `~/Library/Application Support/termic/docker-agents`. Debug-only seam,
    /// same one automation.rs uses.
    /// Serializes every test that either REDIRECTS `TERMIC_DATA_DIR` or reads
    /// something derived from it. Both halves matter: the var is process-wide,
    /// so a test writing the Dockerfile into `docker_dir()` while another test
    /// has the data dir pointed at a tempdir (about to be deleted) fails on a
    /// path that has nothing to do with what it is testing. That is exactly
    /// how `updating_agents_busts_only_the_agent_layers` started failing only
    /// when run alongside the rest of the module.
    static DATA_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_scratch_data_dir<T>(f: impl FnOnce() -> T) -> T {
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var("TERMIC_DATA_DIR").ok();
        // SAFETY: cargo runs tests in threads, and every test that touches
        // this var (or reads a path derived from it) takes DATA_DIR_LOCK.
        let _g = DATA_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("TERMIC_DATA_DIR", dir.path()) };
        let out = f();
        match prev {
            Some(v) => unsafe { std::env::set_var("TERMIC_DATA_DIR", v) },
            None => unsafe { std::env::remove_var("TERMIC_DATA_DIR") },
        }
        out
    }

    #[test]
    fn the_agent_config_host_dir_exists_before_it_becomes_a_mount() {
        // A missing `-v` source is created by the DAEMON, and its ownership
        // is the daemon's business: Docker Desktop on macOS maps it to the
        // host user (which is the only reason this ever worked), a Linux
        // daemon creates it root-owned. The container runs as the host uid,
        // so a root-owned config dir means the agent cannot write its login
        // or its transcripts: EACCES, and a login that never sticks.
        with_scratch_data_dir(|| {
            let task = stub_task("t-mk", "/tmp/termic-docker-test-does-not-exist");
            let env = std::collections::HashMap::new();
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false,
                &[], &[], "pty-mkdir0001", "claude", &[]);
            let cfg = spec.mounts.iter().find(|m| m.container == "/root/.claude").unwrap();
            assert!(std::path::Path::new(&cfg.host).is_dir(),
                "host config dir must exist before docker sees it: {}", cfg.host);
        });
    }

    #[test]
    fn a_clone_of_grok_stays_excluded() {
        // grok's exclusion is about its layout (binary inside its config
        // dir), so it has to follow the clone rather than the id.
        let agents = vec![stub_agent("grok", None), stub_agent("my-grok", Some("grok"))];
        assert_eq!(base_agent_id(&agents, "my-grok"), "grok");
        assert!(agent_config("grok", &[".grok".to_string()], true).is_none());
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
        let spec = build_spec(&task, "pi", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-pi000001", "pi", &[]);
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
        let a = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "aaaaaaaa-1111-2222-3333-444444444444", "claude", &[]);
        let b = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "bbbbbbbb-1111-2222-3333-444444444444", "claude", &[]);
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
        let spec = build_spec(&task, "claude", "termic-sandbox:abc", &task.path, vec![], &spawn_env, &[], false, &[], &[], "pty-aaaa1111", "claude", &[]);
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
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &spawn_env, &[], false, &[], &[], "pty-aaaa1111", "claude", &[]);
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
            let spec = build_spec(&task, agent, "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", agent, &[]);
            let mounted: Vec<&str> = spec.mounts.iter().map(|m| m.container.as_str()).collect();
            assert!(mounted.contains(primary), "{agent}: expected {primary} in {mounted:?}");
            for e in *extras {
                assert!(mounted.contains(e), "{agent}: expected {e} in {mounted:?}");
            }
        }
        // grok stays unsupported in Docker mode regardless of what
        // agent_dirs lists for Seatbelt's sake.
        let grok_spec = build_spec(&task, "grok", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", "grok", &[]);
        assert!(!grok_spec.mounts.iter().any(|m| m.container.contains("grok")));
    }

    #[test]
    fn relocation_env_value_always_matches_the_container_dir() {
        let task = stub_task("t4", "/tmp/termic-docker-test-does-not-exist-4");
        let env = std::collections::HashMap::new();
        for (agent, var) in [("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME")] {
            let spec = build_spec(&task, agent, "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", agent, &[]);
            let val = spec.env.iter().find(|(k, _)| k == var).map(|(_, v)| v.as_str());
            assert_eq!(val, Some(format!("/root/.{agent}").as_str()));
        }
    }

    #[test]
    fn a_bare_persist_entry_resolves_against_the_container_home() {
        // `.claude` reads better than `/root/.claude` and is what every
        // existing entry looks like, so a bare name still means HOME.
        assert_eq!(sanitize_extra_dir(".mytool"), Some("/root/.mytool".to_string()));
        assert_eq!(sanitize_extra_dir(".config/mytool"), Some("/root/.config/mytool".to_string()));
        assert_eq!(sanitize_extra_dir("./.mytool"), Some("/root/.mytool".to_string()));
        assert_eq!(sanitize_extra_dir("  .mytool  "), Some("/root/.mytool".to_string()));
        assert_eq!(sanitize_extra_dir(".mytool/"), Some("/root/.mytool".to_string()));
    }

    #[test]
    fn an_absolute_persist_entry_is_taken_verbatim() {
        // Persisting outside HOME is the point of accepting these: a cache or
        // a data dir an agent keeps somewhere else has the same "gone on every
        // restart" problem as its config.
        assert_eq!(sanitize_extra_dir("/opt/cache"), Some("/opt/cache".to_string()));
        assert_eq!(sanitize_extra_dir("/opt/cache/"), Some("/opt/cache".to_string()));
        assert_eq!(sanitize_extra_dir("/root/.claude"), Some("/root/.claude".to_string()));
    }

    /// The argv `build_command` produced, as plain strings.
    fn build_argv(dockerfile: &str, no_cache: bool) -> Vec<String> {
        // `build_command` writes the Dockerfile under `docker_dir()`, i.e.
        // under whatever `TERMIC_DATA_DIR` currently says - so it has to hold
        // the same lock as the tests that redirect it.
        let _g = DATA_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (cmd, _) = build_command(dockerfile, no_cache).unwrap();
        cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn updating_agents_busts_only_the_agent_layers() {
        // `--no-cache` also re-pulls the base image and re-runs the apt
        // install, which is the slow half of the build and is not what
        // "update agents" is asking for. The shipped Dockerfile declares a
        // refresh arg above its agent installs; bumping that invalidates from
        // there down and leaves the expensive layers cached.
        let df = DEFAULT_DOCKERFILE;
        assert!(df.contains(AGENT_REFRESH_ARG), "the shipped Dockerfile must declare it");
        let argv = build_argv(df, true);
        assert!(argv.iter().any(|a| a.starts_with(&format!("{AGENT_REFRESH_ARG}="))), "{argv:?}");
        assert!(!argv.iter().any(|a| a == "--no-cache"), "{argv:?}");
    }

    #[test]
    fn a_dockerfile_without_the_arg_still_gets_a_real_no_cache_build() {
        // Anyone whose SAVED Dockerfile predates the arg would otherwise get a
        // fully cached build that updates nothing: docker only warns about an
        // unconsumed build-arg, it does not fail.
        let argv = build_argv("FROM node:lts-bookworm\nRUN echo hi\n", true);
        assert!(argv.iter().any(|a| a == "--no-cache"), "{argv:?}");
        assert!(argv.iter().any(|a| a == "--pull"), "{argv:?}");
        assert!(!argv.iter().any(|a| a.starts_with(AGENT_REFRESH_ARG)), "{argv:?}");
    }

    #[test]
    fn an_ordinary_build_busts_nothing() {
        let argv = build_argv(DEFAULT_DOCKERFILE, false);
        assert!(!argv.iter().any(|a| a == "--no-cache"), "{argv:?}");
        assert!(!argv.iter().any(|a| a.starts_with(AGENT_REFRESH_ARG)), "{argv:?}");
    }

    #[test]
    fn a_persist_entry_cannot_shadow_the_system() {
        // An empty dir mounted over these either stops the container booting
        // or hides something the image put there on purpose.
        for bad in ["/etc", "/etc/ssl", "/usr/bin", "/bin", "/lib/x", "/proc", "/dev/shm", "/boot"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be refused");
        }
        // Nor a bare root, even an allowed one: mounting over all of /var is
        // not what anyone means by persisting a directory.
        for bad in ["/var", "/home", "/opt", "/tmp"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be refused");
        }
        // But somewhere under them is exactly the point.
        assert_eq!(sanitize_extra_dir("/var/cache/mytool"), Some("/var/cache/mytool".to_string()));
        assert_eq!(sanitize_extra_dir("/data/models"), Some("/data/models".to_string()));
    }

    #[test]
    fn sanitize_extra_dir_still_rejects_escapes_and_nonsense() {
        // `..` stays banned however it is spelled: it is the one thing that
        // could resolve a mount TARGET somewhere neither side intended.
        for bad in ["", "   ", "/", "/root", "../../etc", ".foo/../../etc", "/opt/../etc"] {
            assert_eq!(sanitize_extra_dir(bad), None, "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn a_persist_entry_maps_to_a_collision_free_host_folder() {
        // The container path is mirrored under the agent's folder, so two
        // entries can never land on the same host dir...
        assert_eq!(host_subpath_for("/opt/cache"), "opt/cache");
        // ...and a home-relative entry keeps the dotless layout every existing
        // install already has on disk.
        assert_eq!(host_subpath_for("/root/.antigravity"), "antigravity");
        assert_eq!(host_subpath_for("/root/.config/opencode"), "config/opencode");
        assert_ne!(host_subpath_for("/opt/cache"), host_subpath_for("/root/.cache"));
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
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-aaaa1111", "claude", &[]);
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
    fn the_forge_clis_get_a_shared_config_dir_and_their_relocation_env() {
        // One `gh auth login` has to cover every agent and every task, so
        // this mount is keyed on nothing - unlike everything else under
        // docker-agents/<agent>/.
        let task = stub_task("t-forge", "/tmp/termic-docker-test-does-not-exist-forge");
        let env = std::collections::HashMap::new();
        // Every assertion runs INSIDE the closure: the scratch data dir is a
        // tempdir that is deleted the moment it returns, and the whole point
        // of one of these is that the host path exists on disk by then.
        with_scratch_data_dir(|| {
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-forge001", "claude", &default_shared_config_dirs());
        for (container, var) in [("/root/.config/gh", "GH_CONFIG_DIR"), ("/root/.config/glab-cli", "GLAB_CONFIG_DIR")] {
            let m = spec.mounts.iter().find(|m| m.container == container)
                .unwrap_or_else(|| panic!("{container} should be mounted"));
            assert!(!m.read_only, "a login has to be WRITTEN inside the container");
            assert!(m.host.contains("docker-forge"), "host side should live in the shared dir, got {}", m.host);
            // The source has to exist before it becomes a `-v`, or the daemon
            // creates it - root-owned on Linux, which is a login that can
            // never be written. Same reasoning as the agent config dir.
            assert!(std::path::Path::new(&m.host).is_dir(), "{} should exist already", m.host);
            assert!(spec.env.iter().any(|(k, v)| k == var && v == container), "{var} should point at {container}");
        }
        });
    }

    #[test]
    fn the_hosts_own_gh_credentials_are_never_mounted() {
        // Seatbelt hard-denies ~/.config/gh/hosts.yml; mounting it here would
        // make the container the looser of the two cages. It would also not
        // work on macOS, where the token lives in the Keychain rather than in
        // that file at all.
        let task = stub_task("t-forge2", "/tmp/termic-docker-test-does-not-exist-forge2");
        let env = std::collections::HashMap::new();
        let spec = with_scratch_data_dir(|| {
            build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-forge002", "claude", &default_shared_config_dirs())
        });
        let home = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
        if home.is_empty() { return }
        for m in &spec.mounts {
            assert!(!m.host.starts_with(&format!("{home}/.config/gh")), "{} is the user's real gh login", m.host);
            assert!(!m.host.starts_with(&format!("{home}/.config/glab-cli")), "{} is the user's real glab login", m.host);
        }
    }

    #[test]
    fn a_per_agent_gh_config_dir_wins_over_the_shared_one() {
        // Someone who deliberately listed `.config/gh` for one agent wants
        // that agent to hold its own token. An explicit choice outranks the
        // shared default, and two mounts on one container path must never
        // both be emitted.
        let task = stub_task("t-forge3", "/tmp/termic-docker-test-does-not-exist-forge3");
        let env = std::collections::HashMap::new();
        let extras = vec![".config/gh".to_string()];
        let spec = with_scratch_data_dir(|| {
            build_spec(&task, "copilot", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-forge003", "copilot", &default_shared_config_dirs())
        });
        let gh: Vec<&Mount> = spec.mounts.iter().filter(|m| m.container == "/root/.config/gh").collect();
        assert_eq!(gh.len(), 1, "exactly one mount per container path: {gh:?}");
        assert!(gh[0].host.contains("docker-agents"), "the agent's own dir should win, got {}", gh[0].host);
        // The env still names the same container path, so gh looks in the
        // directory that actually got mounted either way.
        assert!(spec.env.iter().any(|(k, v)| k == "GH_CONFIG_DIR" && v == "/root/.config/gh"));
        // glab is untouched by that opt-out and keeps the shared dir.
        let glab = spec.mounts.iter().find(|m| m.container == "/root/.config/glab-cli").unwrap();
        assert!(glab.host.contains("docker-forge"), "{}", glab.host);
    }

    #[test]
    fn attachments_are_mounted_read_only_at_the_same_path_both_sides() {
        // The frontend types ONE path string and does not know which cage the
        // task is in, so the container path has to equal the host path.
        // Read-only because the app is the only writer.
        //
        // NOT under the data dir, and that is the load-bearing part: Seatbelt
        // ends with a last-match-wins deny on the whole data dir (the CLI
        // token), so a pasted image there would be unreadable in the mode
        // most tasks run under. `attachments_dir` is in `$TMPDIR`, which
        // `builtin_runtime_paths` already allows.
        let task = stub_task("t-clip", "/tmp/termic-docker-test-does-not-exist-clip");
        let env = std::collections::HashMap::new();
        with_scratch_data_dir(|| {
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-clip0001", "claude", &[]);
            let att = spec.mounts.iter().find(|m| m.host.ends_with("termic-attachments"))
                .expect("the attachments dir should be mounted");
            assert_eq!(att.host, att.container, "same path both sides or the typed path is a lie");
            assert!(att.read_only, "the container has no reason to write here");
            assert!(std::path::Path::new(&att.host).is_dir(), "{} should exist already", att.host);
            // Canonical, or the Seatbelt rule, the mount and the typed text
            // would each name a different string for the same directory.
            assert!(!att.host.starts_with("/var/folders"), "should be the resolved /private path: {}", att.host);
            // The pasted image dir sits underneath it, so one mount covers
            // both gestures.
            let clip = crate::clipboard_dir().unwrap();
            assert!(clip.starts_with(&att.host), "{clip:?} should live under {}", att.host);
        });
    }

    #[test]
    fn a_user_added_shared_dir_is_mounted_for_every_agent() {
        // The list is the user's, not a fixed pair of forge CLIs: anything
        // that should be shared rather than copied per agent goes in it. An
        // entry with no known CLI gets the mount and no relocation env,
        // which is all a tool that reads $HOME/.config/<name> needs.
        let task = stub_task("t-shared", "/tmp/termic-docker-test-does-not-exist-shared");
        let env = std::collections::HashMap::new();
        let dirs = vec![
            ".config/nvim".to_string(),
            "../escape".to_string(), // rejected by sanitize_extra_dir
            "/etc".to_string(),      // forbidden root
            String::new(),           // inert
        ];
        with_scratch_data_dir(|| {
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-shared01", "claude", &dirs);
            let nvim = spec.mounts.iter().find(|m| m.container == "/root/.config/nvim")
                .expect("a shared dir the user listed should be mounted");
            // Host layout mirrors the container path, so two entries with the
            // same basename (.config/gh vs some other gh) cannot collide.
            assert!(nvim.host.ends_with("docker-forge/config/nvim"), "{}", nvim.host);
            assert!(std::path::Path::new(&nvim.host).is_dir(), "{} should exist already", nvim.host);
            assert!(!spec.env.iter().any(|(_, v)| v == "/root/.config/nvim"),
                "no relocation env should be invented for a CLI this module knows nothing about");
            // The three junk entries never became mounts.
            assert!(!spec.mounts.iter().any(|m| m.container.contains("escape") || m.container == "/etc"));
            // And an empty list is a real answer: gh/glab are a DEFAULT, not
            // a floor, so a user who clears the field gets no shared mounts.
            let none = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-shared02", "claude", &[]);
            assert!(!none.mounts.iter().any(|m| m.container.starts_with("/root/.config/")));
            assert!(!none.env.iter().any(|(k, _)| k == "GH_CONFIG_DIR"));
        });
    }

    #[test]
    fn the_shared_config_env_follows_the_dir_the_user_actually_listed() {
        // Keyed on the entry's basename, so moving gh's config elsewhere in
        // the list still points GH_CONFIG_DIR at wherever it landed rather
        // than at a path nothing is mounted on.
        let task = stub_task("t-shared2", "/tmp/termic-docker-test-does-not-exist-shared2");
        let env = std::collections::HashMap::new();
        let dirs = vec!["/opt/forge/gh".to_string()];
        with_scratch_data_dir(|| {
            let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &[], "pty-shared03", "claude", &dirs);
            assert!(spec.mounts.iter().any(|m| m.container == "/opt/forge/gh"));
            assert!(spec.env.iter().any(|(k, v)| k == "GH_CONFIG_DIR" && v == "/opt/forge/gh"));
        });
    }

    #[test]
    fn a_task_extra_mount_cannot_shadow_the_forge_config_dirs() {
        let task = stub_task("t-forge4", "/tmp/termic-docker-test-does-not-exist-forge4");
        let env = std::collections::HashMap::new();
        let extras = vec!["/tmp/whatever:/root/.config/gh".to_string()];
        let spec = with_scratch_data_dir(|| {
            build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-forge004", "claude", &default_shared_config_dirs())
        });
        let gh: Vec<&str> = spec.mounts.iter().filter(|m| m.container == "/root/.config/gh").map(|m| m.host.as_str()).collect();
        assert_eq!(gh.len(), 1, "{gh:?}");
        assert_ne!(gh[0], "/tmp/whatever");
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
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-aaaa1111", "claude", &[]);
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
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &[], &extras, "pty-aaaa1111", "claude", &[]);
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
        let spec = build_spec(&task, "copilot", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-aaaa1111", "copilot", &[]);
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
        let spec = build_spec(&task, "grok", "img", &task.path, vec![], &env, &extras, true, &[], &[], "pty-aaaa1111", "grok", &[]);
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
        let off = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &extras, false, &[], &[], "pty-aaaa1111", "my-custom-agent", &[]);
        assert!(off.mounts.iter().all(|m| !m.container.contains("mytool")));

        // Once opted in, the user's own dirs become the mount (there is no
        // confirmed built-in dir to fall back on for an agent this module
        // has never seen).
        let on = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &extras, true, &[], &[], "pty-aaaa1111", "my-custom-agent", &[]);
        let mounted: Vec<&str> = on.mounts.iter().map(|m| m.container.as_str()).collect();
        assert!(mounted.contains(&"/root/.mytool"), "{mounted:?}");
    }

    #[test]
    fn custom_agent_persist_enabled_with_no_dirs_mounts_nothing() {
        let task = stub_task("t8", "/tmp/termic-docker-test-does-not-exist-8");
        let env = std::collections::HashMap::new();
        let spec = build_spec(&task, "my-custom-agent", "img", &task.path, vec![], &env, &[], true, &[], &[], "pty-aaaa1111", "my-custom-agent", &[]);
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
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &allowed, &[], "pty-aaaa1111", "claude", &[]);
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
            &[gone.to_string()], &[], "pty-aaaa1111", "claude", &[]);
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
        let spec = build_spec(&task, "claude", "img", &task.path, vec![], &env, &[], false, &allowed, &[], "pty-aaaa1111", "claude", &[]);
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

# Docker sandbox

Self-contained design + research for an opt-in Docker sandboxing mode: run
the agent CLI inside a container instead of macOS Seatbelt, so it can only
touch the paths we mount. Status: **implemented** (`src-tauri/src/docker.rs`,
`src/components/settings/DockerSection.tsx`, `task_set_docker`). See
`docs/sandbox.md` for the shipped Docker section.

Since this bundle's research (2026-06-25), the agent roster changed: Gemini
CLI retired (replaced by opencode), and Claude Code's npm install was
deprecated in favor of a native installer (`curl -fsSL
https://claude.ai/install.sh | bash`, binary lands in `~/.local/bin`). The
shipped [Dockerfile](Dockerfile) and `agent_config()` in `docker.rs` reflect
the current roster; `findings.md` and `design.md` below are left as the
original research record and are not updated line-by-line for every agent
CLI release.

Contents:

- **[design.md](design.md)** - the full Phase 1 plan: scope, UX (dialog
  transparency + how-it-works explainer + command preview), architecture
  and integration points, auth/`login`-persistence, sessions/resume,
  customization persistence, cleanup, open questions, task breakdown.
- **[findings.md](findings.md)** - empirical evidence from real container
  experiments (agent installs/config dirs, config-dir relocation envs,
  worktree `.git` mount result, macOS ownership, env-token matrix).
- **[Dockerfile](Dockerfile)** - the validated generic image (all six agents
  build and run). Intended as the shipped reset-to-default.

Start with design.md; findings.md is the evidence it rests on.

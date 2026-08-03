# Profiles (multi-window, Chrome-style)

Deferred, not yet built. Captured here so the intent is not lost.

## The idea

A **Profile** is a fully isolated termic instance: its own projects, tasks, and
settings, running in its own window. The mental model is Chrome profiles — not a
view filter, but a separate identity with separate data.

```
Profile A  (e.g. "Work")        own window, own projects + tasks
Profile B  (e.g. "Open Source") own window, own projects + tasks
```

Opening a new profile opens a new native window. `Cmd+N` (macOS convention,
matches Chrome / Safari) creates or switches to a profile window.

## Why

Projects and tasks today live in a single global store. A solo developer
with one context is fine. A developer with distinct work / personal / client
contexts has no way to keep those namespaces separate without archiving
everything and restoring it manually.

Note: this is distinct from the planned **Space** layer (`docs/plans/space-layer.md`),
which adds Arc-style horizontal grouping *within* a single namespace. Profiles add
*isolation between* namespaces, each in its own window.

## Scope when we build it

- A profile is a named, persistent entity owning: project list, task list,
  settings overrides (theme, shortcuts), and any future per-profile state.
- Each profile runs in its own OS window. Switching profiles brings that
  window to front; creating one opens a new window.
- `Cmd+N` opens the profile picker or creates a new profile window (TBD).
- Default profile for existing users: a single unnamed profile containing
  everything they have now — zero-migration path.
- Profile data stored in a per-profile subdirectory of the app data folder
  so backup, export, and deletion are file-system-level operations.

## Open questions

- Should profiles share a process or run as separate OS processes?
  (Separate processes = true isolation + crash containment; shared process =
  easier cross-profile actions like "move this task to Profile B".)
- Profile switcher UX: dock icon menu, a top-of-window pill, or something else?
- Whether Spaces (when built) are per-profile or global.

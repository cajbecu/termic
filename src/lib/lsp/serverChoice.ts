// Which server the user picked for a language, readable from code that must
// not import the prefs store.
//
// Same shape and same reason as `diagnosticsPref.ts`: `install.ts` is imported
// by `symbolSearch.ts` and by the chip, both of which are reached from
// node-environment unit tests, and `prefs.ts` applies the theme to
// `document.documentElement` at import time. Importing the store from here
// took three test files down with "document is not defined".
//
// So the store mirrors the value in, and this stays a plain module-level
// object: it is read at the moment a server is about to be resolved, which is
// exactly when the current value is wanted.

let chosen: Record<string, string> = {};
let commands: Record<string, string> = {};

/** Called by prefs.ts on load and on every change. */
export function setChosenServers(v: Record<string, string>) {
  chosen = v;
}
export function setChosenCommands(v: Record<string, string>) {
  commands = v;
}

/** The server this machine runs for a language, or null for termic's own
 *  resolution order. */
export function preferredServer(language: string): string | null {
  return chosen[language] ?? null;
}

/** The command line this machine runs for a language, or null. */
export function machineCommand(language: string): string | null {
  return commands[language] ?? null;
}

/** What a project says, and what this machine says. */
export interface ServerChoice {
  /** A catalog name ("ty"), or null to use termic's order. */
  server: string | null;
  /** A command line to run instead of any of it, or null. */
  command: string | null;
}

/**
 * The choice in force for a checkout, project first.
 *
 * Precedence, most explicit to least: the project's command, the project's
 * pick, this machine's command, this machine's pick, termic's own order. The
 * project wins because it is the narrower statement ("this repo needs
 * pyright"), and the machine setting is a default for repos that said nothing.
 *
 * Command and pick are resolved INDEPENDENTLY: a project that names a command
 * but no pick still falls back to the machine's pick if that command turns out
 * to be empty, and a project that picks a server does not lose the machine's
 * command for a different language.
 */
export function serverChoiceFor(
  project: { code_intel_servers?: Record<string, string>; code_intel_commands?: Record<string, string> }
    | undefined,
  language: string,
): ServerChoice {
  return {
    server: project?.code_intel_servers?.[language] ?? preferredServer(language),
    command: project?.code_intel_commands?.[language] ?? machineCommand(language),
  };
}

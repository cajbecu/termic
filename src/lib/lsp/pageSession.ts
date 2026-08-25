// Which PAGE LOAD a language server belongs to, and how the ones left over
// from a previous load are killed.
//
// Found in the wild, on a dev machine: six `tsgo` processes, all alive, all on
// the same checkout, spawned minutes apart. One server per (checkout,
// language) is the design, and the map that enforces it lives in the WEBVIEW.
// A reload throws that map away (⌘R, an HMR full reload, a crashed renderer)
// while the processes it was tracking keep running, so the fresh page starts
// another one and the old one is unreachable forever: nothing holds its
// Channel, nothing can send to it, and it will never answer anyone again.
//
// `lsp_start`'s reader thread does notice a dead Channel, but only when the
// server next SENDS something. An idle TypeScript server sends nothing, so it
// sat there holding its index (about 300 MB each, and rust-analyzer is ten
// times that) until the machine was rebooted.
//
// So each page load stamps the servers it starts, and asks the host to kill
// everything stamped otherwise. Deliberately at STARTUP rather than on the
// next arm: the orphans exist whether or not this page ever turns code
// intelligence on, and the whole point is that nobody is coming back for them.
//
// This module stays tiny and importable from the app-start path on purpose.
// `lib/lsp/host` is forbidden there (`lib/mainChunkGuard.test.ts`) because it
// drags in the whole LSP client, and the reap must not wait for a lazy chunk
// that a session which never opens an editor would never load.

import { invoke } from "@tauri-apps/api/core";

/** This page load. Not persisted anywhere: a reload MUST produce a new one,
 *  which rules out sessionStorage (it survives exactly the event we are
 *  detecting) and localStorage twice over. */
export const LSP_PAGE_ID: string =
  globalThis.crypto?.randomUUID?.() ?? `page-${Math.random().toString(36).slice(2)}`;

/**
 * Kill every language server started by an earlier page load.
 *
 * Returns how many were reaped, which is only used for a log line and by the
 * test. Never throws: a failure here must not take app start with it, and the
 * worst case is the leak we already had.
 */
export async function reapOrphanedServers(): Promise<number> {
  try {
    return await invoke<number>("lsp_reap_foreign", { page: LSP_PAGE_ID });
  } catch {
    return 0;
  }
}

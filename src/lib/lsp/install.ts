// Asking what can serve a language, and downloading it (GH #174).
//
// Deliberately separate from `host.ts`: the chip that OFFERS code intelligence
// lives in the main chunk, and host.ts imports `@codemirror/lsp-client` and
// everything behind it. Importing one from the other put the whole client on
// the app-start path, which `lib/mainChunkGuard.test.ts` exists to catch and
// did. These are plain `invoke` wrappers with no CodeMirror in sight.

import { invoke } from "@tauri-apps/api/core";
import { serverChoiceFor } from "./serverChoice";
import { projectForCheckout } from "@/store/codeIntel";
import { useApp } from "@/store/app";

export interface LspOffer {
  /** Resolved executable, when the machine already has one. */
  exe: string | null;
  /** What termic would download when it does not, e.g. "ty 0.0.73". */
  installLabel: string | null;
  installBytes: number | null;
  /** Something about this checkout that will make the answers look broken,
   *  said before the user concludes the feature is (a Django project with no
   *  django-stubs, today). Null when there is nothing to warn about. */
  caveat: string | null;
}
/** What can be offered for a language at this checkout: something already
 *  present, a pinned download, or nothing. */
export const lspOffer = (root: string, language: string) => {
  // The choice rides along, because the offer has to describe the process that
  // will ACTUALLY start: naming one server while another runs is the mistake
  // rule 1 in docs/lsp.md exists for. Resolved here rather than at each of the
  // five call sites, so none of them can forget.
  const { server, command } = choiceForRoot(root, language);
  return invoke<LspOffer>("lsp_offer", { root, language, preferred: server, custom: command });
};

/** The project-then-machine choice for a checkout. */
export function choiceForRoot(root: string, language: string) {
  const app = useApp.getState();
  return serverChoiceFor(projectForCheckout(app.tasks, app.projects, root), language);
}

/** Download + verify + unpack the pinned server. Idempotent. */
export const lspInstall = (language: string) =>
  invoke<string>("lsp_install", { language });


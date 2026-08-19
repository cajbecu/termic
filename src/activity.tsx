// Boot for the Activity window. Deliberately tiny: the monitor's own
// webview is a second WebContent process, and everything imported here is
// resident memory charged to a tool whose job is reporting resident memory.
//
// Importing the prefs store is what paints the window in the user's theme
// (it applies the persisted palette's CSS vars at module load).
import "@/lib/lsMigration";
import { createRoot } from "react-dom/client";
import "./index.css";
import "@/store/prefs";
import { ActivityWindow } from "@/components/activity/ActivityWindow";

// Same reasoning as the main window: no browser context menu in an app window.
window.addEventListener("contextmenu", e => e.preventDefault());

// Automation/e2e hook. The Activity window is a second webview, so the main
// window's `window.__termic` is not reachable from here; specs that drive
// this window need their own handle to the sampler IPC.
if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
  void (async () => {
    const ipc = await import("@/lib/ipc");
    (window as unknown as Record<string, unknown>).__termicActivity = { ipc };
  })();
}

createRoot(document.getElementById("root")!).render(<ActivityWindow />);

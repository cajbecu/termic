import { Store } from "./models";

// A type error on purpose: proves diagnostics still reach the editor.
export const wrong: Store = 42;

// An undefined name on purpose.
export const missing = thisNameDoesNotExist;

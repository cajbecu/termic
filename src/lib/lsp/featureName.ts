// What this feature is CALLED, which depends on what it is currently doing.
//
// With type checking off (the default), the whole feature is go-to-definition,
// find-usages, an outline and hover types. That is code navigation, and
// calling it "code intelligence" oversells it: the reader goes looking for the
// checker half and finds a switch they have not turned on. With type checking
// on it really is more than navigation, and the name says so.
//
// One function rather than a constant, because the name appears in six places
// (settings, the chip, two confirms, the project section, the nav hint) and
// six copies that drift is exactly how a feature ends up with two names.

import { diagnosticsEnabled } from "./diagnosticsPref";

/** Title case, for a heading or a label. */
export function codeIntelName(typeChecking: boolean): string {
  return typeChecking ? "Code intelligence" : "Code navigation";
}

/** Mid-sentence ("turn on code navigation"). */
export function codeIntelNameLower(typeChecking: boolean): string {
  return typeChecking ? "code intelligence" : "code navigation";
}

/** For code that cannot read the prefs store: the CodeMirror extensions run
 *  outside React, and `prefs.ts` touches the DOM at import time, which is why
 *  `diagnosticsPref` mirrors this one value out of the store in the first
 *  place. */
export function currentCodeIntelName(): string {
  return codeIntelName(diagnosticsEnabled());
}

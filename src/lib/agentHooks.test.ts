import { describe, it, expect } from "vitest";
import {
  HOOK_OSC_BODY,
  HOOK_OSC_TITLE,
  hookOscSequence,
  hookOscPayload,
  hookOscHandlerData,
  parseNotifyBody,
  CLAUDE_TERMINAL_SEQUENCE_ALLOWLIST,
} from "@/lib/agentHooks";
import { notificationWantsAttention, BUILTIN_NOTIFY_IGNORE } from "@/lib/agents";

// The whole feature is one OSC sequence surviving one filter. If the body ever
// starts matching claude's ignore list, the hook keeps firing perfectly and
// termic silently drops it: no error, no log, just the old false "done" back.
// These tests are the only thing standing between that and a release.

describe("agent hook OSC sequence", () => {
  it("survives the notification filter it has to pass", () => {
    expect(notificationWantsAttention("claude", HOOK_OSC_BODY, [])).toBe(true);
  });

  it("does not match claude's ignore list", () => {
    // claude sends "is waiting for your input" 60s after EVERY unanswered turn,
    // which is why that phrase is ignored. Our body must not collide with it.
    for (const pattern of BUILTIN_NOTIFY_IGNORE.claude ?? []) {
      expect(new RegExp(pattern).test(HOOK_OSC_BODY)).toBe(false);
    }
    expect(HOOK_OSC_BODY).not.toContain("is waiting for your input");
  });

  it("parses back to exactly the body the filter sees", () => {
    // The end-to-end chain: what the hook writes -> what xterm hands the
    // handler -> what notifyAttention filters. Pinning only the constant would
    // miss a change to the sequence's shape.
    const data = hookOscHandlerData(); // exactly what xterm gives the handler
    expect(parseNotifyBody(data)).toBe(HOOK_OSC_BODY);
    expect(notificationWantsAttention("claude", parseNotifyBody(data)!, [])).toBe(true);
  });

  it("uses an OSC id claude is willing to write", () => {
    // Outside the allowlist the sequence is dropped with no error at all.
    expect(CLAUDE_TERMINAL_SEQUENCE_ALLOWLIST).toContain(777);
    expect(hookOscPayload().startsWith("777;notify;")).toBe(true);
    // Raw control bytes in source are how the sequence got mangled once
    // already, so pin that the wrapper uses real ESC/BEL and nothing else does.
    expect(hookOscSequence()).toBe(`\x1b]${hookOscPayload()}\x07`);
    expect(hookOscPayload()).not.toMatch(/[\x00-\x1f]/);
  });

  it("keeps the title and body in separate fields", () => {
    // `notify` handlers take parts[1] as the title and the REST as the body, so
    // a semicolon in the body is fine but the title must stay one field or the
    // body silently shifts.
    expect(HOOK_OSC_TITLE).not.toContain(";");
    expect(parseNotifyBody(hookOscHandlerData("multi;part;body"))).toBe("multi;part;body");
  });

  it("ignores an OSC 777 that is not a notify", () => {
    expect(parseNotifyBody("something;else")).toBeNull();
  });

  // The failure this catches is the nastiest kind: everything keeps working
  // except the feature, with no error anywhere. A user who teaches termic what
  // their agent says when it needs them sets an `attention` list, and that list
  // is an ALLOW-LIST, so our body stops matching and the hook is dropped.
  // `TerminalPane` therefore trusts OSC 777 by its TITLE field, not its body.
  // Found by the e2e fixture, which seeds exactly such a list for fakeagent.
  it("would be filtered out by a user's attention allow-list, hence the title", () => {
    const withAllowList = [{
      id: "claude", display_name: "claude", command: "claude", args: [],
      icon_id: "claude", color: "#000", builtin: true,
      capabilities: { signals: { attention: ["needs your permission"] } },
    }] as unknown as Parameters<typeof notificationWantsAttention>[2];

    expect(notificationWantsAttention("claude", HOOK_OSC_BODY, withAllowList)).toBe(false);
    // ...which is exactly why the sender is identified by the title field.
    expect(hookOscPayload().split(";")[2]).toBe(HOOK_OSC_TITLE);
  });

  it("is stable, because the Rust side pins the same literal", () => {
    // agent_hooks::script_body() writes this exact text. Changing it here
    // without changing it there produces a hook that fires and does nothing.
    expect(HOOK_OSC_BODY).toBe("agent needs your input");
    expect(HOOK_OSC_TITLE).toBe("termic");
  });
});

/*
 * cmd:"agent" (the phone's "+") opens the new window into the session the
 * phone's mirror is grouped with, not into whichever socket last swept.
 *
 * `lastTmuxTarget()` is module-global — set by whichever socket last had a
 * frame resolved, desk or phone, so with both open it can be the OTHER
 * client's target. For a phone specifically it is also the wrong KIND of
 * answer even on its own connection — it is the mirror's own name
 * (`agx-phone-<n>-…`), which `engineWindowRunning` refuses, falling back to a
 * session named after the repo. Measured: a desk session named anything but
 * the repo's basename (renamed by hand, or already holding windows of several
 * repos — both ordinary) left the new window in a session the phone had never
 * heard of, and the phone dropped to "Nothing open".
 *
 * `PhoneAttach.sessionId` is the $id tmux actually grouped the mirror onto, so
 * it survives a rename that `lastTmuxTarget()` cannot; `sessionNameOf` turns
 * that id into the name a session-targeting tmux command needs.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();

describe("the agent command's target session", () => {
  test("resolves the phone's real session before falling back to the last sweep", () => {
    const at = src.indexOf('if (msg.cmd === "agent") {');
    const body = src.slice(at, src.indexOf('if (msg.cmd === "selectpane")', at));
    expect(body).toContain("sessionNameOf(target.socket, at.sessionId)");
    // The phone's own answer wins; `lastTmuxTarget()` is only what is left
    // once that one has nothing (no phone attach, or its session is gone).
    const phone = body.indexOf("sessionNameOf(target.socket, at.sessionId)");
    const fallback = body.indexOf("lastTmuxTarget()?.session");
    expect(phone).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(phone);
  });
});

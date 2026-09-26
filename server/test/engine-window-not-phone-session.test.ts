/*
 * A window opened for a phone must not be made INTO the phone's mirror session.
 *
 * `lastTmuxTarget().session` is whatever client a terminal last attached with,
 * and for a phone that is its mirror (`agx-phone-<n>-<id>`). Handed to the
 * engine as the session to open a window in, it made a session of that name on
 * the ENGINE's server — one the phone is not attached to, and one the mirror
 * reaper is entitled to remove. Measured: two presses of New window left two
 * windows in `agx-phone-0-…` on the engine, none on the phone's tmux, and the
 * phone fell to "Nothing open" with no sentence saying why.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/tmuxpane.ts", import.meta.url)).text();
const start = src.indexOf("export async function engineWindowRunning(");
const fn = src.slice(start, src.indexOf("\n}\n", start));

describe("engineWindowRunning", () => {
  test("ignores a session name that is a phone's mirror", () => {
    const named = fn.slice(fn.indexOf("const namedSession"), fn.indexOf("\n", fn.indexOf("const namedSession")));
    expect(named).toContain("agx-phone-");
  });
});

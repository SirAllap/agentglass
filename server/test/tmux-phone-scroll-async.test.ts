/*
 * A phone's scroll burst must not block the server loop on tmux: the scroll
 * runs through `tmuxAsync` and a burst collapses to one pending request.
 */
import { describe, expect, test } from "bun:test";

const ctl = await Bun.file(new URL("../src/tmuxctl.ts", import.meta.url)).text();

/** A function's own text: from its signature to its closing brace at column 0, comments stripped. */
function body(sig: string): string {
  const a = ctl.indexOf(sig);
  expect(a).toBeGreaterThan(0);
  const end = ctl.indexOf("\n}\n", a);
  return ctl.slice(a, end + 3).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("scrollPhonePane stays off the server loop", () => {
  const entry = body("export function scrollPhonePane(");
  const work = body("async function scrollPhonePaneOnce(");
  test("the work uses tmuxAsync and never the sync tmux()", () => {
    expect(work).toContain("tmuxAsync(");
    expect(work).not.toMatch(/(?<![\w.])tmux\(/);
    expect(entry).not.toMatch(/(?<![\w.])tmux\(/);
  });
  test("a burst coalesces into one pending slot per phone session", () => {
    expect(entry).toContain("scrollFlight");
    expect(entry).toContain("slot.pending");
    expect(entry).toContain("pending.by +=");
  });
});

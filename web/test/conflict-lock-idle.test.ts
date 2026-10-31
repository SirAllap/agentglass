/*
 * "Claude Code is working in conflict-518" stayed up, with Resolve conflicts
 * disabled, after the session had resolved the merge, pushed and stopped: the
 * window is still open, and open was the whole test.
 *
 * Working is not open. The server marks a window whose agent ended its turn
 * `idle`, a status frame is what tells the card to ask again, and the lock is
 * only for a window that is not idle. There is no renderer, so the rules are
 * asserted against the source they live in.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");
const hook = code(await read("../src/lib/liveWindow.ts"));
const pr = code(await read("../src/components/PrPanel.tsx"));
const index = code(await read("../../server/src/index.ts"));

describe("the lock follows the agent, not the window", () => {
  test("a status change asks again, with no timer", () => {
    const at = hook.indexOf("export function noteWindowSet(");
    expect(at).toBeGreaterThan(-1);
    const fn = hook.slice(at, hook.indexOf("\n}\n", at));
    expect(fn).toContain("w.status");
    expect(hook).not.toMatch(/setInterval/);
  });

  test("the card locks only on a window that is not idle", () => {
    expect(pr).toContain("const live = openWin && !openWin.idle ? openWin : null;");
  });

  test("the server says idle for an agent that ended its turn", () => {
    const at = index.indexOf('"/terminal/tmux/live-window"');
    expect(at).toBeGreaterThan(-1);
    const route = index.slice(at, index.indexOf("\n    }\n", at));
    expect(route).toContain("paneStatus(w.paneId)");
    for (const s of ['"idle"', '"done"', '"error"']) expect(route).toContain(s);
    expect(route).not.toContain('"working"');
  });
});

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

/** runAction runs on every tab click. A sync tmux spawn in it holds the server
 *  loop for up to 14 spawns per click, so it must use tmuxAsync only. */
test("runAction uses tmuxAsync and never the sync tmux(", () => {
  const src = readFileSync(new URL("../src/tmuxctl.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function runAction(");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  expect(body).toContain("await tmuxAsync(");
  expect(body).not.toMatch(/(?<![\w.])tmux\(/);
  // the sync helpers have async twins; none of them may come back
  expect(body).not.toMatch(/(?<![\w.])(windowOnSocket|closePopup|outerClientTty|unzoomWindow|clearSizeMark)\(/);
});

const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("action and status hide/show share ONE per-session chain", () => {
  const src = read("tmuxctl.ts");
  expect(src).toContain("const sessionChains = new Map");
  expect(src).not.toMatch(/\b(actionChains|statusChains)\b/);
  expect((src.match(/new Map<string, Promise<unknown>>\(\)/g) ?? []).length).toBe(1);
  expect((src.match(/sessionChains\.set\(/g) ?? []).length).toBe(2);
  expect(src).toMatch(/runActionInOrder[\s\S]*?console\.warn/);
});

test("after-action refresh skips a dead session and logs rejections", () => {
  const src = read("terminal.ts");
  const i = src.indexOf("void runActionInOrder(");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  expect(body).toMatch(/s\.closed \|\| s\.cleaned \|\| !sessions\.has\(ws\)/);
  expect(body.indexOf("s.closed")).toBeLessThan(body.indexOf("s.tmuxSweep?.()"));
  expect(body).toMatch(/\.catch\(\(e\) => console\.warn/);
});

import { afterEach, expect, test } from "bun:test";
import { onPaneDirsChanged, pokePaneDirs, pokePaneDirsFallback } from "../src/panedirspush.ts";

afterEach(() => onPaneDirsChanged(null));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a burst of tmux path/window notifications is one push", async () => {
  let n = 0;
  onPaneDirsChanged(() => { n++; });
  pokePaneDirs(20); pokePaneDirs(20); pokePaneDirs(20);
  await wait(80);
  expect(n).toBe(1);
  pokePaneDirs(20);
  await wait(80);
  expect(n).toBe(2);
});

test("no listener, no throw", async () => {
  pokePaneDirs(5);
  await wait(30);
});

test("the tmux sidecar's change event pokes it, and index broadcasts it", async () => {
  const term = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
  expect(term).toContain('if (ev === "change") pokePaneDirs();');
  const idx = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  expect(idx).toContain('onPaneDirsChanged(() => broadcast({ type: "panedirs" }));');
});

test("fallback poll (sidecar down) pokes at most every 4 s; down pokes once; poll gates on alive()", async () => {
  expect(pokePaneDirsFallback(100000)).toBe(true);
  expect(pokePaneDirsFallback(100500)).toBe(false);
  expect(pokePaneDirsFallback(103999)).toBe(false);
  expect(pokePaneDirsFallback(104000)).toBe(true);
  const term = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
  expect(term).toContain("!session.tmuxWatch?.alive()) pokePaneDirsFallback();");
  expect(term).toMatch(/ev === "down"\) \{[\s\S]*?pokePaneDirs\(\);/);
});

test("a tmux-only session (no engine watch expected) does not poke from the fallback", async () => {
  const term = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
  expect(term).toContain("if (session.onEngine && session.tmuxWatchOn && !session.tmuxWatch?.alive()) pokePaneDirsFallback();");
  expect(term).not.toContain("(session.tmux || session.onEngine) && !session.tmuxWatch?.alive()) pokePaneDirsFallback");
});

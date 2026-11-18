/*
 * The three costliest recurring timers in the 2026-11-13 timers audit are gone.
 *
 * - GitPanel re-read the working tree every 2.5s, and each tick forked
 *   `git status` on the server's main thread (the server freeze cause), hidden
 *   window or not. An agent's file edit pushes nothing (no server write, no
 *   working-tree watcher), so the tree keeps a 5s poll, but only through
 *   usePoll, which ticks on a visible and focused window (poll-while-looking
 *   test) and re-reads at once on return. A `git` frame lost while the socket
 *   was down is replayed by gitChanged() on reconnect.
 * - FindBar ran a rAF loop reading layout every frame while an anchor existed,
 *   open or not. It now listens to the events that move the anchor (resize of
 *   it, its parent or the page; scroll; transition and animation end), and
 *   only while open.
 * - The header's power button asked every 5s for the life of the app while
 *   electron/power.js already knew each change. power.js now pushes it.
 * A rule about source is asserted against source.
 */
import { expect, test } from "bun:test";
import { isLooking, shouldPollNow } from "../src/lib/usePoll.ts";

const read = (p: string) => Bun.file(new URL(`../../${p}`, import.meta.url)).text();
/** Source without its comment lines, so a word in prose is not a call. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("GitPanel re-reads the tree an agent edits, only while the window is looked at", async () => {
  const git = code(await read("web/src/components/GitPanel.tsx"));
  // An Edit/Write by an agent is no server write: only a poll can see it.
  expect(git).toContain("usePoll(active && !!root && !busy, () => loadTree(root), TREE_POLL_MS);");
  expect(git).toContain("const TREE_POLL_MS = 5_000;");
  expect(git).toContain("subscribeGitChanged(");
  // usePoll is the gate: no tick on a hidden or blurred window, one on return.
  const poll = code(await read("web/src/lib/usePoll.ts"));
  // GitPanel polls through usePoll, which polls through pollWhileLooking, which
  // ticks only when the pure rule says looked-at. Assert the rule itself.
  expect(poll).toContain("return pollWhileLooking(() => saved.current(), ms);");
  expect(poll).toContain("const looking = () => isLooking(document.hidden);");
  expect(isLooking(true)).toBe(false); // hidden tab
  expect(isLooking(false)).toBe(true); // visible, even if blurred
  expect(shouldPollNow(false, true)).toBe(true); // one tick on return
  expect(shouldPollNow(true, true)).toBe(false);
  expect(shouldPollNow(false, false)).toBe(false);
  // A push missed while the socket was down is replayed on reconnect.
  const live = code(await read("web/src/lib/useLive.ts"));
  expect(live).toMatch(/ws\.onopen = \(\) => \{[\s\S]*?gitChanged\(\);[\s\S]*?\n {4}\};/);
});

test("FindBar follows its anchor by the events that move it, never by a frame loop", async () => {
  const bar = code(await read("web/src/components/FindBar.tsx"));
  expect(bar).not.toMatch(/raf = requestAnimationFrame\(tick\)/);
  expect(bar).toContain("new ResizeObserver(read)");
  expect(bar).toContain("ro.observe(anchor.parentElement)");
  expect(bar).toContain('const moves = ["resize", "scroll", "transitionend", "animationend"] as const;');
  expect(bar).toContain("if (!anchor || !st.open) return;");
});

test("the power button is pushed, not polled", async () => {
  const header = code(await read("web/src/components/Header.tsx"));
  expect(header).not.toMatch(/usePoll\([^\n]*powerStatus/);
  expect(header).toContain("onPowerChanged(");
  const power = code(await read("electron/power.js"));
  expect(power).toMatch(/function sync\(\) \{[\s\S]*?notify\(\);\n\}/);
  const main = code(await read("electron/main.js"));
  expect(main).toContain('w.webContents.send("ag:power-changed", st)');
  const preload = code(await read("electron/preload.js"));
  expect(preload).toContain('ipcRenderer.on("ag:power-changed", h);');
});

test("2026-11-16: pill and sessions are backstops behind a push; the pane beat is a 60 s backstop behind the panedirs push", async () => {
  const term = code(await read("web/src/components/TerminalPanel.tsx"));
  expect(term).toContain("const PANE_BEAT_MS = 60_000;");
  expect(term).toContain("}, PANE_BEAT_MS);");
  expect(term).toContain("subscribeGitChanged(() => { wtRunRef.current?.(); fillRef.current?.(); })");
  expect(term).toContain("subscribeGitChanged(readPill)");
  expect(term).toContain("subscribePaneDirsChanged(() => { wtRunRef.current?.(); fillRef.current?.(); })");
  expect(code(await read("web/src/lib/useLive.ts"))).toContain('if (frame.type === "panedirs") { paneDirsChanged(); return; }');
  const pulse = code(await read("web/src/lib/repoPulse.ts"));
  expect(pulse).toContain("export const PILL_POLL_MS = 20_000;");
  const app = code(await read("web/src/App.tsx"));
  expect(app).toContain("const SESSIONS_POLL_MS = 120_000;");
  expect(app).toContain("usePoll(true, () => { void loadSessions(); }, SESSIONS_POLL_MS);");
  expect(app).toContain("if (unnamedLive > 0) void loadSessions();");
});

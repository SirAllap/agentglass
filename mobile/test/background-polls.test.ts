/*
 * What the phone asks for while it is in a pocket.
 *
 * `POLL_MS` stopped when the app left the foreground and the pull-request pass
 * did not (21 requests in ten minutes at three repositories, all identical), and
 * the terminal tab's two second read stopped only when the tab lost focus, not
 * when the phone locked. There is no renderer here, so the rule is asserted
 * against source, with comments stripped so prose is not mistaken for a call.
 */
import { expect, test } from "bun:test";

const src = async (p: string) => (await Bun.file(new URL(`../${p}`, import.meta.url)).text())
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const host = await src("src/state/host-context.tsx");
const terminal = await src("app/(tabs)/terminal.tsx");
const prs = await src("app/(tabs)/prs.tsx");
const talk = await src("src/state/pr-talk.ts");

test("the pull-request pass runs only in the foreground and catches up on return", () => {
  expect(host).toMatch(/setInterval\(\(\) => \{ if \(AppState\.currentState === "active"\) void loadPrs\(host\); \}, SLOW_POLL_MS\)/);
  expect(host).toContain("if (Date.now() - prsAt.current >= SLOW_POLL_MS) void loadPrs(host);");
});

test("the terminal tab's pane read follows AppState as well as focus", () => {
  expect(terminal).toMatch(/if \(busy \|\| AppState\.currentState !== "active"\) return;\s*busy = true;\s*void load\(true\)\.finally\(\(\) => \{ busy = false; \}\);\s*\}, 2000\)/);
});

test("the dirty dot's read is foreground-only and never stacks", () => {
  expect(terminal).toMatch(/if \(busy \|\| AppState\.currentState !== "active"\) return;\s*busy = true;\s*void look\(\)\.finally/);
  expect(terminal).toContain("setInterval(tick, 4000)");
});

test("the queue's pass and the Pull requests tab read the same lists through one memo", () => {
  expect(host).toContain("askCached<{ repos: GitRepoRef[] }>(which, \"/git/repos\"");
  expect(prs).toContain("askCached<{ repos: GitRepoRef[] }>(host, \"/git/repos\", PR_READ_TTL_MS)");
  /* Opening the tab reads through the memo; a refresh, a tick and the loading re-ask go past it. */
  expect(prs).toContain("PR_READ_TTL_MS, force)");
  expect(prs).toContain("void load(true).finally");
  expect(prs).toContain("loadFresh = useCallback(() => load(true), [load])");
});

test("a burst of talk ticks reloads once, after it goes quiet", () => {
  expect(talk).toContain("RELOAD_QUIET_MS");
  expect(talk).toContain("setTimeout(() => { timer.current = null; void latest.current(); }, RELOAD_QUIET_MS)");
  expect(talk).not.toMatch(/if \(was\.scope !== scope \|\| was\.tick === tick\) return;\s*void reload\(\)/);
});

/*
 * The always-on pollers ask only while somebody is looking at the window.
 *
 * A desktop window never becomes `document.hidden`, so a plain setInterval keeps
 * asking for as long as the window exists: measured with the window unfocused,
 * the palette, the session list, the reminders, the machine panel, the terminal's
 * pane-dirs and the switcher together sent 100+ requests a minute for nobody.
 * `usePoll` / `pollWhileLooking` gate on focus and refresh at once on return.
 * A rule about source is asserted against source; the gate itself is run in
 * web/test/poll-while-looking.test.ts.
 */
import { expect, test } from "bun:test";

const web = (p: string) => Bun.file(new URL(`../../web/src/${p}`, import.meta.url)).text();
const themes = await web("lib/themes.ts");
const reminders = await web("lib/reminderStore.ts");
const gates = await web("lib/gateStore.ts");
const app = await web("App.tsx");
const terminal = await web("components/TerminalPanel.tsx");
const machine = await web("components/MachinePanel.tsx");
const switcher = await web("components/terminal/WindowSwitcher.tsx");
const peek = await web("components/PeekFile.tsx");
const stats = await web("lib/useStats.ts");
const dash = await web("components/DashboardView.tsx");
const browser = await web("components/BrowserPanel.tsx");

/** Source without its comment lines, so a word in prose is not a call. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the reminder and session polls go through the focus gate, and the palette has no poll at all", () => {
  /* The palette is pushed by the server (web/test/desktop-palette-follow.test.ts). */
  expect(code(themes)).not.toMatch(/pollWhileLooking|setInterval/);
  expect(code(reminders)).toContain("pollWhileLooking(");
  expect(code(reminders)).not.toContain("setInterval(");
  expect(code(app)).toMatch(/usePoll\(true, \(\) => \{ void loadSessions\(\); \}, 30_000\)/);
  expect(code(app)).not.toMatch(/setInterval\(load, 30_000\)/);
});

test("the machine panel, the terminal's pane reads and the switcher use usePoll, not setInterval", () => {
  expect(code(machine)).not.toContain("setInterval(");
  expect((code(machine).match(/usePoll\(true, load, POLL_MS\)/g) ?? []).length).toBe(3);
  expect(code(switcher)).not.toContain("setInterval(");
  expect(code(switcher)).toContain("usePoll(open");
  /* One timer for both terminal reads, not two 4 s intervals. */
  expect(code(terminal)).not.toMatch(/setInterval\([^)]*4000\)/);
  expect(code(terminal)).toContain("usePoll(open, () => { wtRunRef.current?.(); fillRef.current?.(); }, 4000)");
});

test("the dashboard's stats and facet polls go through usePoll", () => {
  expect(code(stats)).toContain("usePoll(enabled, load, every)");
  expect(code(stats)).not.toContain("setInterval(");
  expect(code(dash)).toContain("usePoll(active, () => { void loadOpts(); }, 20_000)");
});

test("the browser panel hands each webview ONE ref callback, not a new one per render", () => {
  expect(code(browser)).toContain("ref={bindRef(t.id)");
  expect(code(browser)).not.toMatch(/ref=\{bind\(t\.id\)/);
  expect(code(browser)).toContain("refCache.current.get(id)");
});

test("the cursor poll stops for an unfocused window and slows when the cursor rests", () => {
  const body = code(peek);
  expect(body).toContain("document.hasFocus()");
  expect(body).toContain("CURSOR_SLOW_MS");
  expect(body).not.toContain("setInterval(ask, 450)");
});

test("the gate list is a safety-net poll now that every change is pushed", () => {
  const ms = Number(/const POLL_MS = ([\d_]+)/.exec(gates)?.[1]?.replace(/_/g, ""));
  expect(ms).toBeGreaterThanOrEqual(20_000);
});

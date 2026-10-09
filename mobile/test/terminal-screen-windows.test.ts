/*
 * The terminal screen, read as source: the strip, the keys and the sheets.
 *
 * There is no renderer in this project, so a rule about what the screen draws
 * is asserted against the file that draws it — comments stripped first, so the
 * prose explaining a removed thing cannot be what keeps a test green.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const code = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const screen = code("../app/(tabs)/terminal.tsx");

describe("the window strip", () => {
  test("names a window without tmux's index, and is 52 tall", () => {
    expect(screen).toMatch(/\{tab\.name\}<\/Text>/);
    expect(screen).not.toMatch(/\{tab\.label\}/);
    expect(screen).toMatch(/minHeight: 52/);
  });

  test("shows a status dot on every window and is only the open window's project", () => {
    expect(screen).toMatch(/<StatusDot dot=\{dot\}/);
    expect(screen).toMatch(/const tabs = stripFor\(all, open\)/);
    // The old filter, by tmux session, is what this replaced.
    expect(screen).not.toMatch(/t\.session === session/);
  });

  test("has Files and Source control fixed beside it, and a dot for a dirty checkout", () => {
    expect(screen).toMatch(/pathname: "\/files", params: \{ root: open\.where \}/);
    expect(screen).toMatch(/pathname: "\/repos", params: \{ root: open\.where \}/);
    expect(screen).toMatch(/\{dirty \? \(/);
    expect(screen).toMatch(/"\/git\/status"/);
  });

  test("the title is the project and the line under it counts windows and needs-you", () => {
    expect(screen).toMatch(/\{open \? groupOf\(open\) : "Terminal"\}/);
    expect(screen).toMatch(/subline\(tabs, asking\)/);
  });

  test("the title opens the grouped switcher, not a flat list of sessions", () => {
    expect(screen).toMatch(/<WindowSwitcher/);
    expect(screen).not.toMatch(/title="Sessions"/);
  });
});

describe("the keys", () => {
  test("are a thumb wide and tall, the arrows too", () => {
    expect(screen).toMatch(/minWidth: TAP,/);
    expect(screen).not.toMatch(/minWidth: key\.narrow/);
    expect(screen).not.toMatch(/minHeight: 40/);
  });

  test("end in a fixed ⋯ that opens All keys, and the tip speaks while a modifier waits", () => {
    expect(screen).toMatch(/accessibilityLabel="All keys"/);
    expect(screen).toMatch(/<AllKeysSheet/);
    expect(screen).toMatch(/armedTip\(latched\)/);
  });

  test("the composer's controls are the floor as well", () => {
    // image, mic, send: width and height together, three of them.
    expect(screen.match(/width: TAP, height: TAP/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("when the computer has nothing, or does not answer", () => {
  test("Look again shows it is looking, then says it found nothing", () => {
    expect(screen).toMatch(/label="Look again"\s+busy=\{looking\}/);
    expect(screen).toMatch(/Still nothing/);
  });

  test("the new-window picker says when /terminal/agents failed, and can ask again", () => {
    expect(screen).toMatch(/setAgentsFailed\(true\)/);
    expect(screen).toMatch(/label="Try again"/);
    // The Shell row needs no agent list, so it is not behind one.
    expect(screen).not.toMatch(/agents === null \? \(\s*<Note>Asking the computer which agents it has…<\/Note>\s*\) : \(/);
  });
});

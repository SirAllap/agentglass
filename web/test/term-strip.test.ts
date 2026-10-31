/*
 * The Terminal strip, as source. The panel mounts xterm and a socket, so what
 * can be pinned is where each behaviour lives now that the strip is its own
 * file; the decisions themselves (zones, marks, Go list, prefix) are modules
 * with their own tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url).pathname, "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");
const panel = code(read("components/TerminalPanel.tsx"));
const strip = code(read("components/terminal/TermStrip.tsx"));
const tab = code(read("components/terminal/WindowTab.tsx"));
const go = code(read("components/terminal/GoList.tsx"));
const switcher = code(read("components/terminal/SessionSwitcher.tsx"));
const chrome = read("components/workspace/Chrome.tsx");

describe("the prefix halo has no clock", () => {
  test("no timer, no expiry: the armed flag is the module's answer", () => {
    expect(panel).not.toContain("PREFIX_MS");
    expect(panel).not.toContain("tmuxPrefixAt");
    expect(panel).not.toContain("prefixLive");
    expect(panel).toContain("prefixStep(sess.tmuxPrefixArmed, { type: \"key\", data: d }, sess.tmuxPrefix)");
  });

  test("a click disarms it", () => {
    expect(panel).toContain('prefixStep(true, { type: "pointer" }, sess.tmuxPrefix)');
    expect(panel).toContain('document.addEventListener("pointerdown", disarm, true)');
  });

  test("armed: a halo on the strip edge, numbers in the tabs, a hint with the real prefix", () => {
    expect(panel).toContain("prefixArmed={prefixArmed}");
    expect(strip).toContain("armed={p.prefixArmed}");
    expect(strip).toContain("1-9 window · c new · Esc");
    expect(strip).toContain("{p.session.prefix[0] ??");
    expect(strip).toContain("const showNumbers = alt || p.prefixArmed;");
  });
});

describe("the strip's frame", () => {
  test("24 px controls are a named rung of the kit, and the frame is the large one", () => {
    expect(chrome).toContain("strip: 24");
    expect(strip).toContain("height: CTRL_H.large");
    expect(tab).toContain("height: CTRL_H.strip");
  });

  test("the fallback shell strip and the barless row wear the same frame", () => {
    expect(panel.match(/<StripFrame/g)?.length).toBe(2);
    expect(panel).toContain("<TermStrip ");
  });

  test("TerminalPanel keeps the tmux door and hands it to the strip", () => {
    expect(panel).toContain("cmd={tmuxCmd}");
    expect(strip).not.toContain("ptyFrame");
  });

  test("left to right: project chip, divider, tabs with the + menu, the hint, need-you, the right slot", () => {
    const order = ["<ProjectChip", 'role="tablist"', '<PlusButton', "1-9 window", "} you", "{p.right}"].map((s) => strip.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("old chips are gone: engine, prefix, session button", () => {
    expect(panel).not.toContain("ENGINE");
    expect(strip).not.toContain("engine</");
    expect(panel).not.toContain("setSessionMenu");
    expect(strip).not.toContain("SessionMenu");
  });
});

describe("windows", () => {
  test("middle-click closes, double-click renames, right-click opens the menu", () => {
    expect(tab).toContain("onAuxClick={(e) => { if (e.button === 1)");
    expect(tab).toContain("onDoubleClick={onStartRename}");
    expect(tab).toContain("onContextMenu=");
  });

  test("the close x shows on hover or on the lit tab, not on all of them", () => {
    expect(tab).toContain("group-hover:opacity-100");
    expect(tab).toContain('active ? "opacity-70" : "opacity-0"');
  });

  test("Alt held shows the numbers; Alt+1..9 selects through the same pick as a click", () => {
    expect(strip).toContain('if (e.key === "Alt") setAlt(true);');
    expect(strip).toContain("const n = altDigit(e);");
    expect(strip).toContain("onPick(id)");
    expect(panel).toContain("if (altDigit(e) && stripUp()) return false;");
  });

  test("the pick selects at once and gives the keyboard back to the pane", () => {
    expect(panel).toContain('tmuxCmd({ cmd: "select", window: id })');
    expect(panel).toContain("onPick={pickWindow}");
  });

  test("Ctrl+Alt+N and Ctrl+Shift+T answer through the strip's doors", () => {
    expect(strip).toContain("registerStripDoors({");
    const app = code(read("App.tsx"));
    expect(app).toContain('runStripChord("goList")');
    expect(app).toContain('runStripChord(action === "windows.waiting" ? "needYou" : "newShell")');
  });

  test("new shell: the + menu row and the chord send the same command", () => {
    expect(strip.match(/cmd\(\{ cmd: "new", root: p\.root, window: p\.focusWin \|\| undefined \}\)/g)?.length).toBe(1);
    expect(panel).toContain('tmuxCmd({ cmd: "new", root, window: focusWin || undefined })');
  });
});

describe("the Go list", () => {
  test("is driven by the strip's own windows and never polls", () => {
    expect(go).not.toContain("usePoll");
    expect(go).not.toContain("setInterval");
    expect(go).not.toContain("api.");
  });

  test("keys: arrows, Enter, Esc, and Alt+N inside it", () => {
    expect(go).toContain("moveSelection(");
    expect(go).toContain('e.key === "Enter"');
    expect(go).toContain('e.key === "Escape"');
    expect(go).toContain("altDigit(e.nativeEvent)");
  });

  test("the footer chip opens the quick switcher, which carries engine, prefix and the tmux-bar toggle", () => {
    expect(go).toContain("<SessionSwitcher");
    expect(switcher).toContain("Show tmux's own status line");
    expect(switcher).toContain("onUseTmuxBar");
    expect(strip).toContain("onUseTmuxBar={p.session.engine ? undefined : p.onUseTmuxBar}");
  });

  test("the Go list closes before the Manage sessions dialog opens, so one never sits under the other", () => {
    expect(go).toContain("onClose(); onManageSessions();");
    expect(strip).toContain("onManageSessions={() => setManageOpen(true)}");
  });
});

/*
 * The Terminal's new overlays, as source: the rules they must keep that no
 * renderer is here to check. Each was broken on purpose and seen red.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url).pathname, "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");
const OVERLAYS = ["PeekCard", "LatestOutputPill", "PlusButton", "CommandsPopover", "SessionSwitcher", "ManageSessions", "StripButtons"];
const src = Object.fromEntries(OVERLAYS.map((n) => [n, code(read(`components/terminal/${n}.tsx`))]));

describe("overlays never poll", () => {
  for (const n of OVERLAYS) {
    test(`${n} has no interval and no polling hook`, () => {
      expect(src[n]).not.toMatch(/setInterval\(|usePoll\(/);
    });
  }
  test("the peek's one timer is a single hover delay, cleared on leave", () => {
    expect(src.PeekCard.match(/setTimeout\(/g)?.length).toBe(1);
    expect(src.PeekCard).toContain("clearTimeout(");
  });
});

describe("overlays sit on the layer tokens", () => {
  for (const n of OVERLAYS) {
    test(`${n} has no literal zIndex`, () => {
      expect(src[n]).not.toMatch(/zIndex:\s*\d/);
    });
  }
  test("the peek card never takes the pointer", () => {
    expect(src.PeekCard).toContain("pointerEvents");
    expect(src.PeekCard).toContain("LAYER.menu");
  });
});

describe("Manage sessions is a real dialog", () => {
  const d = src.ManageSessions;
  test("modal semantics, drag-region opt-out, its own layer, Escape", () => {
    expect(d).toContain("useModalDialog(");
    expect(d).toContain("...modal");
    expect(d).toContain("NO_DRAG");
    expect(d).toContain("LAYER.termDialog");
    expect(d).toContain('"Escape"');
  });
  test("ending a session asks first, in the dialog", () => {
    expect(d).toContain("endSentence(");
    expect(d).toMatch(/cleanupSentence\(/);
  });
});

describe("the Latest-output pill", () => {
  test("follows the terminal's scroll event, not a timer", () => {
    expect(src.LatestOutputPill).toContain("term.onScroll(");
  });
  test("reduced motion jumps instead of easing", () => {
    expect(src.LatestOutputPill).toContain("data-reduce-motion");
  });
});

describe("the pinned pull requests popover", () => {
  const pins = code(read("components/PinList.tsx"));
  test("the button is always drawn and opens an anchored menu", () => {
    expect(src.StripButtons).not.toContain("return null");
    expect(src.StripButtons).toContain("<AnchoredMenu");
  });
  test("the Terminal asks for a repository header even over one repository, and an empty list says how to get a pin", () => {
    expect(src.StripButtons).toContain("grouped");
    expect(pins).toContain("grouped || groups.length > 1");
    expect(pins).toContain("Nothing pinned yet.");
  });
});

describe("the restore, close and state overlays", () => {
  const NEW = ["PaneCard", "PaneStates", "RestoreBanner", "CloseLayer", "TermOverlays"];
  const n = Object.fromEntries(NEW.map((f) => [f, code(read(`components/terminal/${f}.tsx`))]));
  for (const f of NEW) {
    test(`${f} has no interval, no literal zIndex and no native dialog`, () => {
      expect(n[f]).not.toMatch(/setInterval\(|usePoll\(|zIndex:\s*\d/);
      expect(n[f]).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\(/);
    });
  }
  test("the toast's one timer is the five-second hide, cleared on cleanup and paused while held", () => {
    expect(n.CloseLayer.match(/setTimeout\(/g)?.length).toBe(1);
    expect(n.CloseLayer).toContain("clearTimeout(");
    expect(n.CloseLayer).toContain("TOAST_MS = 5000");
    expect(n.CloseLayer).toContain("if (held) return;");
  });
  test("the close question is an alertdialog on the menu layer with Escape and focus on the safe button", () => {
    expect(n.CloseLayer).toContain('role="alertdialog"');
    expect(n.CloseLayer).toContain("<Portal z={LAYER.menu}>");
    expect(n.CloseLayer).toContain('"Escape"');
    expect(n.CloseLayer).toContain("keepBtn.current?.focus(");
  });
  test("the toast is a status, the banner is a status, a dead pane is an alert", () => {
    expect(n.CloseLayer).toContain('role="status"');
    expect(n.RestoreBanner).toContain('role="status"');
    expect(n.TermOverlays).toContain('role="alert"');
  });
  test("a card lets the scrollback behind it be scrolled", () => {
    expect(n.PaneCard).toContain("pointer-events-none");
    expect(n.PaneCard).toContain("pointer-events-auto");
  });
  test("what is remembered is read and written inside try/catch", () => {
    expect(n.TermOverlays).toMatch(/try \{ return localStorage\.getItem/);
    expect(n.TermOverlays).toMatch(/try \{ localStorage\.setItem/);
  });
  test("every way to close a window goes through the one door", () => {
    const strip = code(read("components/terminal/TermStrip.tsx"));
    expect(strip).not.toContain('cmd({ cmd: "kill"');
    expect(strip.match(/closeWindows\(/g)?.length).toBe(3);
    expect(strip).not.toContain("p.ask(");
  });
  test("Restart here and Resume are the server's commands, not text typed into the pane", () => {
    expect(n.TermOverlays).toContain('cmd: "restart"');
    expect(n.TermOverlays).toContain('cmd: "restored", how: "resume"');
  });
});

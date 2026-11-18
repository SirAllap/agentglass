/*
 * Output for a hidden terminal waits, in order, and is never dropped.
 *
 * The terminal view stays mounted while another view is on screen, and a box
 * hidden with `visibility` still counts as on screen to xterm: every byte an
 * agent printed was drawn, frame after frame, where nobody could see it. The
 * bytes now wait until the view is back. What is pinned here is the promise
 * that makes that safe: the same bytes, in the same order, with a ceiling on
 * how many are kept.
 */
import { describe, expect, test } from "bun:test";
import { HIDDEN_HOLD_MAX_BYTES, holdRelease, holdStart, holdTake, mayHoldWrites, newWriteHold, shouldHoldWrites } from "../src/lib/hiddenWrites.ts";

const panel = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join("");

describe("what is kept while the view is hidden", () => {
  test("on screen, a chunk goes straight through", () => {
    const h = newWriteHold();
    expect(text(holdTake(h, bytes("make test\r\n")))).toBe("make test\r\n");
    expect(h.bytes).toBe(0);
  });

  test("hidden, chunks wait and come back whole and in order", () => {
    const h = newWriteHold();
    holdStart(h);
    expect(holdTake(h, bytes("172 passed"))).toEqual([]);
    expect(holdTake(h, bytes(" in 3.1s\r\n"))).toEqual([]);
    expect(holdTake(h, bytes("$ "))).toEqual([]);
    expect(text(holdRelease(h))).toBe("172 passed in 3.1s\r\n$ ");
    // Released means on screen again: the next chunk does not wait.
    expect(text(holdTake(h, bytes("ls\r\n")))).toBe("ls\r\n");
    expect(holdRelease(h)).toEqual([]);
  });

  test("past the cap everything kept is handed back, and keeping goes on from empty", () => {
    const h = newWriteHold();
    holdStart(h);
    const big = new Uint8Array(HIDDEN_HOLD_MAX_BYTES);
    expect(holdTake(h, bytes("first "))).toEqual([]);
    const out = holdTake(h, big);
    expect(out.length).toBe(2);
    expect(text([out[0]!])).toBe("first ");
    expect(out[1]!.length).toBe(HIDDEN_HOLD_MAX_BYTES);
    expect(h.bytes).toBe(0);
    expect(h.holding).toBe(true);
    expect(holdTake(h, bytes("after"))).toEqual([]);
    expect(text(holdRelease(h))).toBe("after");
  });

  test("only a live shell with tmux in it, already drawn, may wait", () => {
    expect(mayHoldWrites({ tmux: true, drawn: true, status: "live" })).toBe(true);
    // No tmux: the terminal itself answers what a program asks it, and that answer cannot wait.
    expect(mayHoldWrites({ tmux: false, drawn: true, status: "live" })).toBe(false);
    expect(mayHoldWrites({ tmux: true, drawn: false, status: "live" })).toBe(false);
    expect(mayHoldWrites({ tmux: true, drawn: true, status: "connecting" })).toBe(false);
  });
});

describe("the panel writes through the hold, and lets go wherever the terminal must be current", () => {
  const body = (start: string, end = "\n}\n") => {
    const at = panel.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return panel.slice(at, panel.indexOf(end, at));
  };

  test("the shell's bytes have one way in", () => {
    expect(panel).toContain("writeOut(s, fitHold.active() ? guardFor(s).filter(bytes) : bytes);");
    expect(panel).toContain("if (held.length) try { writeOut(s, held); }");
  });

  test("a new socket, a closed one and a shell that ended all release first", () => {
    expect(body("function openSocket(s: Sess) {")).toContain("releaseHeld(s);");
    const close = body("  ws.onclose = () => {", "\n  };\n");
    expect(close.indexOf("releaseHeld(s);")).toBeGreaterThan(-1);
    expect(close.indexOf("releaseHeld(s);")).toBeLessThan(close.indexOf("maybeReconnect(s, wasLive);"));
    const ended = panel.indexOf("releaseHeld(s); // the note below goes after the shell's last output");
    expect(ended).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(panel.indexOf("— shell exited ("));
  });

  test("the view holds only while it is not the one on screen, and gives back when it is", () => {
    const hide = body("    if (!open) return;\n    const held: Sess[] = [];", "\n  }, [active, open, paneIds, focusIdx, windowHidden]);");
    expect(hide).toContain("shouldHoldWrites({ open, viewActive: active, canHold: mayHoldWrites(s)");
    expect(hide).toContain("s.holder.parentElement === el");
    expect(hide).toContain("return () => { for (const s of held) releaseHeld(s); };");
  });
});

describe("a shell off screen inside the shown view waits too", () => {
  const base = { open: true, viewActive: true, canHold: true, inOwnPane: false, inShownPane: false, holderAttached: false };
  test("shown view: in no pane and attached nowhere, it waits", () => {
    expect(shouldHoldWrites(base)).toBe(true);
  });
  test("shown view: in a pane, or lent to the console strip, it does not wait", () => {
    expect(shouldHoldWrites({ ...base, inShownPane: true })).toBe(false);
    expect(shouldHoldWrites({ ...base, holderAttached: true })).toBe(false);
  });
  test("shown view: a shell that may not wait never does", () => {
    expect(shouldHoldWrites({ ...base, canHold: false })).toBe(false);
  });
  test("hidden view: only the shell in its own pane waits", () => {
    expect(shouldHoldWrites({ ...base, viewActive: false, inOwnPane: true, inShownPane: true, holderAttached: true })).toBe(true);
    expect(shouldHoldWrites({ ...base, viewActive: false })).toBe(false);
  });
  test("a minimized window holds every shell that may wait, wherever it is", () => {
    expect(shouldHoldWrites({ ...base, inShownPane: true, windowHidden: true })).toBe(true);
    expect(shouldHoldWrites({ ...base, holderAttached: true, windowHidden: true })).toBe(true);
    expect(shouldHoldWrites({ ...base, viewActive: false, windowHidden: true })).toBe(true);
    // Still never a shell whose terminal must answer, nor a closed panel.
    expect(shouldHoldWrites({ ...base, canHold: false, windowHidden: true })).toBe(false);
    expect(shouldHoldWrites({ ...base, open: false, windowHidden: true })).toBe(false);
  });

  test("the panel follows the window being minimized and shown again", () => {
    expect(panel).toContain("const windowHidden = useSyncExternalStore(subscribeWindowHidden, windowIsHidden, () => false);");
    expect(panel).toContain("if (active || windowHidden) {");
    expect(panel).toContain('document.addEventListener("visibilitychange", fn);');
  });

  test("closed panel holds nothing", () => {
    expect(shouldHoldWrites({ ...base, open: false })).toBe(false);
  });
});

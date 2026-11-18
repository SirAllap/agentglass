/*
 * The desk should know a phone is attached to the window it is looking at.
 *
 * A phone attaches on a mirror session of its own (`agx-phone-<n>-<id>`), and
 * from the desk that client is invisible: same windows, same panes, and a
 * window that shrinks or a pane that scrolls with nobody touching it. The
 * frame already knows every session a client is on; what it did not know was
 * which WINDOW each of those sessions is showing, so the strip's chip counted
 * phones per session and appeared on every panel attached to that session.
 */
import { describe, expect, test } from "bun:test";
import { markPhoneWindows } from "../src/tmuxctl.ts";
import type { TmuxWindow } from "../../shared/types.ts";

const win = (id: string, active = false): TmuxWindow => ({ id, index: Number(id.slice(1)), name: id, active, flags: "" });

describe("marking the windows a phone is on", () => {
  test("only the windows in the answer carry the mark", () => {
    const windows = [win("@0", true), win("@1")];
    markPhoneWindows(windows, new Map([["@1", 1]]));
    expect(windows[0]!.phone).toBeUndefined();
    expect(windows[1]!.phone).toBe(true);
  });

  test("a phone that moved takes its old mark with it", () => {
    // The frame's window objects are shared between every client on a session
    // for the life of one read, so a mark from the previous sweep is still
    // there. Setting the new one without clearing the old marked both tabs.
    const windows = [win("@0"), win("@1", true)];
    markPhoneWindows(windows, new Map([["@0", 1]]));
    markPhoneWindows(windows, new Map([["@1", 1]]));
    expect(windows[0]!.phone).toBeUndefined();
    expect(windows[1]!.phone).toBe(true);
  });
});

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();

describe("where the count is sent", () => {
  test("the tmux frame carries `phones`, and it is part of the shape that triggers a send", () => {
    // Resolved once per frame read (readFrameSwept), no longer per desk per tick: see tmux-frame-swept.test.ts.
    expect(src).toContain("const phonesByWin = frame && swept ? swept.phones : new Map<string, number>();");
    expect(src).toContain("markPhoneWindows(windows, phonesByWin)");
    expect(src).toContain("const phones = activeWindowId ? phonesByWin.get(activeWindowId) ?? 0 : 0;");
    const shape = src.slice(src.indexOf("const shape = JSON.stringify(["));
    expect(shape.slice(0, shape.indexOf("\n"))).toContain("phones");
  });
});

const panel = await Bun.file(new URL("../../web/src/components/TerminalPanel.tsx", import.meta.url)).text();
const strip = await Bun.file(new URL("../../web/src/components/terminal/TermStrip.tsx", import.meta.url)).text();

describe("the panel", () => {
  test("reads the count off the frame and draws a chip only when it is above zero", () => {
    expect(panel).toContain('s.tmuxPhones = typeof f.phones === "number" ? f.phones : 0;');
    // The chip moved out of the panel into the strip; the panel now hands the count down as a prop.
    expect(panel).toContain("phones={sess?.tmuxPhones ?? 0}");
    expect(strip).toContain("p.phones > 0 &&");
    expect(strip).toContain("phone on this window");
  });
});

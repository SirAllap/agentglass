/*
 * The pane geometry the sweep now carries, and the filtering that keeps it
 * honest.
 *
 * This is what focus-follows-mouse steers by inside tmux, so a wrong row here
 * does not render wrong — it sends keystrokes to the wrong pane, or to a pane
 * in a window nobody is looking at. `list-panes -a` answers for the whole
 * server, so both filters below are load-bearing rather than tidy.
 *
 * The live half (running `select-pane` against a real tmux) is not here, for
 * the reason tmux-tabs.test.ts already gives: a test that spawns tmux is a test
 * that fails on a machine without it.
 */
import { describe, expect, test } from "bun:test";
import { parseFrame, parsePaneGeometry } from "../src/tmuxctl.ts";

/** One `p` row, as the sweep's format string produces it. */
const row = (o: {
  sid?: string; win?: string; winActive?: string; id: string;
  left?: number; top?: number; right?: number; bottom?: number; active?: string; zoomed?: string;
}) => [
  "p", o.sid ?? "$2", o.win ?? "@1", o.winActive ?? "1", o.id,
  String(o.left ?? 0), String(o.top ?? 0), String(o.right ?? 137), String(o.bottom ?? 65),
  o.active ?? "0", o.zoomed ?? "0",
].join("\t");

describe("the panes of the window on screen", () => {
  test("bounds, the active flag and the zoom flag come through as numbers", () => {
    const [p] = parsePaneGeometry([row({ id: "%3", left: 139, top: 0, right: 276, bottom: 65, active: "1" })], "$2");
    expect(p).toEqual({ id: "%3", left: 139, top: 0, right: 276, bottom: 65, active: true, zoomed: false });
  });

  test("another session's panes are not ours", () => {
    // `-a` answers for every session on the server, and acting on a pane id
    // from one of the others moves a window somebody else is looking at.
    expect(parsePaneGeometry([row({ id: "%9", sid: "$7" })], "$2")).toEqual([]);
  });

  test("a background window's panes are dropped", () => {
    // They have real geometry that corresponds to nothing on screen, so a cell
    // under the pointer would match a pane the user cannot see.
    expect(parsePaneGeometry([row({ id: "%9", winActive: "0" })], "$2")).toEqual([]);
  });

  test("a row that does not parse is dropped rather than guessed at", () => {
    // A pane with NaN bounds claims cells silently — and this decides where
    // keystrokes go.
    const bad = "p\t$2\t@1\t1\t%4\tx\t0\t137\t65\t0\t0";
    expect(parsePaneGeometry([bad], "$2")).toEqual([]);
    // And an id that is not tmux's shape never reaches `select-pane`.
    expect(parsePaneGeometry([row({ id: "not-a-pane" })], "$2")).toEqual([]);
  });

  test("the whole frame carries windows and panes together", () => {
    // One call, three commands: this is the shape the sweep actually parses.
    const frame = [
      "c\t/dev/pts/0\torbit\t$2",
      "w\t$2\t@1\t1\tOrbit.API\t1\t*\t",
      row({ id: "%1", left: 0, right: 137, active: "1" }),
      row({ id: "%2", left: 139, right: 276 }),
      row({ id: "%8", sid: "$7" }),
    ].join("\n");
    const f = parseFrame(frame, "/dev/pts/0")!;
    expect(f.windows.map((w) => w.name)).toEqual(["Orbit.API"]);
    expect(f.panes.map((p) => p.id)).toEqual(["%1", "%2"]);
    expect(f.panes.find((p) => p.active)!.id).toBe("%1");
  });

  test("a frame with no pane rows is empty, not broken", () => {
    // Older servers, and any window whose panes tmux did not report.
    const f = parseFrame("c\t/dev/pts/0\tmain\t$2\nw\t$2\t@1\t1\tone\t1\t*\t", "/dev/pts/0")!;
    expect(f.panes).toEqual([]);
  });
});

// When the desk says a window is being held narrow.
//
// The shape is a real session: the desk's client is 174 columns, the window
// on screen follows it, and one background tab was last shown while the desk
// was narrower, so tmux still reports it at 152. tmux only resizes the window a
// client is showing (`aggressive-resize on`, `window-size latest`), so a tab
// nobody has looked at since a resize keeps its old width indefinitely — and
// that width is not a claim about anybody's screen.
import { describe, expect, it } from "bun:test";
import { heldWindow } from "../src/lib/heldWindow.ts";
import type { TmuxWindow } from "../../shared/types.ts";

const win = (w: Partial<TmuxWindow> & { id: string }): TmuxWindow =>
  ({ index: 0, name: "shell", active: false, flags: "", cols: 174, ...w });

const DESK = { cols: 174, rows: 47 };
const WINDOWS: TmuxWindow[] = [
  win({ id: "@1", index: 1, active: true, flags: "*" }),
  win({ id: "@4", index: 4, name: "background", cols: 152 }),
];

describe("heldWindow", () => {
  it("says nothing about a background tab's old width while its click is on the way", () => {
    // The tab was clicked: the strip highlights @4 before tmux has switched to
    // it, and tmux resizes it to the desk the moment it does. Until then the
    // 152 is a leftover, and reading it as a reflow is the false alarm.
    expect(heldWindow(true, WINDOWS, "@4", DESK)).toBeNull();
  });

  it("still sees a window tmux is showing narrower than the desk", () => {
    const narrowed = [win({ id: "@1", index: 1, active: true, flags: "*", cols: 80 }), WINDOWS[1]!];
    const held = heldWindow(true, narrowed, "@1", DESK);
    expect(held).not.toBeNull();
    expect(held!.narrow).toEqual({ winCols: 80, deskCols: 174 });
    expect(held!.win.id).toBe("@1");
  });

  it("is quiet when the active window is the desk's width", () => {
    expect(heldWindow(true, WINDOWS, "@1", DESK)).toBeNull();
  });

  it("names a phone's zoom, and only a phone's", () => {
    const zoomed = [win({ id: "@1", index: 1, active: true, flags: "*Z", phone: true })];
    expect(heldWindow(true, zoomed, "@1", DESK)?.zoomed).toBe(true);
    const ownZoom = [win({ id: "@1", index: 1, active: true, flags: "*Z" })];
    expect(heldWindow(true, ownZoom, "@1", DESK)).toBeNull();
  });

  it("does not guess without tmux, a size, or a client", () => {
    const narrowed = [win({ id: "@1", active: true, cols: 80 })];
    expect(heldWindow(false, narrowed, "@1", DESK)).toBeNull();
    expect(heldWindow(true, [win({ id: "@1", active: true, cols: undefined })], "@1", DESK)).toBeNull();
    expect(heldWindow(true, narrowed, "@1", null)).toBeNull();
  });
});

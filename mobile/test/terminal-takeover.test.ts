/*
 * Take over: the desk gets its columns back, and the phone stays live.
 *
 * The desk can end this phone's reflow. The obvious way to do it is to kill the
 * phone's grouped session, and it was measured on an isolated tmux 3.6a server
 * (`-f /dev/null`, private socket) and rejected twice over: the window stayed at
 * 80x24 after the kill — the fit is a `manual` size on the *shared* window and
 * outlives the client that asked for it — so a kill is the same resize plus a
 * hung-up phone. And the phone does not come back on its own. The socket effect
 * re-runs only on the connection's own identity, so somebody mid-command on the
 * sofa sits on "Disconnected" until they tap another tab.
 *
 * So the server resizes the window and sends a frame. Three things have to hold
 * on this side for that to be true rather than merely intended, and none of them
 * is visible to the type-checker:
 *
 *   the frame must not disconnect anything, including by accident — dropping
 *   `fit` remounts the view, and the outgoing socket's close event lands after
 *   the incoming one is already up;
 *
 *   the window's size must have a second writer, because `t:"ready"` is sent
 *   once per socket and everything after it left the phone quoting a dead
 *   number;
 *
 *   dropping `fit` must really reattach without it, which is two separate facts
 *   in two files.
 *
 * Asserted against the source, the way the socket's lifetime already is: each of
 * these is correct once and wrong only later.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const view = readFileSync(join(import.meta.dir, "..", "src", "terminal", "TerminalView.tsx"), "utf8");
const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

/** The source between two anchors, with a failure that names the move rather
 *  than reporting an empty string as a passing assertion. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `\`${from}\` is gone — this test is reading the wrong code`).toBeGreaterThan(0);
  const end = source.indexOf(to, start);
  expect(end, `\`${to}\` no longer follows \`${from}\``).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the frame the desk sends when it takes its width back", () => {
  test("nothing on the receiving end disconnects", () => {
    const branch = between(view, 'if (frame.t === "pane"', 'if (frame.t === "tmux"');
    expect(branch).toContain("onPane");
    // The whole point of a frame rather than a kill. A `close()` here, or a
    // "gone", and the sofa gets the failure the plan spent a probe rejecting.
    expect(branch).not.toContain("close");
    expect(branch).not.toContain("gone");
  });

  test("a retired socket cannot report its own close", () => {
    // Dropping `fit` closes this socket and opens another, in that order but not
    // atomically — the same non-atomicity that once let a teardown undo a fit
    // 300ms after it was applied. The close event is dispatched as a task, so it
    // always arrives after the new socket has said it is connecting; ungated, it
    // paints "Disconnected" over a terminal that is working.
    const closed = between(view, "const closed = ", "ws.onerror");
    expect(closed).toContain("socket.current !== ws");
    expect(closed).toMatch(/return\s*;/);
  });

  test("the window's size has a second writer", () => {
    // `ready` fires once per socket. If it is the only thing that sets the grid,
    // the strip on the screen quotes whatever the window was at attach time —
    // for take-over that is exactly the number that just stopped being true.
    expect(view).toContain('frame.t === "ready" && frame.pane');
    expect(view).toContain('frame.t === "pane"');
    const handler = between(screen, "onPane={", "/>");
    expect(handler).toContain("setGrid");
    expect(handler).toContain("setFit");
  });

  test("dropping the fit reattaches without it", () => {
    // Two facts in two files, and the feature needs both: the key remounts the
    // view when `fit` changes, and the socket effect is what re-runs on it. Lose
    // either and `fit` going false is a flag nobody acts on — the phone would
    // keep the fitted session it already has.
    const tag = between(screen, "<TerminalView", "/>");
    expect(between(tag, "key={", "}\n")).toContain("fit");
    // Anchored past the construction, because the first `]` after it belongs to
    // the frame type's `string[]` — which is how the same shortcut in the
    // lifetime test once read an unrelated dependency array and passed.
    const deps = between(view.slice(view.indexOf("new Ctor(")), "}, [", "]");
    expect(deps).toContain("fit");
    expect(view).toContain('query.set("fit", "1")');
  });

  test("the attribution belongs to the pane it happened on", () => {
    // A boolean would survive a tab switch and tell somebody the computer took
    // the width back on a pane it never touched, which is the same invisible lie
    // the frame exists to end.
    const strip = between(screen, "grid.cols > columns", "</Pressable>");
    expect(strip).toContain("The computer took its width back.");
    expect(strip).toContain("tookBack === open?.paneId");
  });

  test("and it is not claimed over a window that is following this phone", () => {
    /*
     * The other way the same strip lied, and this one HAS been reported: with an
     * 80-column client attached and the phone at 60, it asserted "nothing wider
     * is looking at this window, so it is 60 columns for the computer too" while
     * columns 61 to 80 fell off the right-hand edge — proved with an 80-column
     * ruler, where `shared` arrived as `sha`.
     *
     * The cause was that the answer was INFERRED rather than measured. Nothing
     * reported a size after this page's own resize, so the screen kept the one
     * size it had ever been sent alongside the width it was showing when it was
     * sent, and read the two being equal as "the window follows me". At a fresh
     * attach they are equal for a reason that has nothing to do with the phone:
     * an 80-column desk and an 80-column default.
     *
     * So the server answers with the window's real size after every resize
     * (`by: "phone"` on the `pane` frame) and the comparison is between two
     * current facts. Under `largest` a window no wider than what this page is
     * showing IS a window with nothing wider attached — measured on the
     * emulator against a real 80-column client: at 60c the window stayed 80 and
     * the strip said "this pane is 80 columns wide and you are seeing 60"; with
     * the client gone the window became 60 and the other strip was true.
     */
    expect(screen).toContain("const following = !!grid && grid.cols <= columns;");
    // The stamp is gone, and must stay gone: it is what made the comparison a
    // guess about the past rather than a reading of the present.
    expect(screen).not.toContain("at: columns");
    expect(screen).toContain("onGrid={(next) => setGrid(next)}");
    expect(screen).toContain("setGrid({ cols: next.cols, rows: next.rows })");
    // And the strip that says the desk is wider must be gated on it.
    expect(between(screen, "grid.cols > columns", "</Pressable>")).toBeTruthy();
    expect(screen).toContain("!following && grid.cols > columns");
  });

  test("the take-over drops the attach's own claim, not just the phone's UI", () => {
    /*
     * The bug this pair exists to end, reported as "I take the width back on
     * the computer and it goes narrow again on its own".
     *
     * `phoneAttach.fit` is what the resize handler reads to decide whether this
     * phone's geometry moves the real window, and it was written once at attach.
     * The take-over sent the frame and left the flag alone, so the next `resize`
     * from that socket ran `fitWindow` and undid it — and a resize is not a
     * gesture: a WebView re-measuring when the app comes back sends one.
     */
    const server = readFileSync(join(import.meta.dir, "..", "..", "server", "src", "terminal.ts"), "utf8");
    const tell = between(server, "function tellPhonesTheWindowMoved", "\n}\n");
    expect(tell).toContain("at.fit = false");
    // Before the send, so a frame that throws still leaves the server true.
    expect(tell.indexOf("at.fit = false")).toBeLessThan(tell.indexOf('ctl(ws, { t: "pane"'));
  });

  test("a phone whose socket died does not reattach still fitted", () => {
    /*
     * The other half, and the half that survives the app being closed: the
     * take-over frame only reaches a phone that is there to receive it. Leaving
     * the app with `fit` on left the switch lit over a socket that no longer
     * existed, and the next attach read it and sent `fit=1` again — so coming
     * back to the app took the width off the desk with nobody asking.
     *
     * The claim lives in the socket, so it dies with it.
     */
    const handler = between(screen, "const onState = useCallback", "}, []);");
    expect(handler).toContain('next === "gone"');
    expect(handler).toContain("setFit(false)");
  });

  test("the server re-measures the window after this phone resizes it", () => {
    /*
     * The other half of the same fix, and the half without which the screen is
     * back to inferring. `ready.pane` fires once and `t:"pane"` only ever fired
     * when the DESK moved the window, so a phone that changed its own width
     * learned nothing — and whether that width moved the real window depends on
     * what else is attached.
     */
    const server = readFileSync(join(import.meta.dir, "..", "..", "server", "src", "terminal.ts"), "utf8");
    const resize = server.slice(server.indexOf('} else if (msg.t === "resize")'), server.indexOf('} else if (msg.t === "tmux")'));
    expect(resize).toContain("windowSize(at.socket, at.windowId)");
    expect(resize).toContain('by: "phone"');
  });
});

/*
 * A resize has to end in a full redraw.
 *
 * SIGWINCH tells tmux the grid changed, and tmux rebuilds it — but it then
 * sends only what it believes CHANGED, and the cells it kept were drawn for
 * the old grid. What that looks like is a frame a row out of place: the bottom
 * line of the window painted under the tab bar, and every click landing on the
 * line below the text it is on.
 *
 * Measured on the machine that reported it, while it was happening: the pty
 * said 249x62, `list-clients` said 249x62 and the pane said 249x62. Nothing was
 * the wrong size, so nothing was going to fix itself — the only thing missing
 * was somebody asking for the screen again.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/terminal.ts", import.meta.url).pathname, "utf8");
const ctl = readFileSync(new URL("../src/tmuxctl.ts", import.meta.url).pathname, "utf8");

describe("an attach ends in a redraw too", () => {
  test("the sweep asks for the whole screen the first time it resolves the client", () => {
    /* The resize path alone was not enough, and he found the proof by accident:
       zooming the terminal (ctrl +/-, ctrl+wheel) put the frame right, because a
       zoom is a refit and a refit is a resize. An attach that lands on the same
       grid is not a resize — so nothing was ever asked for, and the pane stayed
       a row out of place until something else happened to resize it. */
    const at = src.indexOf("session.tmuxClient = resolveClient(proc.pid);");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1400);
    expect(body).toContain("redrawClient(c.socket, c.tty)");
  });
});

describe("resize ends in a redraw", () => {
  test("the resize handler asks for one, reading the client when the timer fires", () => {
    /* Not when the timer is SET. At the first fit of an attach the sweep has
       not resolved the tmux client yet (that walk is /proc, a tick later), so
       requiring it up front skipped the one moment it matters most: a reattach,
       where the browser's grid is new and tmux is sending deltas for a screen
       it believes is already drawn. That is how the bug "came back" after a
       reinstall and went away again on a manual restart. */
    const at = src.indexOf('} else if (msg.t === "resize") {');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 3200);
    expect(body).toContain("const c = s.tmuxClient;");
    expect(body).toContain("redrawClient(c.socket, c.tty)");
    // And it waits for the client rather than giving up on it.
    expect(body).toContain("setTimeout(() => askRedraw(false), 900)");
  });

  test("and it is debounced, because a drag is a resize per frame", () => {
    const at = src.indexOf('} else if (msg.t === "resize") {');
    const body = src.slice(at, at + 2600);
    expect(body).toContain("if (s.redrawTimer) clearTimeout(s.redrawTimer)");
    expect(body).toContain("setTimeout(() => askRedraw(true), 120)");
  });

  test("the redraw names the client, since a popup would otherwise take it", () => {
    /* `refresh-client` with no target picks the most recently used client, and
       with a scratch popup open that is the popup — measured in this app more
       than once (see focusPane). */
    const at = ctl.indexOf("export function redrawClient");
    expect(at).toBeGreaterThan(-1);
    const body = ctl.slice(at, ctl.indexOf("\n}", at));
    expect(body).toContain('["refresh-client", "-t", tty]');
    expect(body).toContain("if (!tty) return;");
  });
});

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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const body = src.slice(at, at + 1600);
    // Async: first contact is on the request path, a blocking spawn stalls it.
    expect(body).toContain("redrawClientAsync(c.socket, c.tty)");
    expect(body).not.toContain("redrawClient(c.socket, c.tty)");
  });

  test("the async redraw sends the same tmux call and never blocks the loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-redraw-"));
    try {
      const log = join(dir, "calls.log");
      const stub = join(dir, "tmux");
      writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\nsleep 1\n`);
      chmodSync(stub, 0o755);
      const script = join(dir, "probe.ts");
      writeFileSync(script, `
        import { redrawClientAsync } from ${JSON.stringify(new URL("../src/tmuxctl.ts", import.meta.url).pathname)};
        let ticks = 0;
        const t = setInterval(() => { ticks++; }, 20);
        const p = redrawClientAsync(["-L", "agx-redraw-stub"], "/dev/pts/9");
        const t0 = Date.now();
        await p;
        clearInterval(t);
        console.log(JSON.stringify({ ms: Date.now() - t0, ticks }));
      `);
      const env: Record<string, string> = { ...process.env as Record<string, string>, PATH: `${dir}:${process.env.PATH ?? ""}`, TMUX_TMPDIR: dir };
      delete env.TMUX;
      const r = Bun.spawnSync([process.execPath, script], { env, cwd: dir });
      const out = JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "{}");
      // The stub sleeps 1s; a blocked loop would tick ~0 times meanwhile.
      expect(out.ticks).toBeGreaterThan(10);
      expect(readFileSync(log, "utf8")).toContain("-L agx-redraw-stub refresh-client -t /dev/pts/9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(body).toContain('setTimeoutAs("terminal redraw retry", () => askRedraw(false), 900)');
  });

  test("and it is debounced, because a drag is a resize per frame", () => {
    const at = src.indexOf('} else if (msg.t === "resize") {');
    const body = src.slice(at, at + 2600);
    expect(body).toContain("if (s.redrawTimer) clearTimeout(s.redrawTimer)");
    expect(body).toContain('setTimeoutAs("terminal redraw", () => askRedraw(true), 120)');
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

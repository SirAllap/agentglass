/*
 * Opening a window on the engine, against a real tmux.
 *
 * A behaviour test rather than a source check, because the bug it was written
 * for could not be seen in the source and passed every type: the FIRST window
 * opened and every one after it returned null. The second pull request review
 * of a day would have done nothing at all, silently.
 *
 * The cause is a flag that reads as exactly what is wanted. `new-session -A` is
 * attach-or-create — and on a session that already exists it tries to ATTACH,
 * which from a server process with no terminal answers `open terminal failed:
 * not a terminal` and exits non-zero. `-d` does not save it.
 *
 * Isolated on its own socket and its own TMUX_TMPDIR: a `-L` with the
 * developer's tmpdir lands on the developer's server, and a test that opens
 * windows there is a test that opens windows in somebody's work.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-enginewin-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const { engineWindowRunning, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");

let dir = "";
const have = tmuxCapability().available;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-enginewin-")); });
afterAll(async () => {
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

describe("opening windows on the engine", () => {
  it("opens the first one", async () => {
    if (!have) return;
    const w = await engineWindowRunning(dir, "pr-1042", ["sh", "-c", "sleep 30"]);
    expect(w?.paneId).toMatch(/^%\d+$/);
    expect(w?.windowId).toMatch(/^@\d+$/);
  });

  it("opens the ones after it, which is the whole bug", async () => {
    /* Three in a row, into the session the first one made. This is the
       assertion: one window proved nothing, because one window always worked. */
    if (!have) return;
    for (const name of ["pr-1039", "orbit-1057", "pr-1058"]) {
      const w = await engineWindowRunning(dir, name, ["sh", "-c", "sleep 30"]);
      expect(w, name).not.toBeNull();
    }
    const ls = await tmux(["list-windows", "-a", "-F", "#{window_name}"]);
    const names = ls.stdout.trim().split("\n");
    for (const name of ["pr-1042", "pr-1039", "orbit-1057", "pr-1058"]) {
      expect(names, name).toContain(name);
    }
  });

  it("puts them all in one session rather than one session each", async () => {
    // Attach-or-create was the intent even though the flag was wrong: a day of
    // reviews should be a strip of tabs, not a server full of sessions.
    if (!have) return;
    const ls = await tmux(["list-sessions", "-F", "#{session_name}"]);
    expect(ls.stdout.trim().split("\n").length).toBe(1);
  });

  it("refuses a name tmux cannot take rather than opening something odd", async () => {
    if (!have) return;
    // A dot is a pane separator in a tmux target, so a window named with one
    // cannot be selected by name afterwards — it is stripped, not passed.
    const w = await engineWindowRunning(dir, "app.v2", ["sh", "-c", "sleep 30"]);
    expect(w).not.toBeNull();
    const ls = await tmux(["list-windows", "-a", "-F", "#{window_name}"]);
    expect(ls.stdout).toContain("app-v2");
  });
});

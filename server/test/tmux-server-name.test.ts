/*
 * A pane's tmux server, spelt the way the hook spells it.
 *
 * The hook sends `tmux_server` as `$TMUX` without its last field — the socket
 * path and the server's pid — and `pane_note` is keyed on (pane id, that
 * string). A reader that asks for a pane's note by id alone gets the newest
 * row for the id on ANY server, and pane ids start at %0 on every server. So
 * the server side has to be able to spell the same string for a pane it lists,
 * and the only proof that it does is a real `$TMUX` from inside a real pane.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxServerName, withTmuxServer } from "../src/tmuxctl.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const have = !!Bun.which("tmux");
const INDEX = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const NAME = `agx-servername-${process.pid}`;
const SOCK = ["-L", NAME];
const dir = mkdtempSync(join(tmpdir(), "agx-servername-"));
const seen = join(dir, "tmux-env");
const savedTmpdir = process.env.TMUX_TMPDIR;
const env = (): Record<string, string> => {
  const e: Record<string, string> = { ...process.env as Record<string, string>, TMUX_TMPDIR: TMUX_TEST_TMPDIR };
  delete e.TMUX;
  return e;
};
const sh = (args: string[]) => Bun.spawnSync(["tmux", "-f", "/dev/null", ...SOCK, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });

beforeAll(() => {
  if (!have) return;
  process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
  sh(["new-session", "-d", "-s", "work", `printf %s "$TMUX" > ${seen}; exec sleep 60`]);
  for (let i = 0; i < 50; i++) {
    try { if (readFileSync(seen, "utf8")) break; } catch { /* not yet */ }
    Bun.sleepSync(20);
  }
});

afterAll(() => {
  if (have) sh(["kill-server"]);
  rmSync(join(TMUX_TEST_TMPDIR, `tmux-${process.getuid?.() ?? 0}`, NAME), { force: true });
  if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmpdir;
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!have)("names the server exactly as a hook inside one of its panes does", () => {
  const tmuxEnv = readFileSync(seen, "utf8");
  // What hooks/send_event.py sends: `$TMUX` without its session field.
  const hookSays = tmuxEnv.slice(0, tmuxEnv.lastIndexOf(","));
  expect(hookSays).toMatch(/^\/.+,\d+$/);
  expect(tmuxServerName(SOCK)).toBe(hookSays);
});

test.skipIf(!have)("rows are tagged with their server, one ask per socket, and a dead socket names none", () => {
  const gone = ["-L", `${NAME}-gone`];
  const rows = withTmuxServer([{ paneId: "%0", socket: SOCK }, { paneId: "%1", socket: SOCK }, { paneId: "%0", socket: gone }]);
  expect(rows.map((r) => [r.paneId, r.server])).toEqual([
    ["%0", tmuxServerName(SOCK)], ["%1", tmuxServerName(SOCK)], ["%0", ""],
  ]);
});

test("the Diff view's pane liveness reads each pane's own server", () => {
  /* The reader is wired in index.ts, where no test reaches it without a whole
     server; the rule about which note it may read is asserted where it is. */
  expect(INDEX).toContain("paneHeldSessions(withTmuxServer(await listPanes(");
  expect(INDEX).not.toMatch(/paneHeldSessions\((await )?listPanes\(/);
});

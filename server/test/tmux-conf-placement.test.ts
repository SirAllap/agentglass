/*
 * AN ISOLATED INSTANCE MUST NOT LITTER THE SHARED STATE DIRECTORY.
 *
 * A config dir that is not the default gets a tmux conf of its own — that part
 * is right, and it exists because a probe with no prefix set rewrote the desk's
 * conf twice in one afternoon ("tmux has changed by itself again").
 *
 * What was wrong is WHERE. It wrote `tmux-<hash>.conf` into the shared state
 * directory, one file per distinct config dir, and a probe or a test run gets a
 * fresh temporary one every time. Nothing removed them. Measured on the
 * developer's machine: 136 files, 772 KB, not one of them referenced by a
 * running tmux, accumulating since the hash was introduced.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const { confPath, sweepStaleConfs } = await import("../src/tmuxconf.ts");
const { tmuxStateDir } = await import("../src/tmuxbin.ts");

const was = { xdg: process.env.XDG_CONFIG_HOME, state: process.env.AGENTGLASS_STATE_DIR };
const made: string[] = [];
afterEach(() => {
  process.env.XDG_CONFIG_HOME = was.xdg;
  process.env.AGENTGLASS_STATE_DIR = was.state;
  if (!was.xdg) delete process.env.XDG_CONFIG_HOME;
  if (!was.state) delete process.env.AGENTGLASS_STATE_DIR;
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
});

test("a redirected config keeps its conf beside itself, not in the shared state dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-conf-"));
  made.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.AGENTGLASS_STATE_DIR;

  const p = confPath();
  expect(p, "it must live under the config dir it belongs to").toStartWith(dir);
  expect(p.endsWith("/tmux.conf"), p).toBe(true);
  /* And NOT in the shared one, which is the whole point: a temporary config dir
     takes its conf with it when it goes. */
  expect(p.startsWith(tmuxStateDir())).toBe(false);
});

test("an explicit state dir still wins, so an installed app is untouched", () => {
  const cfg = mkdtempSync(join(tmpdir(), "agx-conf-"));
  const st = mkdtempSync(join(tmpdir(), "agx-state-"));
  made.push(cfg, st);
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.AGENTGLASS_STATE_DIR = st;
  expect(confPath()).toStartWith(st);
});

test("the sweep removes the hashed confs the old placement left, and nothing else", () => {
  const st = mkdtempSync(join(tmpdir(), "agx-state-"));
  made.push(st);
  process.env.AGENTGLASS_STATE_DIR = st;
  const dir = tmuxStateDir();
  mkdirSync(dir, { recursive: true });

  const old = join(dir, "tmux-deadbeef.conf");
  const fresh = join(dir, "tmux-cafe1234.conf");
  const mine = join(dir, "tmux.conf");
  const other = join(dir, "override.conf");
  for (const f of [old, fresh, mine, other]) writeFileSync(f, "# x\n");
  /* Two hours back: the age check is there for a server that is mid-start while
     this runs, not to keep anything. */
  const then = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(old, then, then);
  utimesSync(mine, then, then);
  utimesSync(other, then, then);

  const gone = sweepStaleConfs();
  expect(gone).toBe(1);
  expect(existsSync(old), "an old hashed conf goes").toBe(false);
  expect(existsSync(fresh), "a fresh one may still belong to a server starting up").toBe(true);
  expect(existsSync(mine), "the ordinary install's conf is never touched").toBe(true);
  expect(existsSync(other), "nor is anything that is not one of ours").toBe(true);
  expect(readdirSync(dir).sort()).toEqual(["override.conf", "tmux-cafe1234.conf", "tmux.conf"]);
});

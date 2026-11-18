/**
 * The orphan sweep reads tmux without holding the event loop.
 *
 * Measured (server-stall.log): `Bun.spawnSync` of `list-sessions` and
 * `show-options` was the top stall owner, 239 s of frozen loop in all. This
 * runs the default (async) io against a real isolated server and proves two
 * things: it still reaps a stamped, unattached mirror and spares one that is
 * not ours, and a timer on the same loop keeps ticking while it waits.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapOrphanedMirrors } from "../src/tmuxctl.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { settled } from "./paneSettled.ts";

const SOCK = [...TMUX_ISOLATED, "-L", "agx-orphan-async"];
const dir = mkdtempSync(join(tmpdir(), "agx-orphan-async-"));
const before = process.env.TMUX_TMPDIR;
const env = { ...process.env, TMUX_TMPDIR: dir } as Record<string, string>;
delete env.TMUX;
const run = (...a: string[]) => Bun.spawnSync(["tmux", ...SOCK, ...a], { env, stdout: "pipe", stderr: "pipe" });

beforeAll(() => {
  process.env.TMUX_TMPDIR = dir;
  run("new-session", "-d", "-s", "agx-phone-1-aaa111", "sleep 60");
  run("set-option", "-t", "agx-phone-1-aaa111", "@agx_mirror_lease", "stamp");
  run("new-session", "-d", "-s", "agx-phone-2-bbb222", "sleep 60"); // phone-shaped, no stamp
}, 10_000);

afterAll(() => {
  run("kill-server");
  if (before === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = before;
  rmSync(dir, { recursive: true, force: true });
});

test("async sweep closes the stamped mirror, spares the unstamped one, and the loop keeps ticking", async () => {
  await settled(() => run("list-sessions", "-F", "#{session_name}").stdout.toString(), (v) => v.includes("bbb222"));
  let ticks = 0;
  const t = setInterval(() => { ticks++; }, 1);
  const killed = await reapOrphanedMirrors(SOCK);
  clearInterval(t);
  expect(killed).toEqual(["agx-phone-1-aaa111"]);
  const left = run("list-sessions", "-F", "#{session_name}").stdout.toString();
  expect(left).toContain("agx-phone-2-bbb222");
  expect(left).not.toContain("agx-phone-1-aaa111");
  expect(ticks, "the loop was held while tmux answered").toBeGreaterThan(0);
}, 15_000);

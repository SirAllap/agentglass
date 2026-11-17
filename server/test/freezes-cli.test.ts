/*
 * `agentglass-ui freezes`: the read side of the freeze trace. Local files
 * only, no server — the point of the trace is to still answer when the app
 * itself is what froze, so this must not depend on it being up.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const CLI = new URL("../../bin/agentglass-ui", import.meta.url).pathname;

(HAVE_PY ? test : test.skip)("merges the shell's window.log and the server's stall log, newest last", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freezes-cli-"));
  const config = join(dir, "config", "agentglass");
  const state = join(dir, "state");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(config, "window.log"),
    "2026-01-01T00:00:01.000Z unresponsive since=2026-01-01T00:00:00.000Z mem=100mb\n"
    + "2026-01-01T00:00:03.000Z responsive after=2000ms mem=100mb\n");
  writeFileSync(join(state, "server-stall.log"),
    "2026-01-01T00:00:02.000Z server stall ms=600 last=GET /health\n");

  const proc = Bun.spawn(["python3", CLI, "freezes"], {
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), AGENTGLASS_STATE_DIR: state },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const res = JSON.parse(out);
  expect(res.ok).toBe(true);
  expect(res.lines).toEqual([
    "2026-01-01T00:00:01.000Z unresponsive since=2026-01-01T00:00:00.000Z mem=100mb",
    "2026-01-01T00:00:02.000Z server stall ms=600 last=GET /health",
    "2026-01-01T00:00:03.000Z responsive after=2000ms mem=100mb",
  ]);
});

(HAVE_PY ? test : test.skip)("no logs yet is an empty list, not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freezes-cli-empty-"));
  const proc = Bun.spawn(["python3", CLI, "freezes"], {
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), AGENTGLASS_STATE_DIR: join(dir, "state") },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(JSON.parse(out)).toEqual({ ok: true, lines: [] });
});

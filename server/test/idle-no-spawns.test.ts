/*
 * An idle server must not wake tmux or git.
 *
 * A stub `tmux` ahead of the real one on PATH counts every spawn, and the
 * sweep's setInterval is captured so a fake clock fires it: 10 minutes idle =
 * 10 fallback captures, not 60. A change (`captureNow`) = exactly one capture.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, log: string;
const realSetInterval = globalThis.setInterval;
const ticks: { fn: () => void; ms: number }[] = [];
const spawns = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
const wipe = () => writeFileSync(log, "");
let restore: typeof import("../src/tmuxrestore.ts");

const KEYS = ["PATH", "AGENTGLASS_STATE_DIR", "AGENTGLASS_TMUX_SOCKET", "TMUX_TMPDIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-idle-"));
  log = join(dir, "tmux.log");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "tmux"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(dir, "bin", "tmux"), 0o755);
  process.env.PATH = `${join(dir, "bin")}:${process.env.PATH ?? ""}`;
  process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
  process.env.AGENTGLASS_TMUX_SOCKET = `agx-idle-${process.pid}`;
  mkdirSync(join(dir, "tt")); process.env.TMUX_TMPDIR = join(dir, "tt");
  wipe();
  (globalThis as { setInterval: unknown }).setInterval = ((fn: () => void, ms: number) => {
    ticks.push({ fn, ms });
    return { unref() {} };
  }) as unknown;
  restore = await import("../src/tmuxrestore.ts");
});

afterAll(() => {
  globalThis.setInterval = realSetInterval;
  // The files after this one share the process: its stub tmux must not stay first on PATH.
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const fire = async (ms: number, upTo: number) => {
  // The fake clock: run each captured timer once per period that fits in `upTo`.
  for (const t of ticks.filter((x) => x.ms === ms)) for (let at = ms; at <= upTo; at += ms) { t.fn(); await Bun.sleep(30); }
};

test("idle 10 minutes: layout sweep fires 10 times, not 60", async () => {
  restore.startRestoreSweeper(() => true);
  const mine = ticks.filter((t) => t.ms === restore.RESTORE_FALLBACK_MS);
  expect(mine.length).toBe(1);
  expect(ticks.some((t) => t.ms === 10_000 && t.fn.toString().includes("captureLayout"))).toBe(false);
  restore.captureNow(); await Bun.sleep(400); // warm: the first capture also probes the engine
  wipe();
  restore.captureNow(); await Bun.sleep(400);
  const one = spawns();
  wipe();
  await fire(restore.RESTORE_FALLBACK_MS, 10 * 60_000);
  const idle = spawns();
  expect(one, "a change must photograph").toBeGreaterThan(0);
  expect(idle, "10 fallback captures = 10x one capture").toBe(one * 10);
});

test("a change makes exactly one capture, even asked three times", async () => {
  wipe();
  restore.captureNow(); restore.captureNow(); restore.captureNow();
  await Bun.sleep(400);
  const three = spawns();
  wipe();
  restore.captureNow();
  await Bun.sleep(400);
  expect(three).toBe(spawns());
});

test("the fetch audience ignores hidden windows (the live-server case is in autofetch-waits-for-a-window)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(src).toMatch(/setAutoFetchAudience\(\(\) => \{ for \(const c of clients\) if \(!hiddenClients\.has\(c\)\)/);
  expect(src).toMatch(/f\.type === "visibility"/);
  const web = readFileSync(new URL("../../web/src/lib/useLive.ts", import.meta.url), "utf8");
  expect(web).toMatch(/type: "visibility"/);
});

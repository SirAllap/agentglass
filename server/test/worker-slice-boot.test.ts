/*
 * The worker slice is given its walls at boot, before any worker lands in it.
 * Only the app's own copy writes them; every other process reads the slice's
 * effective `MemoryMax` and launches without `--slice=` when there is none.
 *
 * Measured on 2026-11-05: `systemctl --user set-property --runtime` writes a
 * drop-in under /run that reaches the slice's cgroup at once and outlives the
 * process that set it. A server started by hand from a shell with
 * `AGENTGLASS_SLICE_MEMORY_MAX=2G` would therefore re-limit the live app's
 * workers, and nothing would report it. A stub `systemctl` first on PATH
 * records what a real boot asks for, and a stub `systemd-run` records the argv
 * of a launch, so this is the wiring rather than a second reading of the same
 * constants.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_SLICE } from "../src/scopes.ts";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-worker-slice-"));
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

let boots = 0;

interface Booted {
  log: string;
  runs: string;
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
}

/** A real server with a `systemctl` and `systemd-run` that record their argv,
 *  and an engine on PATH so a probe makes the server launch one. */
async function boot(appCopy: boolean): Promise<Booted> {
  boots += 1;
  const at = join(dir, `boot-${boots}`);
  const bin = join(at, "bin");
  for (const d of [bin, join(at, "home"), join(at, "runtime")]) mkdirSync(d, { recursive: true });
  const log = join(at, "systemctl.log");
  const runs = join(at, "systemd-run.log");
  writeFileSync(join(bin, "systemctl"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    'case "$*" in',
    '  *" show "*"MemoryMax"*) printf "MemoryMax=infinity\\n" ;;',
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "systemd-run"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${runs}"`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 1.0.0\n", { mode: 0o755 });
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: join(at, "home"),
      LANG: process.env.LANG ?? "C.UTF-8",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      AGENTGLASS_TMUX_SOCKET: `agx-slice-${process.pid}-${boots}`,
      XDG_CONFIG_HOME: join(at, "cfg"),
      XDG_DATA_HOME: join(at, "data"),
      XDG_CACHE_HOME: join(at, "cache"),
      XDG_RUNTIME_DIR: join(at, "runtime"),
      AGENTGLASS_STATE_DIR: join(at, "state"),
      AGENTGLASS_DB: join(at, "a.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      ...(appCopy ? { AGENTGLASS_DIE_WITH_PARENT: "1" } : null),
    },
    stdout: "ignore", stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* not up yet */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("the server did not come up");
  return { log, runs, port, proc };
}

/** What a stub was asked, one line per call. */
function calls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

test("the app's own copy gives the slice its walls before it reads or stops a scope", async () => {
  const { log, proc } = await boot(true);
  try {
    let got = calls(log);
    for (let i = 0; i < 50 && !got.length; i++) { await Bun.sleep(100); got = calls(log); }
    // The boot timer runs `ensureWorkerSlice()` and then the orphan pass, whose
    // first systemd question is the scope list: if the set-property is not
    // first, the ordering claim in index.ts is not true.
    expect(got[0]).toContain("--user set-property --runtime app-agentglass-workers.slice");
    expect(got[0]).toContain("MemoryMax=");
    expect(got[0]).toContain("MemoryHigh=");
    // The old name is looked up too, so an upgrade can stop it once it is empty.
    for (let i = 0; i < 50 && !got.some((line) => line.includes("LoadState")); i++) {
      await Bun.sleep(100);
      got = calls(log);
    }
    expect(
      got.some((line) => line.includes("--user show") && line.includes("LoadState") && line.includes("agentglass-workers.slice")),
      "the app's own copy did not look at the old worker slice",
    ).toBe(true);
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  }
}, SERVER_BOOT_MS);

test("a server started by hand only reads the slice, and launches without it", async () => {
  const { log, runs, port, proc } = await boot(false);
  try {
    // The boot timer has run by now: it is a 0 ms timer, and /health answered.
    await Bun.sleep(1_000);
    const asked = calls(log);
    // The read-only check asks for the effective MemoryMax; it never writes the
    // machine-wide drop-in.
    expect(
      asked.some((line) => line.includes("--user show") && line.includes("MemoryMax") && line.includes(WORKER_SLICE)),
      "a hand-started server did not read the slice's effective wall",
    ).toBe(true);
    expect(
      asked.some((line) => line.includes("set-property")),
      "a hand-started server re-limited the app's live workers",
    ).toBe(false);
    expect(
      asked.some((line) => line.includes("LoadState")),
      "a hand-started server touched the old app slice",
    ).toBe(false);

    // A launch this server makes, through the stub `systemd-run`.
    expect((await fetch(`http://127.0.0.1:${port}/engines?fresh=codex`)).ok).toBe(true);
    let launched = calls(runs);
    for (let i = 0; i < 50 && !launched.length; i++) { await Bun.sleep(100); launched = calls(runs); }
    expect(launched.length, "the probe did not go through systemd-run").toBeGreaterThan(0);
    for (const line of launched) expect(line).not.toContain("--slice=");
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  }
}, SERVER_BOOT_MS);

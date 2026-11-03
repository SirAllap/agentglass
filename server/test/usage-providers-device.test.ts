/*
 * One plan, two surfaces: what a paired phone is handed for OpenCode Go.
 *
 * `/usage/providers` has no caller branch — the desk and a phone read the same
 * answer. That matters here because the console reading only travels as
 * `calibration` beside the local windows: a device-gated payload that dropped
 * it would leave the phone drawing this PC's estimate (measured 31 Oct: 23.5 %
 * used against the console's 0 %) while the monitor drew the plan's own number.
 * The two clients share `shared/opencodePanel.ts`, which decides which reading
 * wins; this pins the payload both of them are given.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

const MACHINE = "machine-token-for-this-test";
const KEY = "acme-orbit-console-key-for-this-test";
const CONSOLE_AT = Date.now() - 3 * 60_000;
const consoleWindows = [
  { label: "5h", minutes: 300, usedPercent: 0, resetsAt: new Date(Date.now() + 5 * 3600_000).toISOString() },
  { label: "weekly", minutes: 10080, usedPercent: 82, resetsAt: new Date(Date.now() + 15 * 3600_000).toISOString() },
  { label: "monthly", minutes: 43200, usedPercent: 41, resetsAt: new Date(Date.now() + 20 * 86_400_000).toISOString() },
];

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
let phone = "";
const savedXdg = process.env.XDG_CONFIG_HOME;

type Provider = {
  provider: string; label: string; available: boolean; usageKey?: boolean; source?: string;
  windows: { label: string; minutes: number; usedPercent: number; resetsAt: string | null }[];
  calibration?: { at: number; windows: { usedPercent: number }[] };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-usage-device-"));
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  // The console's own reading, as the key or a page read leaves it on disk.
  writeFileSync(join(state, "opencode-console.json"), JSON.stringify({ at: CONSOLE_AT, windows: consoleWindows }));
  // This PC's worker steps: 23.5 % of the 5 h cap, 60 % of the week, 30 % of
  // the month. A row that only had these would be the phone's old number.
  const now = Date.now();
  writeFileSync(join(state, "opencode-spend.json"), JSON.stringify({
    backfilled: true,
    steps: [
      { at: now - 2 * 86_400_000, cost: 15.18, tokens: 10, key: "s:1:15.18" },
      { at: now - 3600_000, cost: 2.82, tokens: 10, key: "s:2:2.82" },
    ],
  }));
  // A stored console key, invented for this test: the row says which source
  // answered, and the key itself is never read back by any assertion.
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  const keyFile = join(dir, "agentglass", "opencode-usage-key");
  writeFileSync(keyFile, KEY + "\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);

  // OpenCode's binary is the gate for the row existing at all. A stand-in keeps
  // this read off whatever this machine happens to have installed.
  mkdirSync(join(dir, "bin"), { recursive: true });
  const bin = join(dir, "bin", "opencode");
  writeFileSync(bin, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(bin, 0o755);

  // Minted into the store the server loads at boot, so the ordering matters:
  // issue, then spawn.
  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  phone = issueDevice("Pixel 9", "read").token;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: state,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_TOKEN: MACHINE,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      CODEX_HOME: join(dir, "codex"),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** The answer as bytes, for the one assertion a parsed row cannot make: that
 *  the stored key is nowhere in it. */
const goBody = (credential: string): Promise<string> =>
  fetch(base + "/usage/providers", { headers: { authorization: `Bearer ${credential}` } }).then((r) => r.text());

const goRow = async (credential: string): Promise<Provider> => {
  const rows = (await goBody(credential).then((b) => JSON.parse(b))) as Provider[];
  const row = rows.find((r) => r.provider === "opencode");
  if (!row) throw new Error("OpenCode Go has no row in " + JSON.stringify(rows.map((r) => r.provider)));
  return row;
};

describe("/usage/providers for a paired phone", () => {
  test("hands the phone the same OpenCode Go row the desk draws", async () => {
    expect(await goRow(phone)).toEqual(await goRow(MACHINE));
  });

  test("that row carries the console reading beside this PC's windows", async () => {
    const row = await goRow(phone);
    expect(row.available).toBe(true);
    expect(row.usageKey).toBe(true);
    // The local count, which the phone used to draw on its own.
    expect(row.windows.map((w) => w.usedPercent)).toEqual([23.5, 60, 30]);
    // The plan's own numbers, which shared/opencodePanel.ts puts on top.
    expect(row.calibration?.at).toBe(CONSOLE_AT);
    expect(row.calibration?.windows.map((w) => w.usedPercent)).toEqual([0, 82, 41]);
    // The key is a boolean here, never the value: a row that carried it instead
    // would put the credential on the wire for anyone with a device token.
    expect(await goBody(phone)).not.toContain(KEY);
    expect(await goBody(MACHINE)).not.toContain(KEY);
  });
});

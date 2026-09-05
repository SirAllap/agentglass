/*
 * The ping that keeps the Codex reading fresh.
 *
 * This spends quota in order to measure quota, so the only behaviours worth
 * pinning are the ones that stop it spending more than it must: it picks the
 * smallest model on offer, it never guesses a model id that is not there, and
 * it refuses outright when Codex is not available to run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageRefreshModel } from "../src/codexusage.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

describe("usageRefreshModel", () => {
  test("takes the last entry — parseModels sorts by Codex's own priority", () => {
    expect(usageRefreshModel([{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }, { id: "gpt-5.5" }]))
      .toBe("gpt-5.5");
  });

  test("an override wins over the list", () => {
    process.env.AGENTGLASS_CODEX_USAGE_MODEL = "gpt-tiny";
    try {
      expect(usageRefreshModel([{ id: "gpt-5.6-sol" }])).toBe("gpt-tiny");
    } finally {
      delete process.env.AGENTGLASS_CODEX_USAGE_MODEL;
    }
  });

  test("an empty list means no --model flag, not an invented id", () => {
    // Passing a model the plan does not have fails for everyone but its author.
    expect(usageRefreshModel([])).toBe(null);
  });
});

describe("the route, with Codex switched off", () => {
  let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-refresh-off-"));
    const port = 4950 + Math.floor(Math.random() * 20);
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        // State (audit log, ledgers, engine conf) jailed too: without this a booted
        // server writes into the developer's real ~/.local/state/agentglass.
        AGENTGLASS_STATE_DIR: `${dir}/state`,
        AGENTGLASS_ROOT: dir,
        AGENTGLASS_DB: join(dir, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
        AGENTGLASS_CODEX_DISABLED: "1",
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up");
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("refuses rather than spawning a binary it cannot use", async () => {
    const r = await fetch(base + "/usage/codex/refresh", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; error?: string };
    // An honest no, not a silent success that leaves the reading unchanged.
    expect(j.ok).toBe(false);
    expect(j.error ?? "").toMatch(/codex/i);
  });
});

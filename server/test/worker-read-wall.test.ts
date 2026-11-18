/*
 * Codex and Hermes workers: the read wall.
 * Codex gets a permission profile (write the worktree and run folder only, the app's config and state
 * unreadable). Hermes has no sandbox at all, so it is refused unless `workers.unwalledEngines` is on,
 * and the refusal names that setting.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { agentVerdict } from "../../shared/settingClass.ts";
import { codexArgs, codexWallArgs } from "../src/codex.ts";
import { codexDeniedDirs, headlessTurn, resetBwrapProbe, type TurnSpec } from "../src/agents/headless.ts";

const spec = (engine: string, extra: Partial<TurnSpec> = {}): TurnSpec => ({
  engine, bin: engine, model: "m", role: workerRole("builder")!, envelope: DEFAULT_WORKER_ENVELOPE,
  limits: { turnMinutes: 10 } as TurnSpec["limits"], prompt: "p", cwd: "/w/tree", runDir: "/w/run", ...extra,
} as TurnSpec);

describe("codex wall", () => {
  test("args carry the profile, not just sandbox_mode", () => {
    const a = codexWallArgs({ write: ["/w/tree"], deny: ["/h/.config/agentglass"] });
    expect(a).toContain('default_permissions="agx_worker"');
    const fs = a.find((x) => x.startsWith("permissions.agx_worker.filesystem="))!;
    expect(fs).toContain('":root"="read"');
    expect(fs).not.toContain(":minimal");
    expect(fs).toContain('"/w/tree"="write"');
    expect(fs).toContain('"/h/.config/agentglass"="none"');
    const full = codexArgs("codex", "m", "workspace-write", "", { write: ["/w"], deny: ["/d"] });
    expect(full.join(" ")).not.toContain("sandbox_mode");
  });
  test("a started turn denies the app config dir and writes only tree + run folder", () => {
    const t = headlessTurn(spec("codex"));
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const fs = t.argv.find((x) => x.startsWith("permissions.agx_worker.filesystem="))!;
    expect(fs).toContain('"/w/tree"="write"');
    expect(fs).toContain('"/w/run"="write"');
    expect(fs).toMatch(/agentglass"="none"/);
  });
  test("a read-only role gets no write on the tree", () => {
    const t = headlessTurn(spec("codex", { role: { ...workerRole("builder")!, readOnly: true } }));
    if (!t.ok) throw new Error(t.error);
    const fs = t.argv.find((x) => x.startsWith("permissions.agx_worker.filesystem="))!;
    expect(fs).not.toContain('"/w/tree"="write"');
  });
});

describe("codex deny list", () => {
  test("a symlinked state dir is denied by its real path as well", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "agx-wall-")));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    const was = process.env.AGENTGLASS_STATE_DIR;
    process.env.AGENTGLASS_STATE_DIR = join(base, "link");
    try {
      const d = codexDeniedDirs();
      expect(d).toContain(join(base, "link"));
      expect(d).toContain(join(base, "real"));
    } finally {
      if (was === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = was;
    }
  });
});

describe("hermes has no wall", () => {
  test("refused by default (no bwrap), and the refusal names the setting", () => {
    const path = process.env.PATH; process.env.PATH = "/nonexistent"; resetBwrapProbe();
    const t = headlessTurn(spec("hermes"));
    process.env.PATH = path; resetBwrapProbe();
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toContain("workers.unwalledEngines");
  });
  test("runs once the person turned the setting on", () => {
    expect(headlessTurn(spec("hermes", { unwalledEngines: true })).ok).toBe(true);
  });
  test("an agent cannot turn the setting on", () => {
    expect(agentVerdict("workers.unwalledEngines", false, true, true)).toBe("refuse");
  });
});

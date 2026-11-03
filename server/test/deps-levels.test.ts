import { describe, expect, it } from "bun:test";
import {
  DEPS,
  depSpec,
  levelFor,
  needsYou,
  type DepReport,
  type DepStatus,
} from "../../shared/deps.ts";
import { claudeEvidence, tmuxDependencyRow } from "../src/deps.ts";
import type { TmuxBinStatus } from "../src/tmuxbin.ts";

/**
 * The three levels, and the two facts that decide who counts.
 *
 * `needed` is the only level that reaches the counter; the picked agent is the
 * one agent row that can be needed; and an installed tool that is not usable is
 * a row with a next step, not an install.
 */
const row = (id: string, status: DepStatus, extra: Partial<DepReport> = {}): DepReport => ({
  ...depSpec(id as never)!,
  status,
  ...extra,
});

describe("dependency levels", () => {
  it("gives every entry exactly one level, and derives required from it", () => {
    for (const d of DEPS) {
      expect(["needed", "recommended", "optional"]).toContain(d.level);
      expect(d.required).toBe(d.level === "needed");
    }
    expect(DEPS.filter((d) => d.level === "needed").map((d) => d.id).sort()).toEqual(["claude", "git", "python"]);
    expect(DEPS.filter((d) => d.level === "recommended").map((d) => d.id).sort()).toEqual(["gh", "tmux"]);
  });

  it("counts only a needed tool, and only the picked agent among the CLIs", () => {
    expect(needsYou(row("docker", "attention"), "claude")).toBe(false);
    expect(needsYou(row("gh", "missing"), "claude")).toBe(false);
    expect(needsYou(row("git", "missing"), "claude")).toBe(true);
    expect(needsYou(row("claude", "attention"), "claude")).toBe(true);
    // A non-Claude pick: the picked row counts, Claude's does not.
    expect(needsYou(row("opencode", "missing"), "opencode")).toBe(true);
    expect(needsYou(row("claude", "missing"), "opencode")).toBe(false);
    expect(needsYou(row("git", "ok"), "claude")).toBe(false);
  });

  it("computes the level per run, never from the catalogue alone", () => {
    expect(levelFor(depSpec("opencode")!, "opencode")).toBe("needed");
    expect(levelFor(depSpec("opencode")!, "claude")).toBe("optional");
    expect(levelFor(depSpec("claude")!, "opencode")).toBe("optional");
    expect(levelFor(depSpec("gh")!, "claude")).toBe("recommended");
  });
});

describe("the claude row shares step 1's answer", () => {
  it("is attention when installed and not signed in", () => {
    expect(claudeEvidence(true, false, "2.1.316")).toMatchObject({ status: "attention" });
    expect(claudeEvidence(true, false, "2.1.316").detail).toContain("not signed in");
  });
  it("is ready when signed in, and missing when absent", () => {
    expect(claudeEvidence(true, true, "2.1.316")).toMatchObject({ status: "ok", detail: "2.1.316" });
    expect(claudeEvidence(false, null, null)).toMatchObject({ status: "missing" });
    // A probe that could not answer is not a lie in either direction.
    expect(claudeEvidence(true, null, null)).toMatchObject({ status: "ok" });
  });
});

describe("the tmux row answers available, and carries the source", () => {
  const status = (source: TmuxBinStatus["source"], available = true): TmuxBinStatus => ({
    available, source, path: "/usr/bin/tmux", version: available ? "tmux 3.5a" : null,
    reason: available ? "" : "AGENTGLASS_TMUX_PATH is set to /nope, which is not executable",
  });

  for (const source of ["bundled", "system", "env", "custom"] as const) {
    it(`offers nothing to install when ${source} supplies it`, () => {
      const row = tmuxDependencyRow(status(source));
      expect(row.status).toBe("ok");
      expect(row.tmuxSource).toBe(source);
      expect(row.install).toBeUndefined();
      expect(row.detail).toBe("tmux 3.5a");
    });
  }

  it("offers Install when there is none", () => {
    const row = tmuxDependencyRow(status("none", false));
    expect(row.status).toBe("missing");
    expect(row.install).toBeTruthy();
  });

  it("offers Install and the status's reason for a broken override", () => {
    const row = tmuxDependencyRow(status("env", false));
    expect(row.status).toBe("missing");
    expect(row.install).toBeTruthy();
    expect(row.detail).toContain("not executable");
  });
});

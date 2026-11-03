import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { depSpec, needsYou, type DepReport, type DepStatus, type DepsResponse } from "../../shared/deps.ts";
import {
  fixableRows,
  needsCount,
  readyCount,
  toolGroups,
  toolRow,
  tmuxSourceLine,
} from "../src/lib/setupTools.ts";
import { ToolRow } from "../src/components/setup/ToolsStep.tsx";

/**
 * The wizard's two counters and the Connections badge are one answer.
 *
 * The clean-install bug was two screens disagreeing about the same machine, so
 * the number is asserted against one fixture twice: the wizard's counter and
 * the expression the Connections page counts with.
 */
const row = (id: string, status: DepStatus, extra: Partial<DepReport> = {}): DepReport => ({
  ...depSpec(id as never)!,
  status,
  ...extra,
});

/** One machine: the three needed tools ready, one recommended waiting, and
 *  three optional ones that are installed but not working. */
const report: DepsResponse = {
  platform: "linux",
  manager: "apt",
  deps: [
    row("git", "ok", { detail: "2.47.1" }),
    row("claude", "ok", { detail: "2.1.316" }),
    row("python", "ok", { detail: "/usr/bin/python3" }),
    row("tmux", "ok", { detail: "tmux 3.5a", tmuxSource: "bundled", install: undefined }),
    row("gh", "attention", { detail: "not logged in yet", signIn: "gh auth login" }),
    row("docker", "attention", { detail: "the daemon is not responding" }),
    row("task", "attention", { detail: "its data store has not been created yet" }),
    row("nvim", "missing", { install: "sudo apt-get install -y neovim" }),
    row("whisper", "ok", { detail: "1.7.2" }),
    row("script", "unsupported"),
  ],
};

describe("the wizard's counters", () => {
  it("counts ready only among the two counted groups", () => {
    // git, claude, python, tmux; nvim (optional) and the unsupported row never add.
    expect(readyCount(report, "claude")).toBe(4);
  });

  it("counts needs you over the needed rows only, picked agent included", () => {
    expect(needsCount(report, "claude")).toBe(0);
    const unsigned = { ...report, deps: report.deps.map((d) => d.id === "claude" ? { ...d, status: "attention" as const } : d) };
    expect(needsCount(unsigned, "claude")).toBe(1);
    expect(needsCount(unsigned, "opencode")).toBe(0);
  });

  it("equals the Connections page's badge on the same fixture", () => {
    const connections = report.deps
      .filter((d) => d.status !== "unsupported")
      .filter((d) => needsYou(d, "claude")).length;
    expect(needsCount(report, "claude")).toBe(connections);
    // And with the picked agent unsigned, both still agree.
    const unsigned = { ...report, deps: report.deps.map((d) => d.id === "claude" ? { ...d, status: "attention" as const } : d) };
    expect(needsCount(unsigned, "claude")).toBe(
      unsigned.deps.filter((d) => d.status !== "unsupported").filter((d) => needsYou(d, "claude")).length,
    );
  });

  it("never adds the optional count to what needs you", () => {
    const withOptionalBroken = {
      ...report,
      deps: [...report.deps, row("whisper", "missing"), row("bwrap", "attention")],
    };
    expect(needsCount(withOptionalBroken, "claude")).toBe(0);
  });
});

describe("the groups", () => {
  it("puts the picked agent in Needed and every other agent row in Optional", () => {
    const withOpenCode = {
      ...report,
      deps: [...report.deps, row("opencode", "missing", { install: "npm i -g opencode-ai" })],
    };
    const groups = toolGroups(withOpenCode, "opencode");
    expect(groups.map((g) => g.level)).toEqual(["needed", "recommended", "optional"]);
    expect(groups[0]!.rows.map((d) => d.id)).toEqual(["git", "python", "opencode"]);
    expect(groups[2]!.rows.map((d) => d.id)).toContain("claude");
    expect(needsCount(withOpenCode, "opencode")).toBe(1);
  });

  it("lists git, python and the picked agent in reading order", () => {
    expect(toolGroups(report, "claude")[0]!.rows.map((d) => d.id)).toEqual(["git", "python", "claude"]);
  });

  it("offers Fix all only the needed rows that are not ok", () => {
    const unsigned = { ...report, deps: report.deps.map((d) => d.id === "claude" ? { ...d, status: "attention" as const } : d) };
    expect(fixableRows(unsigned, "claude").map((d) => d.id)).toEqual(["claude"]);
    expect(fixableRows(report, "claude")).toEqual([]);
  });
});

describe("one row's words", () => {
  it("names the next step for an installed tool that is not usable", () => {
    expect(toolRow(row("gh", "attention", { signIn: "gh auth login" }))).toMatchObject({
      state: "Installed, not signed in",
      action: { label: "Sign in", command: "gh auth login" },
    });
    expect(toolRow(row("task", "attention", { signIn: "task" }))).toMatchObject({
      state: "Installed, not set up", action: { label: "Set up", command: "task" },
    });
  });

  it("gives Docker a sentence and no command", () => {
    const docker = toolRow(row("docker", "attention"));
    expect(docker.state).toBe("Daemon off");
    expect(docker.action).toBeUndefined();
    expect(docker.help).toContain("never starts it");
  });

  it("says where tmux came from only when it is here", () => {
    expect(tmuxSourceLine("bundled")).toContain("brought its own");
    expect(tmuxSourceLine("system")).toContain("already on this machine");
    expect(tmuxSourceLine("env")).toContain("you chose");
    expect(tmuxSourceLine("none")).toBeNull();
    expect(toolRow(row("tmux", "ok", { detail: "tmux 3.5a", tmuxSource: "bundled" })).help)
      .toContain("brought its own");
  });
});

describe("the Connections page's install button", () => {
  it("is offered for a missing tool, and never for one that is installed", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "components", "SettingsModal.tsx"), "utf8");
    expect(source).toContain("const canType = d.status === \"missing\"");
    expect(source).toContain("needsYou(d, pickedAgent())");
  });
});

describe("a command the rows cut short", () => {
  it("carries the whole line, so the part past the ellipsis is still readable", () => {
    const install = "curl -fsSL https://claude.ai/install.sh | bash";
    const html = renderToStaticMarkup(React.createElement(ToolRow, {
      row: toolRow(row("claude", "missing", { install })), open: true, onToggle: () => {}, onCopy: () => {},
    }));
    expect(html).toContain(`title="${install}"`);
  });
});

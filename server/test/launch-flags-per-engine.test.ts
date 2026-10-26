/**
 * Every engine gets each permission mode it has a flag for (launchperm.ts),
 * and a person's own words for a mode win. The mapping is read off each CLI's
 * `--help` or docs (shared/agentKinds.ts); a CLI with no equivalent for a mode
 * starts in its own default, and Claude's argv is the one it always had.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROVIDERS } from "../../shared/agentKinds.ts";
import { LAUNCH_MODES, parseFlagLine } from "../../shared/launchModes.ts";
import { launchFlags, type LaunchPerm } from "../src/launchperm.ts";
import { launchFlagOverrides, writeLaunchFlagOverrides } from "../src/config.ts";
import { supportsFlag } from "../src/agents/launch.ts";

const prevXdg = process.env.XDG_CONFIG_HOME;
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-permflags-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

const perm = (mode: LaunchPerm["mode"]): LaunchPerm => ({ mode, deny: ["Edit"] });
const yes = () => true;

describe("engine × mode", () => {
  test.each([
    ["codex", "default", []],
    ["codex", "acceptEdits", []],
    ["codex", "auto", ["--approve-for-me"]],
    ["codex", "bypassPermissions", ["--dangerously-bypass-approvals-and-sandbox"]],
    ["opencode", "default", []],
    ["opencode", "acceptEdits", []],
    ["opencode", "auto", []],
    ["opencode", "bypassPermissions", ["--auto"]],
    ["hermes", "auto", []],
    ["hermes", "bypassPermissions", ["--yolo"]],
    ["gemini", "default", ["--approval-mode", "default"]],
    ["gemini", "acceptEdits", ["--approval-mode", "auto_edit"]],
    ["gemini", "auto", []],
    ["gemini", "bypassPermissions", ["--approval-mode", "yolo"]],
    ["qwen", "acceptEdits", ["--approval-mode", "auto-edit"]],
    ["qwen", "auto", ["--approval-mode", "auto"]],
    ["qwen", "bypassPermissions", ["--approval-mode", "yolo"]],
    ["antigravity", "bypassPermissions", []],
  ] as const)("%s in %s", (kind, mode, argv) => {
    expect(launchFlags(kind, perm(mode), yes)).toEqual([...argv]);
  });

  test("the deny list is Claude's alone", () => {
    for (const k of AGENT_PROVIDERS.filter((p) => p.id !== "claude"))
      for (const m of LAUNCH_MODES) expect(launchFlags(k.id, perm(m), yes)).not.toContain("--disallowedTools");
  });

  test("Claude's argv is byte-identical to what it always was", () => {
    for (const m of LAUNCH_MODES) {
      expect(launchFlags("claude", { mode: m, deny: ["Edit", "Bash(rm:*)"] }, () => false))
        .toEqual(["--disallowedTools", "Edit Bash(rm:*)", "--permission-mode", m]);
      expect(launchFlags("claude", { mode: m, deny: [] })).toEqual(["--permission-mode", m]);
    }
  });

  test("a flag the binary does not list drops the whole mode", () => {
    const knowsApproval = (_b: string, f: string) => f !== "--approval-mode";
    expect(launchFlags("gemini", perm("acceptEdits"), knowsApproval)).toEqual([]);
    expect(launchFlags("gemini", perm("acceptEdits"), yes)).toEqual(["--approval-mode", "auto_edit"]);
  });

  test("no mode is looser than the one it is named for", () => {
    // OpenCode's only flag is auto-approve-everything: bypass, never auto.
    expect(launchFlags("opencode", perm("auto"), yes)).toEqual([]);
    // Codex has no combination that asks before a shell command and lets edits through.
    expect(launchFlags("codex", perm("acceptEdits"), yes)).toEqual([]);
  });

  test("a --help that hangs counts as a flag the CLI does not take", () => {
    const bin = join(dir, "hang-cli");
    writeFileSync(bin, "#!/bin/sh\necho '  --approval-mode <m>'\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const t0 = Date.now();
    expect(supportsFlag(bin, "--approval-mode")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test("supportsFlag reads a real --help", () => {
    const bin = join(dir, "fake-cli");
    writeFileSync(bin, "#!/bin/sh\necho '  --approval-mode <m>   how to ask'\n");
    chmodSync(bin, 0o755);
    expect(supportsFlag(bin, "--approval-mode")).toBe(true);
    expect(supportsFlag(bin, "--yolo")).toBe(false);
  });
});

describe("a person's own flags", () => {
  test("an override wins for its mode only, and an empty object resets it", () => {
    expect(writeLaunchFlagOverrides("codex", { auto: "--sandbox read-only" }).ok).toBe(true);
    expect(launchFlags("codex", perm("auto"), yes)).toEqual(["--sandbox", "read-only"]);
    expect(launchFlags("codex", perm("bypassPermissions"), yes)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(writeLaunchFlagOverrides("codex", {}).ok).toBe(true);
    expect(launchFlagOverrides().codex).toBeUndefined();
    expect(launchFlags("codex", perm("auto"), yes)).toEqual(["--approve-for-me"]);
  });

  test("an empty line means no flags, not the built-in ones", () => {
    expect(writeLaunchFlagOverrides("codex", { bypassPermissions: "" }).ok).toBe(true);
    expect(launchFlags("codex", perm("bypassPermissions"), yes)).toEqual([]);
    writeLaunchFlagOverrides("codex", {});
  });

  test.each(["--a; rm -rf /", "--a $(id)", "--a `id`", "--a | b", "--a\n--b", "--a 'b'", "--a &"])("refuses %j", (line) => {
    expect(parseFlagLine(line).ok).toBe(false);
    expect(writeLaunchFlagOverrides("codex", { auto: line }).ok).toBe(false);
    expect(launchFlagOverrides().codex).toBeUndefined();
  });

  test.each([
    "-c sandbox_mode=danger-full-access", "--config=x", "--config x", "-cfoo=bar", "-C elsewhere", "--profile=x",
    "--cd=x", "--add-dir x", "--mcp-config x", "--settings=x", "--env=x", "--approval-mode /tmp/x", "--exec x",
  ])("a person keeps flags, not config: refuses %j", (line) => {
    expect(parseFlagLine(line).ok).toBe(false);
    expect(writeLaunchFlagOverrides("codex", { default: line }).ok).toBe(false);
  });

  test("still takes a plain flag and value", () => {
    expect(parseFlagLine("--sandbox read-only --ask-for-approval on-request").ok).toBe(true);
  });

  test("Claude's mode is never retyped", () => {
    expect(writeLaunchFlagOverrides("claude", { default: "--x" }).ok).toBe(false);
    expect(launchFlagOverrides().claude).toBeUndefined();
  });

  test("refuses an unknown engine or mode, and too many words", () => {
    expect(writeLaunchFlagOverrides("nope", { auto: "--x" }).ok).toBe(false);
    expect(writeLaunchFlagOverrides("codex", { plan: "--x" }).ok).toBe(false);
    expect(parseFlagLine(Array(13).fill("--x").join(" ")).ok).toBe(false);
  });
});

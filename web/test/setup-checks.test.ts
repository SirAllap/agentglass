/*
 * Setup step 6, Checks: the rows, their one Fix each, and the tally.
 *
 * Pure: the four answers go in, the rows come out. The step itself is read
 * from source only for the two promises a row cannot make: it is the sixth
 * step, and Finish is never blocked by it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DepReport } from "../../shared/deps.ts";
import type { AgentProbe, BrowserUseStatus } from "../../shared/types.ts";
import { checkRows, checksNeedingYou, type CheckInput } from "../src/lib/setupChecks.ts";

const tmux = (status: DepReport["status"], more: Partial<DepReport> = {}) =>
  ({ id: "tmux", title: "tmux", status, ...more }) as DepReport;
const agent = (label: string, found: boolean) => ({ id: label, label, found }) as AgentProbe;
const browser = (cli: BrowserUseStatus["cli"]["state"], skill: BrowserUseStatus["skill"]["state"], desktop = true) =>
  ({ cli: { state: cli, path: "", target: null }, skill: { state: skill, path: "", shipped: null }, windows: 1, desktop }) as BrowserUseStatus;

const allGood: CheckInput = {
  tmux: tmux("ok", { detail: "3.5a" }),
  agents: [agent("Claude Code", true), agent("OpenCode", true)],
  agentInstall: "npm i -g thing",
  browser: browser("installed", "current"),
  notify: "granted",
};

describe("the rows", () => {
  test("all good: four green rows, nothing needs you", () => {
    const rows = checkRows(allGood);
    expect(rows.map((r) => [r.id, r.tone])).toEqual([["tmux", "ok"], ["agents", "ok"], ["browser", "ok"], ["notify", "ok"]]);
    expect(rows[1]!.detail).toBe("Claude Code · OpenCode");
    expect(rows[1]!.fix?.kind).toBe("recheck");
    expect(checksNeedingYou(rows)).toBe(0);
  });

  test("the mock's case: browser tools and notifications need you", () => {
    const rows = checkRows({ ...allGood, browser: browser("missing", "missing"), notify: "default" });
    expect(rows.find((r) => r.id === "browser")).toMatchObject({ tone: "warn", fix: { kind: "browserInstall" } });
    expect(rows.find((r) => r.id === "notify")).toMatchObject({ tone: "bad", fix: { kind: "notify" } });
    expect(checksNeedingYou(rows)).toBe(2);
  });

  test("tmux missing copies its install line; tmux not answering only explains", () => {
    expect(checkRows({ ...allGood, tmux: tmux("missing", { install: "sudo pacman -S tmux" }) })[0])
      .toMatchObject({ tone: "bad", fix: { kind: "copy", line: "sudo pacman -S tmux" } });
    expect(checkRows({ ...allGood, tmux: tmux("attention", { detail: "server down" }) })[0])
      .toMatchObject({ tone: "warn", detail: "server down", fix: { kind: "osHelp" } });
  });

  test("tmux not used on this platform draws no row", () => {
    expect(checkRows({ ...allGood, tmux: tmux("unsupported", { detail: "not used on win32" }) }).map((r) => r.id))
      .not.toContain("tmux");
  });

  test("no tmux state gives a Fix that resets or kills the tmux server", () => {
    for (const s of ["ok", "attention", "missing", "unsupported"] as const) {
      const row = checkRows({ ...allGood, tmux: tmux(s, { install: "x" }) }).find((r) => r.id === "tmux");
      expect(["copy", "osHelp", undefined]).toContain(row?.fix?.kind);
    }
    const step = readFileSync(new URL("../src/components/setup/ChecksStep.tsx", import.meta.url), "utf8");
    expect(step).not.toMatch(/tmuxReset|kill-server|kill-session/);
  });

  test("no agent found copies the picked agent's install line", () => {
    const row = checkRows({ ...allGood, agents: [agent("Claude Code", false)] })[1]!;
    expect(row).toMatchObject({ tone: "bad", fix: { kind: "copy", line: "npm i -g thing" } });
    expect(checkRows({ ...allGood, agents: [], agentInstall: null })[1]!.fix?.kind).toBe("recheck");
  });

  test("denied notifications cannot be asked again: Fix says how to allow it", () => {
    const row = checkRows({ ...allGood, notify: "denied" }).find((r) => r.id === "notify")!;
    expect(row.fix).toMatchObject({ kind: "osHelp" });
    expect(row.fix?.kind === "osHelp" && row.fix.help).toContain("system's notification settings");
  });

  test("rows with nothing to read are left out", () => {
    const ids = checkRows({ ...allGood, browser: browser("missing", "missing", false), notify: null }).map((r) => r.id);
    expect(ids).toEqual(["tmux", "agents"]);
  });

  test("rows still being read are drawn but not counted", () => {
    const rows = checkRows({ ...allGood, tmux: undefined, agents: null });
    expect(rows.filter((r) => r.pending).map((r) => r.id)).toEqual(["tmux", "agents"]);
    expect(checksNeedingYou(rows)).toBe(0);
  });
});

describe("the rows added for gh, the port and the hooks", () => {
  test("gh: not installed explains, not signed in copies the login line, signed in is green", () => {
    expect(checkRows({ ...allGood, gh: { available: false, authed: false } }).find((r) => r.id === "gh"))
      .toMatchObject({ tone: "warn", fix: { kind: "osHelp" } });
    expect(checkRows({ ...allGood, gh: { available: true, authed: false } }).find((r) => r.id === "gh"))
      .toMatchObject({ tone: "warn", fix: { kind: "copy", line: "gh auth login" } });
    expect(checkRows({ ...allGood, gh: { available: true, authed: true, login: "octo" } }).find((r) => r.id === "gh"))
      .toMatchObject({ tone: "ok", detail: "Signed in as octo", fix: null });
    expect(checkRows({ ...allGood, gh: null }).map((r) => r.id)).not.toContain("gh");
  });

  test("port: a window on another port warns and names both numbers; the same port is green", () => {
    const moved = checkRows({ ...allGood, ports: { preferredPort: 4000, port: 4123 } }).find((r) => r.id === "port")!;
    expect(moved.tone).toBe("warn");
    expect(moved.detail).toContain("4123");
    expect(moved.detail).toContain("4000");
    expect(moved.fix?.kind).toBe("osHelp");
    expect(checkRows({ ...allGood, ports: { preferredPort: 4000, port: 4000 } }).find((r) => r.id === "port"))
      .toMatchObject({ tone: "ok", fix: null });
    expect(checkRows({ ...allGood, ports: null }).map((r) => r.id)).not.toContain("port");
  });

  test("hooks: not installed offers the install call; installed is green", () => {
    expect(checkRows({ ...allGood, hooks: false }).find((r) => r.id === "hooks"))
      .toMatchObject({ tone: "warn", fix: { kind: "hooksInstall" } });
    expect(checkRows({ ...allGood, hooks: true }).find((r) => r.id === "hooks"))
      .toMatchObject({ tone: "ok", fix: null });
    expect(checkRows({ ...allGood, hooks: null }).map((r) => r.id)).not.toContain("hooks");
  });

  test("the step reads all three and wires the hooks Fix to api.hooksInstall", () => {
    const src = readFileSync(new URL("../src/components/setup/ChecksStep.tsx", import.meta.url), "utf8");
    expect(src).toContain("api.prCapability(");
    expect(src).toContain("api.hooksStatus(");
    expect(src).toContain("noticePorts(");
    expect(src).toContain("api.hooksInstall(");
  });
});

describe("the step", () => {
  const flow = readFileSync(new URL("../src/components/setup/SetupFlow.tsx", import.meta.url), "utf8");

  test("is the sixth entry and draws ChecksStep", () => {
    expect(flow).toContain('{ id: "checks", title: "Checks", sub: "Is it all working" },');
    expect(flow).toContain("{step === 5 && <ChecksStep");
  });

  test("Finish is never blocked by a red row", () => {
    const blocked = flow.slice(flow.indexOf("const blocked ="), flow.indexOf(";", flow.indexOf("const blocked =")));
    expect(blocked).not.toContain("checks");
    expect(blocked).not.toContain("step === 5");
  });

  test("never uses title=", () => {
    const src = readFileSync(new URL("../src/components/setup/ChecksStep.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/\stitle=/);
  });
});

describe("the AppImage FUSE note", () => {
  test("README names FUSE and the launch script says what to install", async () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("libfuse2");
    const dir = mkdtempSync(join(tmpdir(), "agx-fuse-"));
    const fake = join(dir, "fake.AppImage");
    writeFileSync(fake, '#!/bin/sh\necho "ran $*"\n', { mode: 0o755 });
    const script = fileURLToPath(new URL("../../scripts/run-appimage.sh", import.meta.url));
    const r = spawnSync("sh", [script, fake], { env: { ...process.env, AGX_FAKE_NO_FUSE: "1" }, encoding: "utf8" });
    expect(r.stderr).toContain("libfuse2");
    expect(r.stdout).toContain("ran --appimage-extract-and-run");
  });

  // The real detection, no fake flag. A stub fusermount is on PATH and the lib
  // list names three paths. `present` is the one that exists, or none.
  const launch = (present: "a" | "b" | "c" | null) => {
    const dir = mkdtempSync(join(tmpdir(), "agx-fuse-real-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "fusermount"), "#!/bin/sh\n", { mode: 0o755 });
    const libs = (["a", "b", "c"] as const).map((n) => join(dir, n, "libfuse.so.2"));
    if (present) {
      mkdirSync(join(dir, present));
      writeFileSync(join(dir, present, "libfuse.so.2"), "");
    }
    const app = join(dir, "fake.AppImage");
    writeFileSync(app, '#!/bin/sh\necho "ran $*"\n', { mode: 0o755 });
    const script = fileURLToPath(new URL("../../scripts/run-appimage.sh", import.meta.url));
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, AGX_FUSE_LIBS: libs.join(" ") };
    delete env.AGX_FAKE_NO_FUSE;
    return spawnSync("sh", [script, app], { env, encoding: "utf8" });
  };

  test("libfuse2 at only one of the paths counts as installed", () => {
    for (const where of ["a", "b", "c"] as const) {
      const r = launch(where);
      expect(r.stderr).not.toContain("not installed");
      expect(r.stdout).not.toContain("--appimage-extract-and-run");
      expect(r.stdout).toContain("ran");
    }
  });

  test("libfuse2 at none of the paths says what to install and runs unpacked", () => {
    const r = launch(null);
    expect(r.stderr).toContain("FUSE 2 is not installed");
    expect(r.stdout).toContain("ran --appimage-extract-and-run");
  });
});

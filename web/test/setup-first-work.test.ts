/*
 * Step 5, apart from its screen: which projects are shown, what the primary
 * says, and the one ticket it asks for.
 *
 * The ticket is asserted through an injected mint, so "asked in this project
 * with this agent" is a fact about the call and not a string in the source.
 * The strings the step draws are read from the component, because this repo
 * has no DOM harness.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EngineReadiness, GitRepoRef } from "../../shared/types.ts";
import {
  PROJECT_TILES, engineFor, firstWorkProjects, firstWorkView, openFirstWork, projectLabel,
  projectTileLines, projectTiles, workedAgo,
} from "../src/lib/setupFirstWork.ts";

const repo = (root: string, over: Partial<GitRepoRef> = {}): GitRepoRef => ({
  root, name: root.split("/").pop()!, branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt: Date.now() - 3600_000, ...over,
});
const engine = (over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id: "opencode", title: "OpenCode", found: true, path: "/usr/bin/opencode", version: "1.2.3",
  min: null, versionOk: true, account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } }, missing: [],
  envelope: { via: null, enforced: "no", note: "" }, ...over,
});

const four = ["/home/acme/code/orbit", "/home/acme/code/harbour", "/home/acme/code/ledger-api", "/home/acme/code/orbit-docs"];
const projects = firstWorkProjects(four.map((r) => repo(r)), four);
const project = projects[0]!;

describe("the project tiles", () => {
  test("three are shown and a fourth goes behind N more", () => {
    const t = projectTiles(projects);
    expect(t.shown).toHaveLength(PROJECT_TILES);
    expect(t.more).toBe(1);
    expect(projectTiles(projects.slice(0, 2)).more).toBe(0);
  });

  test("the order is the workspace's, not the git answer's", () => {
    const listed = [repo(four[3]!), repo(four[0]!)];
    expect(firstWorkProjects(listed, [four[0]!, four[3]!]).map((p) => p.root)).toEqual([four[0]!, four[3]!]);
  });

  test("nothing imported is no project, even though git knows the machine's repos", () => {
    expect(firstWorkProjects([repo(four[0]!), repo(four[1]!)], [])).toEqual([]);
  });

  test("a forty-character name is cut and its full value is still the tile's title", () => {
    const long = "a".repeat(40);
    expect(projectLabel(long).length).toBeLessThanOrEqual(24);
    expect(projectLabel(long)).toContain("…");
    expect(projectTileLines({ ...project, name: long }).name).toBe(projectLabel(long));
    const src = readFileSync(new URL("../src/components/setup/FirstWorkStep.tsx", import.meta.url), "utf8");
    expect(src).toContain("title={p.name}");
    expect(src).toContain("title={selected.name}");
  });

  test("last worked in is one short line, never a date", () => {
    const now = Date.UTC(2026, 10, 1, 12);
    expect(workedAgo(now - 20 * 60_000, now)).toBe("worked 20m ago");
    expect(workedAgo(now - 5 * 3600_000, now)).toBe("worked 5h ago");
    expect(workedAgo(now - 3 * 86400_000, now)).toBe("worked 3d ago");
    expect(workedAgo(0, now)).toBe("not worked in yet");
  });
});

describe("what the primary and the sentences say", () => {
  test("the primary names the project, and the branch is on the step", () => {
    const v = firstWorkView({ engine: engine(), agent: "opencode", mode: "default", project });
    expect(v.primary).toBe("Open the terminal in orbit");
    expect(projectTileLines(project).branch).toBe("main");
    expect(v.action).toBe("agent");
  });

  test("an unsigned agent keeps the primary and says the pane will ask", () => {
    const v = firstWorkView({ engine: engine({ account: { signedIn: false } }), agent: "opencode", mode: "default", project });
    expect(v.primary).toBe("Open the terminal in orbit");
    expect(v.notice).toContain("OpenCode is not signed in");
    expect(v.notice).toContain("asks you to sign in there");
  });

  test("a missing agent switches to a shell and drops its name from the primary", () => {
    const v = firstWorkView({ engine: engine({ found: false }), agent: "opencode", mode: "default", project });
    expect(v.action).toBe("shell");
    expect(v.primary).toBe("Open a terminal in orbit anyway");
    expect(v.notice).toBe("OpenCode is not installed.");
  });

  test("zero projects is its own state, and nothing pretends to open", () => {
    const v = firstWorkView({ engine: engine(), agent: "opencode", mode: "default", project: null });
    expect(v).toMatchObject({ primary: "Pick a folder", blocked: false, action: "none" });
    expect(v.notice).toBe("A terminal needs a project to open in.");
  });

  test("the lock line names the agent and launch.mode's label", () => {
    expect(firstWorkView({ engine: engine(), agent: "opencode", mode: "default", project }).lock)
      .toBe("OpenCode starts in Ask — the mode Settings › Terminal sets. This screen does not change it.");
    expect(firstWorkView({ engine: engine(), agent: "opencode", mode: "bypassPermissions", project }).lock)
      .toContain("starts in Bypass");
  });

  test("an engine is found by the picked id, and an unread report says nothing", () => {
    expect(engineFor({ host: "acme-desk", engines: [engine()] }, "opencode")?.id).toBe("opencode");
    expect(engineFor(null, "opencode")).toBeUndefined();
  });
});

describe("the ticket", () => {
  test("it is asked in the project's cwd with the picked agent, never a literal claude", async () => {
    const calls: unknown[][] = [];
    let handed = null as { root: string; ticket: string } | null;
    const r = await openFirstWork(project, "opencode", {
      mint: async (...args) => { calls.push(args); return { ok: true, ticket: "tkt-orbit" }; },
      hand: (root, ticket) => { handed = { root, ticket }; },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([[project.root, "", false, "OpenCode", "opencode"]]);
    expect(handed).toEqual({ root: project.root, ticket: "tkt-orbit" });
  });

  test("a gone folder refuses, with the server's own sentence", async () => {
    const r = await openFirstWork(project, "opencode", {
      mint: async () => ({ ok: false, error: "that project is not open" }),
      hand: () => { throw new Error("handed a pane it did not have"); },
    });
    expect(r).toEqual({ ok: false, error: "that project is not open" });
  });

  test("a thrown request is the same refusal, not a crash", async () => {
    const r = await openFirstWork(project, "opencode", { mint: async () => { throw new Error("connection refused"); } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("connection refused");
  });

  test("the step never names claude where the picked agent belongs", () => {
    const lib = readFileSync(new URL("../src/lib/setupFirstWork.ts", import.meta.url), "utf8");
    expect(lib).not.toContain('"claude"');
    const src = readFileSync(new URL("../src/components/setup/FirstWorkStep.tsx", import.meta.url), "utf8");
    expect(src).not.toContain('"claude"');
    expect(src).toContain("openFirstWork(selected, agent)");
    expect(src).toContain("The terminal did not open:");
    expect(src).toContain("Try again");
  });
});

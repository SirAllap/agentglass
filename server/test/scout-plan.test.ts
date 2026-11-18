/*
 * A SCOUT'S PLAN IS SAVED FOR IT.
 *
 * A scout runs in plan mode: Write is closed, ExitPlanMode asks a person who is
 * not there, and Bash cannot write either — so its plan used to live only in
 * the turn's last message. Now the app writes that message to
 * `.agx-tmp/plan.md` in the scout's own checkout and sends it to the seat's
 * inbox, and the brief says so.
 *
 * No tmux and no engine: the turn's files are what the ending reads, and what
 * is under test is what the app does with them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-plan-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const AO = await import("../src/agentops.ts");
const { db } = await import("../src/db.ts");
const { saveScoutPlan } = await import("../src/agents/planout.ts");
const { prepareRun } = await import("../src/agents/headless.ts");
const { PLAN_FILE, PLAN_NOTE, withPlanNote } = await import("../src/rolePrompt.ts");
const { unreadReports } = await import("../src/seatreport.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");

const ROOT = "/home/a/code/orbit-plan";
const BY = {
  headless: true, turn: 1, turnMinutes: 30, role: "scout", engine: "claude",
  model: "claude-sonnet-5-5", position: 0, because: [], scope: "global", rule: "base", envelope: {},
};

/** A worker's checkout, one per test: the plan is written into it. */
let n = 0;
const checkout = () => { const d = join(dir, `wt-${++n}`); mkdirSync(d, { recursive: true }); return d; };
/** Git with the machine's own config out of the way: a personal
 *  `status.showUntrackedFiles` or an `init.templateDir` must not decide what
 *  these tests see. */
const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { env: gitEnv() });
/** The same, as a real checkout: the plan must not show up in its status. */
const repo = () => {
  const d = checkout();
  const init = git("init", "-q", d);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  return d;
};

/** A finished turn's row and its files, the way the ending leaves them. */
function ended(cwd: string, name: string, o: { by?: unknown; exit?: number; out?: string } = {}) {
  const startedAt = Date.now() - 60_000;
  db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, adopted, seat_root, started_by, exit_code, exit_line)
    VALUES (?1, 'claude', ?2, '%998', '@998', ?3, NULL, 0, ?4, ?5, ?6, '')
    ON CONFLICT(name) DO UPDATE SET cwd = ?2, started_at = ?3, ended_at = NULL, seat_root = ?4, started_by = ?5, exit_code = ?6`)
    .run(name, cwd, startedAt, ROOT, JSON.stringify(o.by ?? BY), o.exit ?? 0);
  const files = prepareRun(name, "plan the export", "none");
  writeFileSync(files.out, o.out ?? "1. Read the export route.\n2. Move the retry into it.\n");
  return AO.agentNamed(name)!;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a scout's plan", () => {
  test("is written to .agx-tmp/plan.md in its checkout, and sent to the seat", () => {
    const cwd = repo();
    const a = ended(cwd, "scout-plan");
    const saved = saveScoutPlan(a);
    expect(saved?.path).toBe(join(cwd, PLAN_FILE));
    expect(readFileSync(join(cwd, PLAN_FILE), "utf8")).toBe("1. Read the export route.\n2. Move the retry into it.\n");
    // The orchestrator reads its workers' reports in one place: this is one.
    const reports = unreadReports(ROOT).map((r) => r.raw);
    expect(reports.some((t) => t.includes("1. Read the export route."))).toBe(true);
    expect(reports.some((t) => t.includes(PLAN_FILE))).toBe(true);
  });

  test("leaves nothing untracked in the tree it planned about", () => {
    /* A scout's checkout is somebody else's tree. An untracked `plan.md` there
       is read by the next builder's `git status` and by a reviewer's diff as
       part of a change (the repo's own "nothing in the tree that is not the
       change"), so the plan's folder is put in the checkout's own ignore file. */
    const cwd = repo();
    writeFileSync(join(cwd, "README.md"), "# orbit\n");
    const a = ended(cwd, "scout-clean");
    expect(saveScoutPlan(a)?.text).toContain("Read the export route");
    expect(existsSync(join(cwd, PLAN_FILE))).toBe(true);
    const status = git("-C", cwd, "status", "--porcelain");
    expect(status.stdout.toString()).toBe("?? README.md\n");
    const ignored = git("-C", cwd, "check-ignore", "-q", PLAN_FILE);
    expect(ignored.exitCode).toBe(0);
    // Twice is one entry, not two.
    saveScoutPlan({ ...a, startedAt: a.startedAt + 1 });
    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l.trim() === ".agx-tmp/")).toHaveLength(1);
  });

  test("is not read through the machine's own git config", () => {
    /* The checkout is somebody else's tree and this app only asks git about it.
       A personal `status.showUntrackedFiles = no` (or an `init.templateDir`)
       made the status below empty on correct code, so the test passed or failed
       by whose machine ran it. */
    const cwd = repo();
    writeFileSync(join(cwd, "README.md"), "# orbit\n");
    const config = join(dir, "hostile-gitconfig");
    writeFileSync(config, "[status]\n\tshowUntrackedFiles = no\n");
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = config;
    delete process.env.GIT_CONFIG_NOSYSTEM;
    try {
      expect(saveScoutPlan(ended(cwd, "scout-hostile"))?.text).toContain("Read the export route");
      expect(git("-C", cwd, "status", "--porcelain").stdout.toString()).toBe("?? README.md\n");
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
    }
  });

  test("is taken whole from a TUI turn, even when it holds a JSON-looking line", () => {
    /* A TUI turn's `out` is plain text (`agents/tuiturn.ts`), and a plan may
       carry a fenced object: reading that line as a frame left no text, no
       plan, and "ended without a result" for a turn that answered. The stamp is
       what says which form the turn ran in. */
    const cwd = checkout();
    const plan = 'Retry the export:\n```json\n{"retry": { "attempts": 3 }}\n```\nDone.';
    const a = ended(cwd, "scout-json", { by: { ...BY, tui: true }, out: plan });
    expect(saveScoutPlan(a)?.text).toBe(plan);
    expect(readFileSync(join(cwd, PLAN_FILE), "utf8")).toBe(`${plan}\n`);
    // A row from before the TUI wrote frames to the same file, and is still read
    // as frames: its result frame is the plan.
    const old = ended(checkout(), "scout-frames", { out: '{"type":"result","result":"the framed plan"}\n' });
    expect(saveScoutPlan(old)?.text).toBe("the framed plan");
  });

  test("is nobody else's: a builder's result is not a plan", () => {
    const cwd = checkout();
    const a = ended(cwd, "builder-result", { by: { ...BY, role: "builder" } });
    expect(saveScoutPlan(a)).toBeNull();
    expect(existsSync(join(cwd, PLAN_FILE))).toBe(false);
  });

  test("is not written from a failed turn: a failure is not a plan", () => {
    const cwd = checkout();
    const a = ended(cwd, "scout-failed", { exit: 1 });
    expect(saveScoutPlan(a)).toBeNull();
    expect(existsSync(join(cwd, PLAN_FILE))).toBe(false);
  });

  test("is not invented when the scout left no message", () => {
    const cwd = checkout();
    const a = ended(cwd, "scout-empty", { out: "" });
    expect(saveScoutPlan(a)).toBeNull();
    expect(existsSync(join(cwd, PLAN_FILE))).toBe(false);
  });

  test("keeps an earlier plan: a second round rotates it to plan.1.md instead of overwriting it", () => {
    const cwd = checkout();
    const first = saveScoutPlan(ended(cwd, "scout-round1", { out: "Round 1: read the export route.\n" }));
    expect(first?.text).toContain("Round 1");
    const second = saveScoutPlan(ended(cwd, "scout-round2", { out: "Round 2: move the retry.\n" }));
    expect(second?.text).toContain("Round 2");
    expect(readFileSync(join(cwd, PLAN_FILE), "utf8")).toContain("Round 2");
    expect(readFileSync(join(cwd, ".agx-tmp", "plan.1.md"), "utf8")).toContain("Round 1");
    const third = saveScoutPlan(ended(cwd, "scout-round3", { out: "Round 3: ship it.\n" }));
    expect(third?.text).toContain("Round 3");
    expect(readFileSync(join(cwd, PLAN_FILE), "utf8")).toContain("Round 3");
    expect(readFileSync(join(cwd, ".agx-tmp", "plan.2.md"), "utf8")).toContain("Round 2");
    expect(readFileSync(join(cwd, ".agx-tmp", "plan.1.md"), "utf8")).toContain("Round 1");
  });

  test("a turn that answers with no real plan (exit 0, but nothing to replan) never overwrites the good one it followed", () => {
    const cwd = checkout();
    saveScoutPlan(ended(cwd, "scout-good", { out: "The good plan: read the export route.\n" }));
    const goodPath = join(cwd, PLAN_FILE);
    expect(readFileSync(goodPath, "utf8")).toContain("The good plan");
    // Exit 0, but the turn left nothing to save (e.g. "card not read"-style
    // answer `rolePlans` does not treat as a plan to write — modelled here as
    // an empty answer, the one case `saveScoutPlan` itself refuses to write).
    const empty = saveScoutPlan(ended(cwd, "scout-nothing", { out: "" }));
    expect(empty).toBeNull();
    expect(readFileSync(goodPath, "utf8")).toContain("The good plan");
    expect(existsSync(join(cwd, ".agx-tmp", "plan.1.md"))).toBe(false);
  });

  test("is saved once per turn, not once per look", () => {
    const cwd = checkout();
    const a = ended(cwd, "scout-once");
    saveScoutPlan(a);
    const before = unreadReports(ROOT).length;
    saveScoutPlan(a);
    expect(unreadReports(ROOT).length).toBe(before);
  });
});

describe("the brief says where the plan lands", () => {
  test("a scout is told, and a builder is not", () => {
    expect(withPlanNote("do the thing", ROOT, "scout")).toContain(PLAN_NOTE);
    expect(withPlanNote("do the thing", ROOT, "builder")).toBe("do the thing");
    // Idempotent: a resumed turn hands the same brief again.
    expect(withPlanNote(withPlanNote("do the thing", ROOT, "scout"), ROOT, "scout")).toBe(withPlanNote("do the thing", ROOT, "scout"));
  });

  test("a flow role that plans is told only when it really cannot write", () => {
    /* The note's first sentence is "You cannot write files in this turn". A flow
       role that only *runs as* a scout, with `readsOnly: false`, writes with
       `acceptEdits`; being told otherwise made it skip the writes it was
       started for, while the app saved its message as a plan regardless. */
    const root = join(dir, "flow-root");
    const f = templateFlow();
    f.roster = [
      ...f.roster,
      { ...f.roster[0]!, id: "arch", policyRole: "scout", readsOnly: false },
      { ...f.roster[0]!, id: "survey", policyRole: "scout", readsOnly: true },
    ];
    expect(writeStoredFlow(root, f).ok).toBe(true);
    expect(withPlanNote("do the thing", root, "arch")).toBe("do the thing");
    expect(withPlanNote("do the thing", root, "survey")).toContain(PLAN_NOTE);
  });

  test("an envelope that writes nothing is read-only too, and the role is told", () => {
    /* "Cautious" stores `workerDefault.write = "none"`, and the turn then has no
       edit tools and no writable worktree — the same state `readsOnly` names,
       reached without the role saying so. The note was withheld because only
       `readsOnly` was read, so a scout under that envelope was never told its
       plan is its last message. */
    const root = join(dir, "flow-cautious");
    const f = templateFlow();
    f.roster = [...f.roster, { ...f.roster[0]!, id: "arch", policyRole: "scout", readsOnly: false }];
    expect(writeStoredFlow(root, f).ok).toBe(true);
    expect(withPlanNote("do the thing", root, "arch", { write: "worktree" } as never)).toBe("do the thing");
    expect(withPlanNote("do the thing", root, "arch", { write: "none" } as never)).toContain(PLAN_NOTE);
  });

  test("the note names the file the app really writes", () => {
    expect(PLAN_NOTE).toContain(PLAN_FILE);
    expect(PLAN_FILE).toBe(".agx-tmp/plan.md");
  });
});

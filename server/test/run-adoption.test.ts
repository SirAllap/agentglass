// A run can contain a leg this app never started.
//
// This is the half of the run object worth defending, so it is the half with
// the tests. Fan-out — cut N worktrees, start N agents — is a loop, and every
// competitor has one. Adoption is a claim about the machine: that a pane a
// person opened by hand, running a CLI we did not configure, in a checkout we
// did not cut, can be tracked beside the ones we did.
//
// Three things can go wrong with that claim and each has a test below.
//
//   * The WRONG DIRECTORY. `pane_current_path` is the shell's directory, and on
//     a real machine several panes share one while the agent inside is off in a
//     worktree (that measurement is why paneloc.ts exists). A leg attached to
//     the shell's directory looks perfectly plausible and is simply wrong, so
//     the fixture makes the shell's directory the repo root and the agent's a
//     sibling worktree — if the resolution ever regresses, this fails.
//   * A CONFIDENT GUESS. Two agents under one pane has no right answer, and
//     picking one silently is worse than declining.
//   * TEARING DOWN SOMEBODY ELSE'S WORK. A losing leg we spawned is a checkout
//     we made and may remove. A losing leg we adopted is a person's afternoon.
//     The last test runs a real teardown over one of each and asserts the
//     directories that are still there afterwards.
import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-run-adopt-")));
const REPO = join(dir, "repo");
/** Cut with plain git, never through this app — the case the feature is for. */
const HAND = join(dir, "repo-handmade");
/** A different repository that happens to sit inside the same scope, so the
 *  refusal below is git's answer and not the scope check's. */
const OTHER = join(dir, "elsewhere");

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own runs.json
process.env.AGENTGLASS_DB = join(dir, "adopt.db");
// `bun test` runs every file in one process, so the scope left behind by
// whichever file ran before would otherwise decide whether git writes into this
// temp repo are allowed at all. Set here and again in beforeAll.
process.env.AGENTGLASS_ROOT = dir;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let runs: typeof import("../src/runs.ts");
let gitwork: typeof import("../src/gitwork.ts");

/** The pane rows adoption reads, in the shape tmuxctl's `listPanes` returns
 *  them. `path` is the SHELL's directory and `agentCwds` the directories the
 *  agent processes under the pane are really in — the distinction under test. */
const pane = (paneId: string, path: string, agentCwds: string[]) => ({ paneId, path, agentCwds });

/** No tmux server, and nothing on this machine is running a roster agent in a
 *  temp directory — so the observer answers the way it does on a Mac, and the
 *  caller's label is what is left. */
const deps = (panes: ReturnType<typeof pane>[], seen = "") => ({
  panes: () => panes,
  agentIn: () => seen,
});

/** A run to hang legs on: one spawned leg, cut for real by addWorktree, with
 *  the tmux window faked because a test has no tmux and does not need one. */
async function makeRun(prompt: string) {
  const r = await runs.startRun(REPO, prompt, [{ agent: "claude-code" }], {
    cut: (root, path, branch, from) => gitwork.addWorktree(root, path, branch, true, from),
    open: async () => ({ paneId: "%1", windowId: "@1" }),
    bin: () => "/bin/echo",
    exists: existsSync,
  });
  expect(r.ok).toBe(true);
  return r.run!;
}

/*
 * Every test starts from no runs at all.
 *
 * They share one hand-made checkout on purpose — it is the thing being adopted
 * — and a leg is an exclusive claim on a directory, so a run left over from the
 * previous test legitimately blocks the next adoption of it. That refusal is
 * the behaviour under test elsewhere in this file; here it would only be one
 * test leaking into the next.
 */
beforeEach(() => { runs.__clearRuns(); });

beforeAll(async () => {
  process.env.AGENTGLASS_ROOT = dir; // again: another file may have moved it
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "t");
  writeFileSync(join(REPO, "README"), "x\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "root");
  // By hand, with git, exactly as somebody at a terminal would. Nothing in this
  // app knows this directory exists until a pane in it is adopted.
  git(REPO, "worktree", "add", "-q", "-b", "handmade", HAND);
  mkdirSync(join(HAND, "sub"), { recursive: true });

  mkdirSync(OTHER, { recursive: true });
  git(OTHER, "init", "-q", "-b", "main");
  git(OTHER, "config", "user.email", "t@example.com");
  git(OTHER, "config", "user.name", "t");
  writeFileSync(join(OTHER, "README"), "y\n");
  git(OTHER, "add", "-A");
  git(OTHER, "commit", "-q", "-m", "root");

  gitwork = await import("../src/gitwork.ts");
  runs = await import("../src/runs.ts");
  runs.__clearRuns();
});

describe("a leg this app never started", () => {
  test("joins the run, in the directory the AGENT is in", async () => {
    const run = await makeRun("compare two approaches");
    // The shell sits in the repo root and the agent is in the worktree. Reading
    // the pane's own path would attach the leg to `repo` — plausible, and the
    // wrong checkout.
    const r = await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(r.ok).toBe(true);
    expect(r.leg!.worktree).toBe(HAND);
    expect(r.leg!.worktree).not.toBe(REPO);
    expect(r.leg!.branch).toBe("handmade");
    expect(r.leg!.origin).toBe("adopted");
    // Recorded as a leg of the run, beside the one we did spawn — which is the
    // entire product claim.
    expect(runs.runById(run.id)!.legs.map((l) => l.origin)).toEqual(["spawned", "adopted"]);
  });

  test("survives a reread, because it is on disk and not in memory", async () => {
    const run = await makeRun("persisted");
    await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    const again = runs.currentRuns(REPO).find((r) => r.id === run.id)!;
    expect(again.legs.some((l) => l.origin === "adopted" && l.worktree === HAND)).toBe(true);
  });

  test("names the vendor the machine can see, over the one the caller claims", async () => {
    const run = await makeRun("vendor");
    // The caller says gemini; the observer found codex running there. What is
    // measured wins — a hint is a fallback, not evidence.
    const r = await runs.adoptPane(run.id, "%7", "gemini", deps([pane("%7", REPO, [HAND])], "codex"));
    expect(r.leg!.agent).toBe("codex");
  });

  test("falls back to the caller's label only when nothing can be seen", async () => {
    const run = await makeRun("hint");
    const r = await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(r.leg!.agent).toBe("codex");
  });

  test("takes a label only from the roster, never an arbitrary string", async () => {
    const run = await makeRun("roster");
    const r = await runs.adoptPane(run.id, "%7", "; rm -rf /", deps([pane("%7", REPO, [HAND])]));
    expect(r.ok).toBe(true);
    expect(r.leg!.agent).toBe("");
  });

  test("an agent in a subdirectory belongs to the checkout above it", async () => {
    const run = await makeRun("monorepo");
    const r = await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [join(HAND, "sub")])]));
    expect(r.leg!.worktree).toBe(HAND);
  });

  test("a pane with no visible agent at all still works, via its own directory", async () => {
    // The macOS case, and the pane running something nobody has heard of. The
    // shell's directory is the weak answer, so it only gets through because git
    // confirms it is a checkout of this repository.
    const run = await makeRun("no proc");
    const r = await runs.adoptPane(run.id, "%7", "", deps([pane("%7", HAND, [])]));
    expect(r.ok).toBe(true);
    expect(r.leg!.worktree).toBe(HAND);
  });
});

describe("seeing the vendor on the machine", () => {
  // The observation adoption is built on, against a fabricated /proc rather
  // than the developer's own: what is under test is that a process name becomes
  // the roster id the rest of the app uses, and that the directory has to match
  // exactly. Linux-only for the reason paneloc.ts states — /proc is where this
  // answer lives, and elsewhere the caller's label is all there is.
  const PROC = join(dir, "proc");
  const fake = (pid: string, comm: string, cwd: string) => {
    mkdirSync(join(PROC, pid), { recursive: true });
    writeFileSync(join(PROC, pid, "comm"), `${comm}\n`);
    symlinkSync(cwd, join(PROC, pid, "cwd"));
  };

  test.skipIf(process.platform !== "linux")("turns a process name into a roster id", () => {
    fake("101", "fish", REPO);      // a shell, not an agent
    fake("102", "codex", HAND);
    fake("103", "claude", REPO);
    expect(runs.agentIn(HAND, PROC)).toBe("codex");
    expect(runs.agentIn(REPO, PROC)).toBe("claude-code");
  });

  test.skipIf(process.platform !== "linux")("says nothing about a directory with nobody in it", () => {
    expect(runs.agentIn(join(dir, "empty"), PROC)).toBe("");
  });
});

describe("what it refuses", () => {
  test("a pane holding two agents, rather than picking one", async () => {
    const run = await makeRun("ambiguous");
    const r = await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [HAND, REPO])]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("two agents");
    expect(runs.runById(run.id)!.legs).toHaveLength(1);
  });

  test("a pane in a different repository, even one inside the same scope", async () => {
    const run = await makeRun("other repo");
    const r = await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", OTHER, [OTHER])]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not in a checkout of repo");
  });

  test("a pane that is not on this machine", async () => {
    const run = await makeRun("ghost");
    const r = await runs.adoptPane(run.id, "%99", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not on this machine");
  });

  test("a second leg in a checkout the run already has", async () => {
    const run = await makeRun("duplicate checkout");
    await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    const again = await runs.adoptPane(run.id, "%8", "codex", deps([pane("%8", REPO, [HAND])]));
    expect(again.ok).toBe(false);
    expect(again.error).toContain("already has a leg");
  });

  test("but the SAME pane twice is somebody making sure, not a fault", async () => {
    const run = await makeRun("double click");
    const p = deps([pane("%7", REPO, [HAND])]);
    await runs.adoptPane(run.id, "%7", "codex", p);
    const again = await runs.adoptPane(run.id, "%7", "codex", p);
    expect(again.ok).toBe(true);
    expect(again.run!.legs).toHaveLength(2);
  });
});

describe("finishing a run", () => {
  test("removes the checkout we cut and leaves the one we adopted", async () => {
    const run = await makeRun("teardown");
    const spawned = run.legs[0]!.worktree;
    await runs.adoptPane(run.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(existsSync(spawned)).toBe(true);

    // Nothing wins: both are losers, which is the harshest version of the test.
    const r = await runs.finishRun(run.id, "", false);
    expect(r.ok).toBe(true);
    // The one we made is gone. The one somebody made by hand is untouched — if
    // this ever flips, the feature has deleted a person's work.
    expect(existsSync(spawned)).toBe(false);
    expect(existsSync(HAND)).toBe(true);
    expect(r.detail).toContain("left 1 adopted checkout alone");

    // The adopted leg is HANDED BACK, not recorded as a loser. It was never
    // ours to lose.
    expect(r.run!.legs.find((l) => l.origin === "adopted")!.state).toBe("released");

    /*
     * And the run lets go of the directory entirely.
     *
     * This is the assertion the feature exists for. A run retires once every
     * leg is `gone` or `released`, so once the checkouts we cut are removed and
     * the borrowed one is handed back, there is nothing left to track and the
     * run stops being listed. While the adopted leg was marked `lost` instead,
     * that condition could never be met: a directory somebody adopted for one
     * afternoon stayed claimed by that run for good, and no amount of finishing
     * it made any difference.
     */
    expect(runs.runById(run.id)).toBeNull();
    // Handed back, not deleted. If this ever flips, the feature has removed
    // somebody's work.
    expect(existsSync(HAND)).toBe(true);
  });

  test("refuses while a losing checkout we cut has uncommitted work in it", async () => {
    const run = await makeRun("dirty");
    const spawned = run.legs[0]!.worktree;
    writeFileSync(join(spawned, "half-done.txt"), "in progress\n");
    git(spawned, "add", "-A");

    const r = await runs.finishRun(run.id, "", false);
    expect(r.ok).toBe(false);
    expect(r.dirty).toHaveLength(1);
    expect(existsSync(spawned)).toBe(true);

    // Told twice, it goes.
    const forced = await runs.finishRun(run.id, "", true);
    expect(forced.ok).toBe(true);
    expect(existsSync(spawned)).toBe(false);
  });

  test("a checkout another live run is already working in is refused", async () => {
    /*
     * A leg is an exclusive claim on a directory, and the dashboard depends on
     * it: Fleet drops a claimed session from its project group so the run's lane
     * can draw it instead. Let two runs hold one checkout and the session is
     * removed once and drawn twice — one agent that looks like two, moving in
     * step, counted twice by anyone reading the wall.
     *
     * Refused on the server rather than de-duplicated on the client, because a
     * client would have to pick a winner and the two lanes would then disagree
     * about whose leg it is.
     */
    const first = await makeRun("holds it");
    const ok = await runs.adoptPane(first.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(ok.ok).toBe(true);

    const second = await makeRun("wants it too");
    const no = await runs.adoptPane(second.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(no.ok).toBe(false);
    expect(no.error).toContain("another run is already working in that checkout");
    // Named, so the refusal is actionable rather than a wall.
    expect(no.error).toContain("holds it");

    // And once the first run lets go, it is free again — the refusal is a claim,
    // not a permanent mark on the directory.
    await runs.finishRun(first.id, "", true);
    const again = await runs.adoptPane(second.id, "%7", "codex", deps([pane("%7", REPO, [HAND])]));
    expect(again.ok).toBe(true);
  });
});

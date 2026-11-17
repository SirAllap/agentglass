/*
 * Two guards inside the name's turn that the route cannot reach, so only a
 * direct call to the turn can pin them.
 *
 *   A seat that lost a race for a new name: the route looked, saw the name
 *   free, and by the time the turn ran another seat's finished worker was
 *   sitting on it. The turn asks again; without that, the second start empties
 *   the first seat's run folder before the spawn answers "exists".
 *
 *   A prompt whose worker stopped being one: the route saw a stamped row, an
 *   enlist replaced it with a hand-started one before the prompt's turn. The
 *   turn reads the row again; without a stamp there is no envelope to resume
 *   under, and reading `role` off nothing is a 500.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db.ts";
import { putSetting } from "../src/preflightStore.ts";
import * as P from "../src/agents/policystart.ts";
import { headlessTurn, runFiles } from "../src/agents/headless.ts";
import { agentNamed } from "../src/agentops.ts";
import { workerRole } from "../../shared/workerRoles.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-recheck-")));
const mine = join(dir, "orbit-mine");
const theirs = join(dir, "orbit-theirs");
beforeAll(() => { mkdirSync(mine); mkdirSync(theirs); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const readiness = async () => [{ id: "claude", path: "/bin/true", roles: { worker: { ok: true }, orchestrator: { ok: true } } } as never];
const seed = (name: string, seatRoot: string | null, startedBy: unknown = null) =>
  db.run(
    "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by) VALUES (?, 'claude', ?, '%9999', '@9999', ?, ?, ?, ?)",
    [name, theirs, Date.now(), Date.now(), seatRoot, startedBy ? JSON.stringify(startedBy) : null],
  );

describe("the name's turn asks again", () => {
  test("a name another seat's finished worker holds is refused, and its run folder is left alone", async () => {
    seed("w-race", theirs);
    const f = runFiles("w-race");
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(f.out, "their result");
    const r = await P.startThroughPolicy({
      root: mine, policyRoot: mine, name: "w-race", cwd: mine, prompt: "go", body: { role: "builder", engine: "claude" },
      seatRoot: mine, probe: readiness,
    });
    expect(r.body.error).toContain("belongs to the seat of orbit-theirs");
    expect(r.status).toBe(403);
    expect(existsSync(f.out)).toBe(true);
  });

  test("a prompt whose worker lost its stamp in between is refused, not a crash", async () => {
    seed("w-hand", mine);
    const stale = { ...agentNamed("w-hand")!, startedBy: { headless: true, role: "builder", engine: "claude", model: "sonnet", turn: 1 } } as never;
    const r = await P.promptHeadless(stale, "and then?");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("no longer a worker this app started");
  });
});

describe("a start refused for its name does not pay for the brief", () => {
  test("a name that is still running is refused before the prompt is asked", async () => {
    /* A tmux that cannot answer: every liveness read then says "still open", so
       the seeded row is a worker that is running without a real window. */
    const broken = join(dir, "broken-tmux");
    writeFileSync(broken, "#!/bin/sh\necho 'server exited unexpectedly' >&2\nexit 1\n");
    chmodSync(broken, 0o755);
    const saved = process.env.AGENTGLASS_TMUX_PATH;
    process.env.AGENTGLASS_TMUX_PATH = broken;
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by) VALUES (?, 'claude', ?, '%9999', '@9999', ?, NULL, NULL, NULL)",
      ["w-brief", mine, Date.now()],
    );
    try {
      let asked = false;
      const r = await P.startThroughPolicy({
        root: mine, policyRoot: mine, name: "w-brief", cwd: mine,
        prompt: () => { asked = true; return Promise.resolve("Plan ORBIT-1042."); },
        body: { role: "builder", engine: "claude" }, seatRoot: mine, probe: readiness,
      });
      expect(r.status).toBe(409);
      expect(String(r.body.error)).toContain("still running");
      expect(asked).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AGENTGLASS_TMUX_PATH;
      else process.env.AGENTGLASS_TMUX_PATH = saved;
      db.run("DELETE FROM named_agent WHERE name = ?", ["w-brief"]);
    }
  });
});

describe("a resumed worker whose stored envelope the ceiling no longer allows", () => {
  test("is clamped to the ceiling and its turn still goes on, not refused outright", async () => {
    const root = join(dir, "orbit-ceiling-wide");
    mkdirSync(root, { recursive: true });
    const broken = join(dir, "broken-tmux-ceiling");
    writeFileSync(broken, "#!/bin/sh\necho 'server exited unexpectedly' >&2\nexit 1\n");
    chmodSync(broken, 0o755);
    const saved = process.env.AGENTGLASS_TMUX_PATH;
    process.env.AGENTGLASS_TMUX_PATH = broken;
    const now = Date.now();
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by, resume_id, exit_code) VALUES (?, 'claude', ?, '%9998', '@9998', ?, ?, ?, ?, 'sess-clamp', 0)",
      [
        "w-ceiling-wide", root, now, now, root,
        JSON.stringify({
          scope: "global", rule: "base", because: [], position: 0, role: "builder", engine: "claude", model: "sonnet",
          // network and docker are both beyond DEFAULT_CEILING (network: false, docker: false).
          envelope: { write: "worktree", network: true, commit: true, docker: true, deny: [] }, headless: true, turnMinutes: 10, turn: 1,
        }),
      ],
    );
    try {
      const r = await P.promptHeadless({ name: "w-ceiling-wide", seatRoot: root, cwd: root } as never, "go on");
      // The ceiling check no longer ends the turn: whatever stops it from here
      // (the broken tmux this test forces) is a different error.
      expect(String(r.body.error ?? "")).not.toContain("ceiling no longer allows");
    } finally {
      if (saved === undefined) delete process.env.AGENTGLASS_TMUX_PATH; else process.env.AGENTGLASS_TMUX_PATH = saved;
      db.run("DELETE FROM named_agent WHERE name = ?", ["w-ceiling-wide"]);
    }
  });
});

describe("an unsandboxed shell is on the row, in the answer's own words", () => {
  test("the sentence is appended once, and a resume does not repeat it", () => {
    const envelope: import("../../shared/orchestration.ts").Envelope =
      { write: "worktree", network: false, commit: false, docker: true, deny: [] };
    const t = headlessTurn({
      engine: "claude", bin: "/bin/true", model: "sonnet", role: workerRole("scout")!, envelope,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "x", cwd: mine, runDir: join(mine, "run"),
      unwalledEngines: true,
    });
    if (!t.ok) throw new Error(t.error);
    const by = {
      scope: "project" as const, rule: "base", because: ["the policy"], position: 0,
      role: "scout", engine: "claude", model: "sonnet", envelope, headless: true as const, turn: 1,
    };
    const once = P.withSandboxNote(by, t);
    expect(t.unsandboxed).toContain("NOT sandboxed");
    expect(once.unsandboxed).toBe(true);
    expect(once.because.at(-1)).toBe(t.unsandboxed!);
    expect(P.withSandboxNote(once, t)).toBe(once);
  });
});

describe("No Claude in workers reaches a plain resume", () => {
  test("a worker stamped on Claude is not resumed on Claude once the switch is on", async () => {
    const root = join(dir, "orbit-noclaude");
    mkdirSync(root, { recursive: true });
    const broken = join(dir, "broken-tmux-noclaude");
    writeFileSync(broken, "#!/bin/sh\nexit 1\n");
    chmodSync(broken, 0o755);
    const saved = process.env.AGENTGLASS_TMUX_PATH;
    process.env.AGENTGLASS_TMUX_PATH = broken;
    const now = Date.now();
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by, resume_id, exit_code) VALUES (?, 'claude', ?, '%9997', '@9997', ?, ?, ?, ?, 'sess-nc', 0)",
      ["w-noclaude", root, now, now, root, JSON.stringify({
        scope: "global", rule: "base", because: [], position: 0, role: "builder", engine: "claude", model: "sonnet",
        envelope: { write: "worktree", network: false, commit: true, docker: false, deny: [] }, headless: true, turnMinutes: 10, turn: 1,
      })],
    );
    putSetting(root, "workers.noClaude", true);
    try {
      const r = await P.promptHeadless({ name: "w-noclaude", seatRoot: root, cwd: root } as never, "go on");
      // Measured: without the guard the turn gets past here to the engine check.
      expect(String(r.body.error ?? "")).toContain("No Claude in workers");
    } finally {
      putSetting(root, "workers.noClaude", false);
      if (saved === undefined) delete process.env.AGENTGLASS_TMUX_PATH; else process.env.AGENTGLASS_TMUX_PATH = saved;
      db.run("DELETE FROM named_agent WHERE name = ?", ["w-noclaude"]);
    }
  });
});

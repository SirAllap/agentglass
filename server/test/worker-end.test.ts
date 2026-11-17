/*
 * A WORKER ENDING REACHES THE SEAT THAT STARTED IT, ONCE.
 *
 * A seat starts headless workers and hears their reports, and nothing told it
 * when one finished: done workers sat there until the person noticed. The
 * ending is known for free — the wrapper leaves the turn's status and the
 * watcher that settles the row calls back with it — so what these tests guard
 * is the two ways that news can go wrong: lost, or said twice.
 *
 * Nothing here needs a tmux window: the ending is a file the wrapper writes,
 * and the seat is a function this suite stands in for.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-wend-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const AO = await import("../src/agentops.ts");
const { db } = await import("../src/db.ts");
const { arm, __dropTimers } = await import("../src/agents/ceilings.ts");
const { endedTurn, settled, asTui } = await import("../src/agents/policystart.ts");
const { putSetting } = await import("../src/preflightStore.ts");
const { announceWorkerEnd, announceWorkerWaiting, endLine, elapsed, endingOf, waitingLine } = await import("../src/agents/workerend.ts");
const { answerOf, prepareRun, runFiles } = await import("../src/agents/headless.ts");
const { tuiFromOf } = await import("../src/agents/tuiturn.ts");
const { openNeeds } = await import("../src/seatneed.ts");
const { addReport } = await import("../src/seatreport.ts");
const { promptSeat } = await import("../src/seatwake.ts");

const ROOT = "/home/a/code/orbit-wend";
const OTHER = "/home/a/code/elsewhere-wend";
const BY = {
  headless: true, turn: 1, turnMinutes: 30, role: "builder", engine: "opencode",
  model: "opencode/big-pickle", position: 0, because: [], scope: "global", rule: "base", envelope: {},
};

/** A row the way a policy start leaves it, without a window: what is under
 *  test is the ending, not the opening. */
function row(name: string, o: { seatRoot?: string | null; startedAt?: number; by?: unknown; exit?: number } = {}) {
  const startedAt = o.startedAt ?? Date.now() - 12 * 60_000;
  db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, adopted, seat_root, started_by, exit_code, exit_line)
    VALUES (?1, 'opencode', ?2, '%999', '@999', ?3, NULL, 0, ?4, ?5, ?6, ?7)
    ON CONFLICT(name) DO UPDATE SET started_at = ?3, ended_at = NULL, seat_root = ?4, started_by = ?5, exit_code = ?6, exit_line = ?7`)
    .run(name, dir, startedAt, o.seatRoot === undefined ? ROOT : o.seatRoot, o.by === undefined ? JSON.stringify(BY) : o.by ? JSON.stringify(o.by) : null, o.exit ?? null, o.exit === undefined ? null : "");
  db.query("DELETE FROM worker_end WHERE name = ?").run(name);
  return AO.agentNamed(name)!;
}

/** The wrapper's last act: the status, written aside and moved in whole. */
function leaveStatus(name: string, code: number, err = "") {
  const f = runFiles(name);
  if (err) writeFileSync(f.err, err);
  writeFileSync(join(f.dir, "part", "rc"), `${code}\n`);
  renameSync(join(f.dir, "part", "rc"), f.rc);
}

const until = async <T,>(f: () => T | undefined | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v as T; if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(20); }
};

/** What the seat was told, in the order it was told. */
const recorder = () => {
  const sent: { root: string; text: string }[] = [];
  const send = async (root: string, text: string) => { sent.push({ root, text }); };
  return { sent, send };
};

/** A failed turn's ending asks which engines are left. Answered here: the
 *  probe reads the CLIs installed on the machine, which no test may depend on. */
const noEngines = async () => [];

afterAll(() => { __dropTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("a worker that ends", () => {
  test("is announced to the seat that started it, with how it ended and how long it took", async () => {
    mkdirSync(join(dir, "x"), { recursive: true });
    const a = row("wend-done", { startedAt: Date.now() - 12 * 60_000 });
    const files = prepareRun("wend-done", "build the thing, report to /tmp/report.md", "none");
    // A builder that answered: the ordinary ending, not the no-result one.
    writeFileSync(files.out, `{"type":"result","result":"the retry keeps the last page"}\n`);
    const { sent, send } = recorder();
    /* The watcher's own callback, exactly as policystart arms it. */
    arm(a, { deadline: null, limitMinutes: 30, files, ended: (n) => endedTurn(n, { send }), wake: async () => true });
    leaveStatus("wend-done", 0);

    await until(() => sent.length);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.root).toBe(ROOT);
    expect(sent[0]!.text).toContain("wend-done");
    expect(sent[0]!.text).toContain("ended: done after 12m");
    expect(sent[0]!.text).toContain("agentglass-agent read wend-done");
    /* The brief named a report file. The notice does not repeat it: the brief
       is prose, and guessing which path in it is the report is the kind of
       guess that sends a seat to a file that is not there. */
    expect(sent[0]!.text).not.toContain("/tmp/report.md");
    /* A finished worker is not an error for the person. */
    expect(openNeeds(ROOT).filter((n) => n.text.includes("wend-done"))).toEqual([]);
  });

  test("is announced a second time by nobody: not the same look, not a later one", async () => {
    const a = row("wend-twice");
    prepareRun("wend-twice", "do the thing", "none");
    leaveStatus("wend-twice", 0);
    // The watcher settles the row and then calls back; the ending is read off
    // the row, so a suite that only writes the status has to do the first half.
    AO.settleTurn(a, { exitCode: 0, line: "" });
    const { sent, send } = recorder();
    await endedTurn("wend-twice", { send });
    expect(sent).toHaveLength(1);
    /* The ending settled again — the watcher racing a restart, a lazy look when
       somebody asks, the boot after a crash. The marker is a row, so a fresh
       call in this process and one in the next read the same answer. */
    await endedTurn("wend-twice", { send });
    expect(await announceWorkerEnd("wend-twice", { send })).toBe(false);
    expect(sent, "the same ending was announced twice").toHaveLength(1);
    // The marker is a ROW keyed by the name and the turn's start stamp, not a
    // Set: it is the next process, not this one, that must find it.
    expect(db.query("SELECT name, started_at FROM worker_end WHERE name = ?").get("wend-twice"))
      .toEqual({ name: "wend-twice", started_at: a.startedAt });
  });

  test("says done, failed or timed out by the status the wrapper left", async () => {
    expect(endingOf({ exitCode: 0 })).toBe("done");
    expect(endingOf({ exitCode: 2 })).toBe("failed");
    expect(endingOf({ exitCode: 124 })).toBe("timed out");
    expect(endingOf({}), "a worker still on its turn has not ended").toBeNull();

    const cases = [
      { name: "wend-ok", exit: 0, want: "ended: done after 3m" },
      { name: "wend-bad", exit: 2, want: "ended: failed (exit 2) after 3m" },
      { name: "wend-slow", exit: 124, want: "ended: timed out after 3m" },
    ] as const;
    for (const c of cases) {
      row(c.name, { startedAt: Date.now() - 3 * 60_000, exit: c.exit });
      const files = prepareRun(c.name, "the task", "none");
      // A clean ending owes a result, and this test is about the word for it.
      if (c.exit === 0) writeFileSync(files.out, `{"type":"result","result":"done"}\n`);
      const { sent, send } = recorder();
      expect(await announceWorkerEnd(c.name, { send })).toBe(true);
      expect(sent[0]!.text).toContain(c.want);
    }
  });

  test("a turn the kernel killed for memory says so, not the engine's ECONNRESET", async () => {
    row("wend-oom", { startedAt: Date.now() - 3 * 60_000, exit: 2 });
    const { sent, send } = recorder();
    expect(await announceWorkerEnd("wend-oom", { send, outOfMemory: () => "10G" })).toBe(true);
    expect(sent[0]!.text).toContain("ended: out of memory (worker ceiling 10G) after 3m");
    expect(sent[0]!.text).not.toContain("ECONNRESET");
  });

  test("a done turn is never asked what its scope did", async () => {
    row("wend-oom-done", { startedAt: Date.now() - 2 * 60_000, exit: 0 });
    prepareRun("wend-oom-done", "the task", "none");
    writeFileSync(runFiles("wend-oom-done").out, `{"type":"result","result":"done"}\n`);
    const { sent, send } = recorder();
    const asked = (): string | null => { throw new Error("a done turn has no memory ending to read"); };
    expect(await announceWorkerEnd("wend-oom-done", { send, outOfMemory: asked })).toBe(true);
    expect(sent[0]!.text).toContain("ended: done after 2m");
  });
});

describe("a worker that ends without a result", () => {
  test("a builder that left no message is announced as that, not as done", async () => {
    row("wend-empty", { startedAt: Date.now() - 4 * 60_000, exit: 0 });
    prepareRun("wend-empty", "build the thing", "none");
    const { sent, send } = recorder();
    expect(await announceWorkerEnd("wend-empty", { send })).toBe(true);
    expect(sent[0]!.text).toBe("worker wend-empty ended without a result after 4m. Read it with `agentglass-agent read wend-empty` and decide the next step.");
    expect(sent[0]!.text).not.toContain("ended: done");
    // Still not a need: a wasted turn is the seat's to decide about, not an
    // alarm for the person.
    expect(openNeeds(ROOT).filter((n) => n.text.includes("wend-empty"))).toEqual([]);
  });

  test("a report to the seat is a result, even with nothing in the last message", async () => {
    row("wend-reported", { startedAt: Date.now() - 5 * 60_000, exit: 0 });
    prepareRun("wend-reported", "build the thing", "none");
    addReport({ root: ROOT, agent: "wend-reported", text: "STATE: built it\nBLOCKED: nothing\nNEED: nothing\nCOST: 5m" });
    const { sent, send } = recorder();
    await announceWorkerEnd("wend-reported", { send });
    expect(sent[0]!.text).toContain("ended: done after 5m");
  });

  test("a scout owes no result, and a failed turn already reads as failed", async () => {
    const scout = { ...BY, role: "scout" };
    row("wend-scout", { startedAt: Date.now() - 2 * 60_000, exit: 0, by: scout });
    prepareRun("wend-scout", "find the retry", "none");
    const { sent, send } = recorder();
    await announceWorkerEnd("wend-scout", { send });
    expect(sent[0]!.text).toContain("ended: done after 2m");

    row("wend-broke", { startedAt: Date.now() - 2 * 60_000, exit: 2 });
    prepareRun("wend-broke", "build the thing", "none");
    const next = recorder();
    await announceWorkerEnd("wend-broke", { send: next.send });
    expect(next.sent[0]!.text).toContain("ended: failed (exit 2)");
  });

  test("its row carries it, which is what the card draws", () => {
    const quiet = row("wend-row-quiet", { startedAt: Date.now() - 60_000, exit: 0 });
    prepareRun("wend-row-quiet", "build the thing", "none");
    expect(settled(quiet).resultMissing).toBe(true);

    const answered = row("wend-row-said", { startedAt: Date.now() - 60_000, exit: 0 });
    const files = prepareRun("wend-row-said", "build the thing", "none");
    writeFileSync(files.out, `{"type":"result","result":"built it"}\n`);
    expect(settled(answered).resultMissing).toBeUndefined();

    // Claude always frames a result, even an empty one: that is still nothing.
    const framed = row("wend-row-framed", { startedAt: Date.now() - 60_000, exit: 0 });
    const frame = prepareRun("wend-row-framed", "build the thing", "none");
    writeFileSync(frame.out, `{"type":"init"}\n{"type":"result","result":""}\n`);
    expect(settled(framed).resultMissing).toBe(true);
  });
});

describe("the end of a turn and the credential it leaves", () => {
  test("a pass for a finished turn does not revoke the turn running under that name", async () => {
    const { mintWorkerToken, workerTokenOf } = await import("../src/auth.ts");
    // The resume path re-stamped the row for its next turn and minted ahead of
    // it; the old turn's watcher and a deadline both still keep the name.
    row("wend-resumed", {});
    const minted = mintWorkerToken("wend-resumed");
    const { send } = recorder();
    await endedTurn("wend-resumed", { send });
    expect(workerTokenOf("wend-resumed")).toBe(minted);
  });

  test("an ended turn takes its page ids with it, so the next one starts with none", async () => {
    const { noteWorkerPage, resetWorkerPages, workerOwnsPage } = await import("../src/browserdrive.ts");
    resetWorkerPages();
    const a = row("wend-pages", {});
    noteWorkerPage("wend-pages", "t9-own");
    AO.settleTurn(a, { exitCode: 0, line: "" });
    const { send } = recorder();
    await endedTurn("wend-pages", { send });
    expect(workerOwnsPage("wend-pages", "t9-own")).toBe(false);
  });
});

describe("who hears about it", () => {
  test("its own root, never a seat that did not start it", async () => {
    row("wend-other", { seatRoot: OTHER, exit: 0 });
    const { sent, send } = recorder();
    await announceWorkerEnd("wend-other", { send });
    expect(sent.map((s) => s.root)).toEqual([OTHER]);
  });

  test("nobody, for a worker with no seat, a person's own tab, or one stopped by hand", async () => {
    const { sent, send } = recorder();
    row("wend-noseat", { seatRoot: null, exit: 0 });
    expect(await announceWorkerEnd("wend-noseat", { send })).toBe(false);

    row("wend-own-tab", { startedAt: Date.now(), exit: 0, by: null });
    expect(await announceWorkerEnd("wend-own-tab", { send })).toBe(false);

    // A stop by hand ends the row with no status at all: that is the person's
    // own act, not a worker finishing.
    const stopped = row("wend-stopped", {});
    db.query("UPDATE named_agent SET ended_at = ? WHERE name = ?").run(Date.now(), stopped.name);
    expect(await announceWorkerEnd("wend-stopped", { send })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("auto-continue: a clean end starts the next flow role", () => {
  afterAll(() => { putSetting(ROOT, "flow.autoContinue", false); });

  test("off: nothing is chained", async () => {
    putSetting(ROOT, "flow.autoContinue", false);
    row("wend-chain-off", { startedAt: Date.now() - 60_000, exit: 0 });
    prepareRun("wend-chain-off", "build the thing", "none");
    writeFileSync(runFiles("wend-chain-off").out, `{"type":"result","result":"built it"}\n`);
    const calls: unknown[] = [];
    await endedTurn("wend-chain-off", { send: recorder().send, continueFlow: async (...a) => { calls.push(a); return { status: 200, body: { ok: true, result: {} } }; } });
    expect(calls).toEqual([]);
  });

  test("a trailing question stops the chain: the orchestrator answers it, not the next role", async () => {
    putSetting(ROOT, "flow.autoContinue", true);
    row("wend-chain-question", { startedAt: Date.now() - 60_000, exit: 0 });
    prepareRun("wend-chain-question", "build the thing", "none");
    writeFileSync(runFiles("wend-chain-question").out, `{"type":"result","result":"two ways to do this: A or B?"}\n`);
    const calls: unknown[] = [];
    await endedTurn("wend-chain-question", { send: recorder().send, continueFlow: async (...a) => { calls.push(a); return { status: 200, body: { ok: true, result: {} } }; } });
    expect(calls).toEqual([]);
  });

  test("on, no question: the next role on the path starts once, in the same tab", async () => {
    putSetting(ROOT, "flow.autoContinue", true);
    const a = row("wend-chain-on", { startedAt: Date.now() - 60_000, exit: 0 });
    prepareRun("wend-chain-on", "build the thing", "none");
    writeFileSync(runFiles("wend-chain-on").out, `{"type":"result","result":"built it"}\n`);
    const calls: { name: string; flowRole: string }[] = [];
    await endedTurn("wend-chain-on", {
      send: recorder().send,
      continueFlow: async (agent, _text, flowRole) => { calls.push({ name: agent.name, flowRole }); return { status: 200, body: { ok: true, result: {} } }; },
    });
    expect(calls).toEqual([{ name: a.name, flowRole: "inspector" }]);

    // Settled a second time (a watcher racing a restart): still one start.
    await endedTurn("wend-chain-on", {
      send: recorder().send,
      continueFlow: async (agent, _text, flowRole) => { calls.push({ name: agent.name, flowRole }); return { status: 200, body: { ok: true, result: {} } }; },
    });
    expect(calls).toHaveLength(1);
  });

  test("a failed turn never chains: a reviewer's round, never a handoff", async () => {
    putSetting(ROOT, "flow.autoContinue", true);
    row("wend-chain-failed", { startedAt: Date.now() - 60_000, exit: 2 });
    prepareRun("wend-chain-failed", "build the thing", "none");
    const calls: unknown[] = [];
    await endedTurn("wend-chain-failed", { send: recorder().send, probe: noEngines, continueFlow: async (...a) => { calls.push(a); return { status: 200, body: { ok: true, result: {} } }; } });
    expect(calls).toEqual([]);
  });
});

describe("the line itself", () => {
  test("a glance, not a duration in seconds", () => {    expect(elapsed(9_000)).toBe("9s");
    expect(elapsed(59_000)).toBe("59s");
    expect(elapsed(60_000)).toBe("1m");
    expect(elapsed(47 * 60_000)).toBe("47m");
    expect(elapsed(3_600_000)).toBe("1h");
    expect(elapsed(3_900_000)).toBe("1h 5m");
  });

  test("names the worker, how it ended and what to read", () => {
    const line = endLine("orbit-1042", "failed", 7, 90_000);
    expect(line).toBe("worker orbit-1042 ended: failed (exit 7) after 1m. Read it with `agentglass-agent read orbit-1042` and decide the next step.");
  });

  test("a turn that is over while the worker is not says waiting, and how to answer it", () => {
    expect(waitingLine("orbit-1042")).toBe(
      'worker orbit-1042 finished its turn, waiting. Answer it with `agentglass-agent prompt orbit-1042 "..."` or read it with `agentglass-agent read orbit-1042`.',
    );
  });
});

/*
 * THE PROJECT, NOT THE SPELLING OF ITS WORKTREE.
 *
 * A seat works in a linked worktree as often as it works in the project
 * (`~/code/orbit-1042` beside `~/code/orbit`), and the chair's name is a hash
 * of the root it was seated at. A notice resolved by the raw `seat_root` — the
 * spelling the worker was started with — found no chair and typed to nobody,
 * silently; measured as a seat that started Flow workers and never heard one
 * end.
 */
describe("a seat working in a worktree beside its project", () => {
  /** A repo with one linked worktree beside it, as the brief has every agent
   *  cut. Returns the two paths and how to take them away again. */
  function repoAndWorktree(): { repo: string; wt: string; done: () => void } {
    const repo = mkdtempSync(join(tmpdir(), "agx-wend-repo-"));
    const wt = join(repo, "..", `${basename(repo)}-work`);
    const run = (args: string[], cwd: string) => spawnSync("git", args, { cwd, stdio: "ignore" });
    run(["init", "-q"], repo);
    run(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "root"], repo);
    run(["worktree", "add", "-q", "-b", "side", wt], repo);
    return {
      repo: realpathSync(repo), wt: realpathSync(wt),
      done: () => {
        spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, stdio: "ignore" });
        rmSync(repo, { recursive: true, force: true });
      },
    };
  }

  test("the ending is announced to the project, whatever the row's spelling", async () => {
    const { repo, wt, done } = repoAndWorktree();
    try {
      row("wend-wt", { seatRoot: wt, exit: 0, startedAt: Date.now() - 2 * 60_000 });
      const files = prepareRun("wend-wt", "the task", "none");
      writeFileSync(files.out, `{"type":"result","result":"done"}\n`);
      const { sent, send } = recorder();
      expect(await announceWorkerEnd("wend-wt", { send })).toBe(true);
      expect(sent.map((s) => s.root), "the chair is keyed at the project, not at the worktree").toEqual([repo]);
    } finally { done(); }
  });

  test("and the waiting notice takes the same road", async () => {
    const { repo, wt, done } = repoAndWorktree();
    try {
      row("wend-wt-idle", { seatRoot: wt, startedAt: Date.now() - 60_000 });
      const { sent, send } = recorder();
      expect(await announceWorkerWaiting("wend-wt-idle", { send })).toBe(true);
      expect(sent.map((s) => s.root)).toEqual([repo]);
      expect(sent[0]!.text).toContain("finished its turn, waiting");
    } finally { done(); }
  });

  test("and the chair at the project is found from the worktree, and typed into", async () => {
    const { repo, wt, done } = repoAndWorktree();
    const SOCK = `agx-wend-${process.pid}`;
    const before = { tmux: process.env.TMUX_TMPDIR, socket: process.env.AGENTGLASS_TMUX_SOCKET };
    const sh = (a: string[]) => spawnSync("tmux", ["-f", "/dev/null", "-L", SOCK, ...a], { stdio: "pipe" });
    try {
      process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
      process.env.AGENTGLASS_TMUX_SOCKET = SOCK;
      const Seat = await import("../src/seat.ts");
      const name = Seat.seatName(repo);
      /* The chair, in a session started in the worktree: a person's own
         orchestrator, adopted, which is the case the notice missed. */
      const made = sh(["new-session", "-d", "-s", "bench", "-n", name, "-c", wt, "sleep", "300"]);
      expect(made.status, "tmux could not start the bench").toBe(0);
      const pane = sh(["display-message", "-p", "-t", "bench", "#{pane_id}"]).stdout.toString().trim();
      expect(pane).toMatch(/^%\d+$/);
      db.query(`INSERT INTO seat (root, name, kind, model, powers, started_at, ended_at, adopted_pane, adopted_approved)
        VALUES (?, ?, 'claude', '', 'speak', ?, NULL, ?, 1)
        ON CONFLICT(root) DO UPDATE SET adopted_pane = excluded.adopted_pane, adopted_approved = 1`)
        .run(repo, name, Date.now() - 60_000, pane);

      /* Both spellings are the same chair. */
      expect((await Seat.seated(repo))?.paneId).toBe(pane);
      expect((await Seat.seated(wt))?.paneId, "the worktree is the project, and the chair is found from either").toBe(pane);

      /* And a wake raised with the worktree spelling is typed into it. */
      const typed: { pane: string; text: string }[] = [];
      await promptSeat(wt, "worker wend-wt ended: done", {
        prompt: async (p, text) => { typed.push({ pane: p, text }); return "sent" as const; },
        screen: async () => null,
      });
      expect(typed).toEqual([{ pane, text: "worker wend-wt ended: done" }]);
    } finally {
      sh(["kill-server"]);
      if (before.tmux === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = before.tmux;
      if (before.socket === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
      else process.env.AGENTGLASS_TMUX_SOCKET = before.socket;
      done();
    }
  });
});

describe("the form the turn ran in", () => {
  test("an engine move drops the TUI stamp, so the next engine's frames are read as frames", () => {
    /* A Claude first turn leaves its answer as plain text, and the stamp says
       so (`agents/headless.ts` `answerOf`). When that turn fails and another
       engine takes over, the stamp must go with the form: a codex turn's
       `stream-json` read whole is JSON, not its answer, and the reviewer's
       BLOCKER scan would read JSON as prose. */
    const claude = { ...BY, engine: "claude", tui: true };
    const codexOut = '{"type":"item.completed","item":{"type":"agent_message","text":"the retry is in the export"}}\n';
    // What a stale stamp would do with that file.
    expect(answerOf(true, codexOut)).toBe(codexOut);
    const moved = asTui(claude as never, {});
    expect("tui" in moved).toBe(false);
    expect(answerOf((moved as { tui?: boolean }).tui, codexOut)).toBe("the retry is in the export");
    // The same stamp on a TUI turn keeps it, and so does the next TUI turn.
    expect(asTui({ ...BY } as never, { tui: true })).toMatchObject({ tui: true });
    expect(asTui(claude as never, { tui: true })).toMatchObject({ tui: true });
  });
});

/*
 * A TUI TURN ENDS WHILE ITS PROCESS DOES NOT.
 *
 * An interactive Claude turn is over when its transcript says so, and the CLI
 * stays in the pane, ready for the next one. The seat used to hear nothing
 * until the tab was closed: the turn's status settles the row, but the notice
 * that reached the seat was the one for a process leaving. It now hears that
 * the worker is waiting, and the CLI leaving later is not said twice.
 */
describe("a TUI turn that ends with its CLI still in the pane", () => {
  const said = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
  const answered = (text: string) => `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
  const marker = () => `${JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 900 })}\n`;

  test("tells the seat it is waiting, once, and the process leaving later says nothing more", async () => {
    const by = { ...BY, engine: "claude", tui: true };
    const a = row("wend-tui-idle", { by, startedAt: Date.now() - 3 * 60_000 });
    const files = prepareRun("wend-tui-idle", "build the thing", "none");
    const transcript = join(dir, "wend-tui-idle.jsonl");
    writeFileSync(transcript, "");
    const { sent, send } = recorder();
    /* Armed as policystart arms an interactive turn: the transcript's marker is
       the end, and the ending path is the seat's send. */
    arm(a, {
      deadline: null, limitMinutes: 30, files, tui: { transcript },
      ended: (n) => endedTurn(n, { send }),
      waiting: (n) => announceWorkerWaiting(n, { send }),
      wake: async () => true,
    });
    try {
      appendFileSync(transcript, said("find the retry") + answered("the retry is in the export") + marker());

      await until(() => sent.length);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toBe(waitingLine("wend-tui-idle"));
      expect(sent[0]!.text).toContain("finished its turn, waiting");
      expect(sent[0]!.text, "the worker is not over: the CLI is still in its pane").not.toContain("ended:");
      // The turn is settled all the same: a card, the Flow and a read see it.
      // Settling is the directory watch picking up the status file `leave()`
      // wrote, which is a real fs event and so lands on its own tick, after
      // the "waiting" send above has already gone out — wait for it rather
      // than assume it is already there (see the restart test below).
      await until(() => AO.agentNamed("wend-tui-idle")!.exitCode !== undefined);
      expect(AO.agentNamed("wend-tui-idle")!.exitCode).toBe(0);
      expect(readFileSync(files.out, "utf8")).toBe("the retry is in the export");

      /* The CLI leaves the pane later. Same turn, same marker row: nothing new
         for the seat, whatever path asks. */
      expect(await announceWorkerEnd("wend-tui-idle", { send })).toBe(false);
      expect(await announceWorkerWaiting("wend-tui-idle", { send })).toBe(false);
      expect(sent, "the same turn was announced twice").toHaveLength(1);
    } finally { __dropTimers(); }
  });

  test("a turn that ends while the server is restarting is still ended by the watch armed again after it", async () => {
    /* The watch is in the server's memory. Armed again after a restart from the
       transcript's size THEN, a marker the CLI wrote while the server was down
       sat before where it looked, and the worker stayed "on its turn" for good:
       every prompt to it was refused. The size at the turn's start is kept in
       its run folder, and the watch armed again reads from there. */
    const by = { ...BY, engine: "claude", tui: true };
    const a = row("wend-tui-restart", { by, startedAt: Date.now() - 3 * 60_000 });
    const files = prepareRun("wend-tui-restart", "build the thing", "none");
    const transcript = join(dir, "wend-tui-restart.jsonl");
    writeFileSync(transcript, said("an earlier turn") + answered("done before") + marker());
    const opts = { deadline: null, limitMinutes: 30, files, ended: (n: string) => endedTurn(n, { send: recorder().send }), waiting: async () => true, wake: async () => true };
    arm(a, { ...opts, tui: { transcript } });
    __dropTimers(); // the server goes away mid-turn
    appendFileSync(transcript, said("find the retry") + answered("the retry is in the export") + marker());
    expect(tuiFromOf(files), "the turn's start is kept beside its status").not.toBeNull();
    arm(a, { ...opts, tui: { transcript, from: tuiFromOf(files) ?? undefined } });
    try {
      await until(() => AO.agentNamed("wend-tui-restart")!.exitCode !== undefined);
      expect(AO.agentNamed("wend-tui-restart")!.exitCode).toBe(0);
      expect(readFileSync(files.out, "utf8")).toBe("the retry is in the export");
    } finally { __dropTimers(); }
  });

  test("the watch armed after a restart reads from the turn's start, not from the end of the file", async () => {
    const src = await Bun.file(new URL("../src/agents/policystart.ts", import.meta.url)).text();
    const at = src.indexOf("export async function workersAfterRestart(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain("from: tuiFromOf(files)");
  });

  test("two turns are two notices, and the exit after the second says nothing more", async () => {
    /* The claim is the name and the turn's start stamp, so a turn the seat has
       heard about keeps its one line while the next turn — a new stamp, as the
       resume path leaves it — has one of its own. Two turn ends and then the
       CLI leaving is one worker's whole life: two waiting notices, no ending
       over the top of the second. */
    const by = { ...BY, engine: "claude", tui: true };
    const transcript = join(dir, "wend-tui-two.jsonl");
    writeFileSync(transcript, "");
    const { sent, send } = recorder();
    /* Armed as policystart arms each turn: fresh run files, the transcript's
       size now as the mark, so the markers already there do not end this one. */
    const listen = () => arm(AO.agentNamed("wend-tui-two")!, {
      deadline: null, limitMinutes: 30, files: prepareRun("wend-tui-two", "build the thing", "none"),
      tui: { transcript },
      ended: (n) => endedTurn(n, { send }),
      waiting: (n) => announceWorkerWaiting(n, { send }),
      wake: async () => true,
    });
    row("wend-tui-two", { by, startedAt: Date.now() - 5 * 60_000 });
    try {
      listen();
      appendFileSync(transcript, said("first turn") + answered("first answer") + marker());
      await until(() => sent.length === 1);
      expect(sent[0]!.text).toBe(waitingLine("wend-tui-two"));

      /* The seat answered. The resume path opens the next turn as a new row
         stamp under the same name, and the old tab's process is gone. */
      db.query("UPDATE named_agent SET started_at = ?, ended_at = NULL, exit_code = NULL, exit_line = NULL WHERE name = ?")
        .run(Date.now() - 60_000, "wend-tui-two");
      listen();
      appendFileSync(transcript, said("second turn") + answered("second answer") + marker());

      await until(() => sent.length === 2);
      expect(sent.map((s) => s.text)).toEqual([waitingLine("wend-tui-two"), waitingLine("wend-tui-two")]);
      // Settling is the directory watch picking up the status file, a real fs
      // event that lands on its own tick after the send above (see the first
      // test in this file).
      await until(() => AO.agentNamed("wend-tui-two")!.exitCode !== undefined);
      expect(AO.agentNamed("wend-tui-two")!.exitCode, "the second turn is settled").toBe(0);

      /* The CLI leaves the pane after a turn the seat has already heard about:
         the same stamp, so neither door says anything more. */
      expect(await announceWorkerEnd("wend-tui-two", { send })).toBe(false);
      expect(await announceWorkerWaiting("wend-tui-two", { send })).toBe(false);
      expect(sent.filter((s) => s.text.includes("finished its turn, waiting")), "a turn was announced twice").toHaveLength(2);
      expect(sent.filter((s) => s.text.includes("ended:"))).toHaveLength(0);
    } finally { __dropTimers(); }
  }, 15_000);

  test("the exit is still one notice when no turn announced it first", async () => {
    const by = { ...BY, engine: "claude", tui: true };
    row("wend-tui-exit", { by, startedAt: Date.now() - 2 * 60_000, exit: 0 });
    const files = prepareRun("wend-tui-exit", "build the thing", "none");
    writeFileSync(files.out, "the retry is in the export");
    const { sent, send } = recorder();
    expect(await announceWorkerEnd("wend-tui-exit", { send })).toBe(true);
    expect(await announceWorkerEnd("wend-tui-exit", { send }), "the same exit was announced twice").toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("ended: done after 2m");
    expect(sent[0]!.text).not.toContain("finished its turn");
  });

  test("a CLI that dies before its marker is still announced as an ending", async () => {
    const by = { ...BY, engine: "claude", tui: true };
    const a = row("wend-tui-died", { by, startedAt: Date.now() - 2 * 60_000 });
    const files = prepareRun("wend-tui-died", "build the thing", "none");
    const transcript = join(dir, "wend-tui-died.jsonl");
    writeFileSync(transcript, "");
    const { sent, send } = recorder();
    arm(a, {
      deadline: null, limitMinutes: 30, files, tui: { transcript },
      ended: (n) => endedTurn(n, { send, probe: noEngines }),
      waiting: (n) => announceWorkerWaiting(n, { send }),
      wake: async () => true,
    });
    try {
      // The wrapper's own status: the CLI left without a turn marker.
      leaveStatus("wend-tui-died", 2, "the CLI exited (2)");

      await until(() => sent.length);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("ended: failed (exit 2)");
      expect(sent[0]!.text).not.toContain("finished its turn");
    } finally { __dropTimers(); }
  }, 2_000);
});


/*
 * A TURN ENDING LEAVES THE SCOPE ALONE.
 *
 * The scope a private OpenCode server runs in is the cgroup of everything its
 * turn spawned, a `bun run dev` a builder left for the person to look at
 * included. The wrapper stops the serve at the turn's end (headless.ts
 * `AGX_SERVE_PIDS`), and the whole scope belongs to the window, which is when
 * it goes. A unit stopped here would take the site down before the person
 * clicked.
 */
describe("a turn ending and its window", () => {
  test("the ending stops no scope, and the window still owns it", async () => {
    /* The behaviour is asserted at the seam the ending reaches: the unit is
       still in `ownScopes()`, and `endWindowScopes` — the window-end path —
       still answers with it. No `systemctl` is called. */
    const scopes = await import("../src/scopes.ts");
    const unit = `${scopes.SCOPE_PREFIX}1-ab12-20.scope`;
    scopes.rememberScope(unit); // as the launch leaves it, for the exit pass
    scopes.noteRunScope("wend-scope-end", unit);
    row("wend-scope-end", { exit: 0, startedAt: Date.now() - 60_000 });
    const { sent, send } = recorder();

    expect(await announceWorkerEnd("wend-scope-end", { send })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(scopes.ownScopes().has(unit), "a turn's end forgot the run's scope").toBe(true);

    const stopped: string[] = [];
    expect(scopes.endWindowScopes("wend-scope-end", (u) => { stopped.push(u); })).toEqual([unit]);
    expect(stopped).toEqual([unit]);
  });
});

/*
 * A NEW TURN UNDER A NAME IS NOT THE END OF ITS WINDOW.
 *
 * The run scope used to be bound to the name, and `startAgent` let the name go
 * on every successful start: the next turn stopped the previous window's scope,
 * taking a `bun run dev` the person was looking at with it. The opposite path
 * was missing too — a row reconciled away ended without stopping its scope. So
 * the two events are now separate, and these tests hold them apart.
 */
describe("the window a name meant", () => {
  test("a new turn releases the name and keeps the window; a row that ends closes it", () => {
    const ended: string[] = [];
    AO.onWindowEnd((name) => ended.push(name));
    AO.turnStarted("wend-window-kept");
    expect(ended, "a new turn ended the previous window").toEqual([]);
    AO.endKept("wend-window-kept");
    expect(ended).toEqual(["wend-window-kept"]);
  });

  test("a row reconciled away fires the window end", async () => {
    const name = "wend-window-reconciled";
    row(name);
    const ended: string[] = [];
    AO.onWindowEnd((n) => ended.push(n));
    /* An engine that is NOT RUNNING is the read that proves every window of it
       is gone; the stub answers exactly what tmux says, so nothing real is
       touched. */
    const stub = join(dir, "tmux-absent");
    writeFileSync(stub, "#!/bin/sh\necho 'no server running on /tmp/agx-no-engine' >&2\nexit 1\n");
    chmodSync(stub, 0o755);
    /* The stub is a private engine: the test guard (tmuxbin.ts engineRefused)
       refuses any tmux call outside a private TMUX_TMPDIR, and a refused read is
       "unknown", never "gone" — so without this the reconcile never sees the pane
       leave and no window end fires. */
    const before = process.env.AGENTGLASS_TMUX_PATH;
    const beforeTmp = process.env.TMUX_TMPDIR;
    process.env.AGENTGLASS_TMUX_PATH = stub;
    process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
    try {
      await AO.reconcile();
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_TMUX_PATH;
      else process.env.AGENTGLASS_TMUX_PATH = before;
      if (beforeTmp === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = beforeTmp;
    }
    expect(ended).toContain(name);
  });

  test("closing the kept tab for the next turn is not the end of the window", async () => {
    const a = row("wend-window-next");
    const ended: string[] = [];
    AO.onWindowEnd((n) => ended.push(n));
    // The tab is left alone (`kill: false`); the window is what is under test.
    await AO.stopAgent(a, Date.now(), false, { endsWindow: false });
    expect(ended, "a new turn's tab close ended the previous window").toEqual([]);
    // A stop that means it still closes the window, and its scope with it.
    await AO.stopAgent(a, Date.now(), false);
    expect(ended).toEqual(["wend-window-next"]);
    /* And the two paths that close a kept tab for the next turn say so. */
    const s = readFileSync(new URL("../src/agents/policystart.ts", import.meta.url), "utf8");
    expect(s.split("endsWindow: false").length - 1, "a kept tab closed as if its window were over").toBe(2);
  });

  test("a start that reuses a name whose pane is gone ends its window", async () => {
    const name = "wend-window-started-again";
    row(name);
    const ended: string[] = [];
    AO.onWindowEnd((n) => ended.push(n));
    /* A tmux server that restarted: the row is still open and the engine
       reports a pane that is not its own. */
    const stub = join(dir, "tmux-other-pane");
    writeFileSync(stub, "#!/bin/sh\ncase \"$*\" in *list-panes*) printf '%%1\\t0\\tbash\\tbash\\n'; exit 0;; esac\nexit 1\n");
    chmodSync(stub, 0o755);
    /* The stub is a private engine: the test guard (tmuxbin.ts engineRefused)
       refuses any tmux call outside a private TMUX_TMPDIR, and a refused read is
       "unknown", never "gone" — so without this the reconcile never sees the pane
       leave and no window end fires. */
    const before = process.env.AGENTGLASS_TMUX_PATH;
    const beforeTmp = process.env.TMUX_TMPDIR;
    process.env.AGENTGLASS_TMUX_PATH = stub;
    process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
    try {
      await AO.startAgent({ root: ROOT, cwd: dir, name, kind: "opencode", yoloAllowed: true });
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_TMUX_PATH;
      else process.env.AGENTGLASS_TMUX_PATH = before;
      if (beforeTmp === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = beforeTmp;
    }
    expect(ended, "the row ended and the window the name meant was left to the age sweep").toContain(name);
  });
});

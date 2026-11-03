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
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-wend-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const AO = await import("../src/agentops.ts");
const { db } = await import("../src/db.ts");
const { arm, __dropTimers } = await import("../src/agents/ceilings.ts");
const { endedTurn, settled } = await import("../src/agents/policystart.ts");
const { announceWorkerEnd, endLine, elapsed, endingOf } = await import("../src/agents/workerend.ts");
const { prepareRun, runFiles } = await import("../src/agents/headless.ts");
const { openNeeds } = await import("../src/seatneed.ts");
const { addReport } = await import("../src/seatreport.ts");

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

describe("the line itself", () => {
  test("a glance, not a duration in seconds", () => {
    expect(elapsed(9_000)).toBe("9s");
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
});

/*
 * A TURN THAT ENDS ON A QUESTION IS NOT A DEAD WORKER.
 *
 * A scout that has to choose, or a builder that needs a decision, asks it in
 * the last line of its result. The session it ran in is kept, the row says it
 * is waiting for an answer, and `agentglass-agent prompt <name> "answer"`
 * resumes the same session instead of starting another worker that knows
 * nothing about the question.
 *
 * Two halves: what "ends on a question" means (pure, no window), and the
 * resume end to end against a booted server and the fake engine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { nights, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-ask-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const AO = await import("../src/agentops.ts");
const { db } = await import("../src/db.ts");
const { awaitingAnswer, endsWithQuestion } = await import("../src/agents/workerend.ts");
const { prepareRun } = await import("../src/agents/headless.ts");

const BY = {
  headless: true, turn: 1, turnMinutes: 30, role: "builder", engine: "claude",
  model: "claude-sonnet-5-5", position: 0, because: [], scope: "global", rule: "base", envelope: {},
};

/** A finished turn's row and its result, the way the ending leaves them. */
function ended(name: string, o: { by?: unknown; exit?: number; out?: string } = {}) {
  db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, adopted, seat_root, started_by, exit_code, exit_line)
    VALUES (?1, 'claude', ?2, '%997', '@997', ?3, NULL, 0, NULL, ?4, ?5, '')
    ON CONFLICT(name) DO UPDATE SET started_at = ?3, ended_at = NULL, started_by = ?4, exit_code = ?5`)
    .run(name, dir, Date.now() - 60_000, o.by === undefined ? JSON.stringify(BY) : o.by ? JSON.stringify(o.by) : null, o.exit ?? 0);
  const files = prepareRun(name, "build it", "none");
  if (o.out !== undefined) writeFileSync(files.out, o.out);
  return AO.agentNamed(name)!;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("what ends on a question", () => {
  test("the last line, and only its shape", () => {
    expect(endsWithQuestion("I moved the retry.\n\nShould the retry go on the export or the import?")).toBe(true);
    expect(endsWithQuestion('The plan is ready. "Shall I cut the tree?"')).toBe(true);
    expect(endsWithQuestion("Done: the retry is in the export.\n\nNo questions.")).toBe(false);
    expect(endsWithQuestion("Done.")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
    expect(endsWithQuestion(null)).toBe(false);
    // A question mark in the middle of a report is not a question to answer.
    expect(endsWithQuestion("Why? Because the retry ran twice. Fixed.")).toBe(false);
  });

  test("a clean turn that asks is waiting for an answer; a failed one is not", () => {
    expect(awaitingAnswer(ended("ask-clean", { out: "Should it go on the export?" }))).toBe(true);
    expect(awaitingAnswer(ended("ask-done", { out: "It is on the export." }))).toBe(false);
    expect(awaitingAnswer(ended("ask-failed", { exit: 1, out: "Should it go on the export?" }))).toBe(false);
  });

  test("a tab the app did not start as a worker asks nothing of the orchestrator", () => {
    expect(awaitingAnswer(ended("ask-person", { by: null, out: "Shall I?" }))).toBe(false);
  });

  test("a TUI turn's answer is read whole, so a JSON-looking line does not hide its question", () => {
    // A scout's plan may carry a fenced object, and the TUI writes its answer as
    // plain text (agents/tuiturn.ts). Read as frames, that line left no question
    // and no plan — the loss this state exists to prevent.
    const out = 'Retry the export:\n```json\n{"retry": { "attempts": 3 }}\n```\nShould the retry go on the export or the import?';
    expect(awaitingAnswer(ended("ask-tui", { by: { ...BY, tui: true }, out }))).toBe(true);
  });
});

/* ── the resume, end to end ─────────────────────────────────────────────── */

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
let n = 0;
const nm = (p: string) => `${p}-${++n}`;

beforeAll(async () => { if (have) h = await startHarness("wask"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

describe.skipIf(!have)("answering a worker that asked", () => {
  test("the row says it waits for an answer, and a prompt resumes the same session", async () => {
    // The fake TUI answers with a question, and its transcript carries it.
    writeFileSync(join(h.logs, "tui-answer"), "Should the retry go on the export or the import?");
    await h.usePolicy({ rules: [nights([{ engine: "claude", model: "claude-sonnet-5-5" }])] });
    await h.ruleOn(true);

    const name = nm("w-ask");
    expect((await h.asSeat("/agents/named/start", { name, cwd: h.wt, role: "builder", prompt: "build the retry" })).ok).toBe(true);
    const done = await h.exited(name);
    expect(done.exitCode).toBe(0);
    // The row says which form the turn ran in: a TUI's `out` is its answer as
    // text, and everything that reads it (agents/headless.ts `answerOf`) goes by
    // this stamp, never by the engine's name.
    expect(done.startedBy?.tui).toBe(true);
    // The turn is over and the session is not: this is the state a person reads.
    expect(done.awaitingAnswer).toBe(true);
    const first = tuiArgv(h.logs).find((a) => a.includes("--session-id"));
    const session = first?.[first.indexOf("--session-id") + 1];
    expect(session).toMatch(/^[0-9a-f-]{36}$/);

    // The answer goes to the same session, not to a new worker.
    const next = await h.asSeat("/agents/named/prompt", { name, text: "the export" });
    expect(next.ok).toBe(true);
    expect(next.result?.resumed).toBe(session);
    const second = await h.until(async () => {
      const r = await h.row(name);
      return r?.startedBy?.turn === 2 && r.exitCode !== undefined ? r : undefined;
    });
    expect(second.startedBy).toMatchObject({ turn: 2, role: "builder", engine: "claude" });
    // The engine was told to continue that session, with the answer as its message.
    const resumed = tuiArgv(h.logs).find((a) => a.includes("--resume"));
    expect(resumed?.[resumed.indexOf("--resume") + 1]).toBe(session);
    expect(resumed?.at(-1)).toContain("the export");
  }, 60_000);
});

/** Every TUI argv the fake engine was started with, oldest first. */
function tuiArgv(logs: string): string[][] {
  return readdirSync(logs).filter((f) => f.startsWith("tui-") && f.endsWith(".argv")).sort()
    .map((f) => readFileSync(join(logs, f), "utf8").split("\0").filter(Boolean));
}

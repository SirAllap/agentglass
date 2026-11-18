/*
 * A HEADLESS WORKER'S NUMBERS, from the turn it left behind.
 *
 * The Crew card is fed by Claude Code's hooks, and a headless worker fires none
 * of them: its card read "0 tools, ~$0.00" and carried no model while the turn
 * was spending. The turn's own frames are in `worker-runs/<name>/out`, so the
 * mapping is here, pure, and pinned against a stream in the engine's recorded
 * shape (fixtures/fakeEngines.ts, OpenCode 1.18.32).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Crew from "../src/crewworker.ts";
import { crewFactsOfRun, crewFactsOfWorker } from "../src/crewworker.ts";

const j = (o: unknown) => JSON.stringify(o);
const SID = "ses_fixture01";

/** One short invented turn: a line said, a call that worked, one that failed,
 *  and two priced steps. */
const RUN = [
  j({ type: "step_start", timestamp: 1791655313013, sessionID: SID, part: { type: "step-start" } }),
  j({ type: "text", timestamp: 1791655313200, sessionID: SID, part: { type: "text", text: "Reading the queue." } }),
  j({ type: "tool_use", timestamp: 1791655313400, sessionID: SID, part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "rg -n crew web/src" } } } }),
  j({ type: "tool_use", timestamp: 1791655313600, sessionID: SID, part: { type: "tool", tool: "read", state: { status: "error", input: { filePath: "/work/orbit/missing.ts" } } } }),
  j({ type: "step_finish", timestamp: 1791655313800, sessionID: SID, part: { type: "step-finish", cost: 0.0123, tokens: { input: 900, output: 40 } } }),
  j({ type: "step_finish", timestamp: 1791655314100, sessionID: SID, part: { type: "step-finish", cost: 0.0077, tokens: { input: 120 } } }),
].join("\n");

describe("a headless worker's turn, as crew facts", () => {
  test("counts the tools, the failures and the steps' dollars", () => {
    const f = crewFactsOfRun(RUN, { model: "opencode-go/deepseek-v4.1-flash" });
    expect(f.tools).toBe(2);
    expect(f.errors).toBe(1);
    expect(f.cost).toBeCloseTo(0.02, 6);
    expect(f.lastSeen).toBe(1791655314100);
  });

  test("names the model the chip draws, without the provider", () => {
    expect(crewFactsOfRun(RUN, { model: "opencode-go/deepseek-v4.1-flash" }).model).toBe("deepseek-v4.1-flash");
    // A frame that carries the id is believed over the registry.
    const carried = [j({ type: "text", timestamp: 5, part: { type: "text", text: "hi", modelID: "acme/deepseek-v4.1-flash" } })].join("\n");
    expect(crewFactsOfRun(carried, { model: "opencode-go/other" }).model).toBe("deepseek-v4.1-flash");
  });

  test("says what it was doing last, in the words of the call", () => {
    expect(crewFactsOfRun(RUN).activity).toBe("read · /work/orbit/missing.ts");
    expect(crewFactsOfRun(RUN).lastTool).toEqual({ name: "read", what: "/work/orbit/missing.ts", at: 1791655313600 });
  });

  test("a turn is running until its status file says otherwise", () => {
    expect(crewFactsOfRun(RUN).ended).toBe(false);
    expect(crewFactsOfRun(RUN, { exitCode: 0 }).ended).toBe(true);
    expect(crewFactsOfRun(RUN, { exitCode: 1 }).ended).toBe(true);
  });

  /* The guards that keep a card honest: prose is not a call, and a sentence is
     not a tool. Both were written because a signed-out CLI answers in prose and
     the first version of anything that counts lines counts it. */
  test("prose and plain text are not tools", () => {
    expect(crewFactsOfRun("Not logged in · Please run /login").tools).toBe(0);
    const textOnly = [j({ type: "text", timestamp: 9, part: { type: "text", text: "hello" } })].join("\n");
    const f = crewFactsOfRun(textOnly);
    expect(f.tools).toBe(0);
    expect(f.errors).toBe(0);
    expect(f.activity).toBe("hello");
  });

  test("an engine error is an error, and its message is the line", () => {
    const failed = [j({ type: "error", timestamp: 3, error: { name: "UnknownError", data: { message: "Unexpected server error." } } })].join("\n");
    const f = crewFactsOfRun(failed);
    expect(f.errors).toBe(1);
    expect(f.tools).toBe(0);
    expect(f.activity).toBe("Unexpected server error.");
  });

  test("an empty stream answers nothing rather than zeros dressed as facts", () => {
    const f = crewFactsOfRun("");
    expect(f.model).toBeUndefined();
    expect(f.activity).toBeUndefined();
    expect(f.lastSeen).toBeUndefined();
    expect(f.tools).toBe(0);
  });
});

describe("the worker's own folder", () => {
  const wasState = process.env.AGENTGLASS_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "agx-crew-worker-"));
  afterAll(() => {
    if (wasState === undefined) delete process.env.AGENTGLASS_STATE_DIR;
    else process.env.AGENTGLASS_STATE_DIR = wasState;
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads out and rc, and null when there is no turn", () => {
    process.env.AGENTGLASS_STATE_DIR = dir;
    mkdirSync(join(dir, "worker-runs", "orbit-fix"), { recursive: true });
    expect(crewFactsOfWorker("orbit-fix")).toBeNull();
    writeFileSync(join(dir, "worker-runs", "orbit-fix", "out"), RUN);
    expect(crewFactsOfWorker("orbit-fix", { model: "opencode-go/deepseek-v4.1-flash" })?.tools).toBe(2);
    expect(crewFactsOfWorker("orbit-fix")?.ended).toBe(false);
    writeFileSync(join(dir, "worker-runs", "orbit-fix", "rc"), "0\n");
    expect(crewFactsOfWorker("orbit-fix")?.ended).toBe(true);
  });

  /* The board polls this every 5-20 s per worker, and turns run to 60 MB: a
     stream is read once, then only what was appended since. */
  test("reads each byte of a turn once, then only what was appended", () => {
    process.env.AGENTGLASS_STATE_DIR = dir;
    Crew.__resetRunCache();
    const run = join(dir, "worker-runs", "orbit-grow");
    mkdirSync(run, { recursive: true });
    const out = join(run, "out");
    const lines = RUN.split("\n");
    writeFileSync(out, lines.slice(0, 3).join("\n") + "\n");
    const first = Buffer.byteLength(lines.slice(0, 3).join("\n") + "\n");
    expect(crewFactsOfWorker("orbit-grow")?.tools).toBe(1);
    expect(Crew.runBytesRead).toBe(first);

    // Unchanged: nothing is read again, however often it is asked.
    for (let i = 0; i < 5; i++) expect(crewFactsOfWorker("orbit-grow")?.tools).toBe(1);
    expect(Crew.runBytesRead).toBe(first);

    // Grown by a frame cut in half: only the new bytes, and the half is not lost.
    const fourth = lines[3]!;
    appendFileSync(out, fourth.slice(0, 20));
    expect(crewFactsOfWorker("orbit-grow")?.tools).toBe(1);
    appendFileSync(out, fourth.slice(20) + "\n" + lines.slice(4).join("\n"));
    const f = crewFactsOfWorker("orbit-grow")!;
    expect(f).toEqual(crewFactsOfRun(RUN));
    expect(Crew.runBytesRead).toBe(Buffer.byteLength(RUN) + 20);

    // A shorter file is a new turn: read from the start.
    writeFileSync(out, lines[2] + "\n");
    expect(crewFactsOfWorker("orbit-grow")?.tools).toBe(1);
    expect(crewFactsOfWorker("orbit-grow")?.cost).toBe(0);
  });

  /* `out` is deleted and made again each turn, and the inode can come back:
     a new stream that is longer than the last one is still a new stream. */
  test("a new stream at the same path and inode, longer than the last, is read from the start", () => {
    process.env.AGENTGLASS_STATE_DIR = dir;
    Crew.__resetRunCache();
    const run = join(dir, "worker-runs", "orbit-reuse");
    mkdirSync(run, { recursive: true });
    const out = join(run, "out");
    const lines = RUN.split("\n");
    const old = lines.slice(0, 4).join("\n") + "\n";
    writeFileSync(out, old);
    expect(crewFactsOfWorker("orbit-reuse")?.tools).toBe(2);
    // Same inode (truncated in place), longer, no tools: only its own totals.
    const fresh = [lines[4], lines[5], ...Array(8).fill(lines[1])].join("\n") + "\n";
    expect(fresh.length).toBeGreaterThan(old.length);
    writeFileSync(out, fresh);
    const f = crewFactsOfWorker("orbit-reuse")!;
    expect(f.tools).toBe(0);
    expect(f).toEqual(crewFactsOfRun(fresh));
  });
});

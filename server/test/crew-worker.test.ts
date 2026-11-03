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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

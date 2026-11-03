/*
 * What the pane of a headless OpenCode worker shows.
 *
 * The turn's JSON is read as lines by `opencodeview.py`, and the raw stream is
 * still in the turn's `out` file. The events below are invented: the shapes are
 * the ones recorded for OpenCode 1.18.32 in fixtures/fakeEngines.ts, the words
 * are this test's own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRun, wrapped } from "../src/agents/headless.ts";

const tmp: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agx-wview-")); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const line = (o: unknown) => JSON.stringify(o);
const EVENTS = [
  line({ type: "step_start", timestamp: 1, sessionID: "ses_view0001", part: { type: "step-start" } }),
  line({ type: "text", timestamp: 2, sessionID: "ses_view0001", part: { type: "text",
    text: "I found the retry loop in queue.ts and moved the backoff into one helper." } }),
  line({ type: "tool_use", timestamp: 3, sessionID: "ses_view0001", part: { type: "tool", tool: "read",
    state: { status: "completed", input: { filePath: "src/queue.ts" },
      output: "export function retry(job: Job) {\n  return backoff(job);\n}\n" } } }),
  line({ type: "tool_use", timestamp: 4, sessionID: "ses_view0001", part: { type: "tool", tool: "bash",
    state: { status: "error", input: { command: "bun test queue.test.ts" },
      error: "bun test queue.test.ts exited 1" } } }),
  line({ type: "error", timestamp: 5, sessionID: "ses_view0001",
    error: { name: "ProviderAuthError", data: { message: "Not signed in to the provider" } } }),
  "note: using the free model",
  line({ type: "text", timestamp: 6, sessionID: "ses_view0001", part: { type: "text",
    text: "The loop is fixed; the test that reproduces it is in place." } }),
  line({ type: "step_finish", timestamp: 7, sessionID: "ses_view0001", part: { type: "step-finish",
    tokens: { input: 1800, output: 220, cache: { read: 900 } }, cost: 0.0042 } }),
].join("\n") + "\n";

const have = !!Bun.which("python3") || !!Bun.which("python");

/** Prepare a turn without leaving this process on another test's state dir. */
function prepared(name: string) {
  const previous = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = scratch();
  try { return prepareRun(name, "fix the retry loop", "none"); } finally { process.env.AGENTGLASS_STATE_DIR = previous; }
}

async function run(argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

describe.skipIf(!have)("a headless OpenCode turn, read as lines", () => {
  test("text, tool, result, error, final message and the end are on screen, and the raw events are in the file", async () => {
    const f = prepared("w-view-ok");
    const events = join(f.dir, "events.jsonl");
    writeFileSync(events, EVENTS);
    const out = await run(wrapped(f, ["cat", events], "opencode"));

    expect(out).toContain("headless opencode worker");
    expect(out).toContain("this tab cannot be typed to");
    expect(out).toContain("I found the retry loop in queue.ts");
    // One line per call: the tool, then one argument, never the JSON.
    const call = out.split("\n").find((l) => l.startsWith("→ read"));
    expect(call).toBe("→ read  src/queue.ts");
    expect(out).toContain("✓ export function retry(job: Job) {");
    expect(out).toContain("(+2 lines)");
    expect(out).toContain("→ bash  bun test queue.test.ts");
    expect(out).toContain("✗ bun test queue.test.ts exited 1");
    expect(out).toContain("! error  Not signed in to the provider");
    // A line the engine did not write as JSON is the sentence that matters.
    expect(out).toContain("note: using the free model");
    expect(out).toContain("The loop is fixed; the test that reproduces it is in place.");
    expect(out).toContain("── done · exit 0 ·");
    expect(out).toContain("2 tools");
    expect(out).toContain("2.9k tokens");
    expect(out).toContain("$0.0042");
    expect(out).toContain(`raw events: ${f.out}`);
    expect(out).not.toContain('"type":"text"');
    // The file kept before the reader ran.
    const raw = readFileSync(f.out, "utf8");
    expect(raw).toContain('"type":"tool_use"');
    expect(raw.trim().split("\n")).toHaveLength(EVENTS.trim().split("\n").length);
  });

  test("a turn that exits non-zero says failed, and why it ended is its own status", async () => {
    const f = prepared("w-view-failed");
    const events = join(f.dir, "events.jsonl");
    writeFileSync(events, EVENTS);
    const out = await run(wrapped(f, ["sh", "-c", `cat '${events}'; exit 3`], "opencode"));
    expect(out).toContain("── failed · exit 3 ·");
    expect(out).not.toContain("── done");
  });

  test("a reader that crashes does not cut the worker or the raw file short", async () => {
    const f = prepared("w-view-crash");
    // Reads one line and dies, the way a formatting bug would on an event it did not expect.
    writeFileSync(f.view, "import sys\nsys.stdin.readline()\nraise SystemExit(3)\n");
    await run(wrapped(f, ["seq", "1", "200000"], "opencode"));
    // Without a fallback the pipe has no reader, tee takes SIGPIPE and the file stops near 14k lines.
    expect(readFileSync(f.out, "utf8").trim().split("\n")).toHaveLength(200000);
    expect(readFileSync(f.rc, "utf8").trim()).toBe("0");
  });

  test("the reader is put on the pane for OpenCode only, and not at all without python", () => {
    const f = prepared("w-view-which");
    const python = Bun.which("python3") || Bun.which("python");
    const opencode = wrapped(f, ["opencode", "run"], "opencode");
    expect(opencode[1]).toBe("-c");
    if (python) {
      expect(opencode).toContain(python);
      expect(opencode).toContain(f.view);
    }
    const claude = wrapped(f, ["claude", "-p"], "claude");
    expect(claude).not.toContain(f.view);
    expect(claude.slice(-2)).toEqual(["claude", "-p"]);
  });
});

// The Codex backend's two pure pieces: the argv a turn is spawned with, and the
// model list the dropdown is offered.
//
// Both are worth pinning without a real `codex`. The argv decides how much a
// browser request may do to the filesystem, and the model list is read off a
// cache this repo does not control — a shape change there must degrade to the
// fallback rather than putting a malformed id into the spawn.
//
// The third is the rollout reader, which is what gives a resumed Codex chat its
// history: the telemetry the fleet knows a Codex session by carries the shape of
// a turn but none of its words (its `UserPromptSubmit` payload is literally
// `{"prompt":""}`), so this file on disk is the only source for them.
import { describe, expect, test } from "bun:test";
import { codexArgs, parseModels, parseRollout, noteCodexCwd, codexCwd, DEFAULT_SANDBOX } from "../src/codex.ts";

const BIN = "/usr/bin/codex";

describe("codexArgs", () => {
  test("a first turn opens a thread and reads the prompt from stdin", () => {
    expect(codexArgs(BIN, "gpt-5.6-sol", "read-only", "")).toEqual([
      BIN, "exec", "--json", "-m", "gpt-5.6-sol",
      "-c", "sandbox_mode=read-only",
      "-c", "approval_policy=never",
      "-",
    ]);
  });

  test("a follow-up resumes the thread it was given", () => {
    const args = codexArgs(BIN, "gpt-5.6-sol", "workspace-write", "019fb8f6-aabc-72e3-80fe-66edcdf559f5");
    expect(args.slice(0, 4)).toEqual([BIN, "exec", "resume", "019fb8f6-aabc-72e3-80fe-66edcdf559f5"]);
    expect(args).toContain("--json");
    expect(args).toContain("sandbox_mode=workspace-write");
    // `codex exec resume` rejects `-s` outright, which is why the sandbox rides
    // in as a config override on both paths rather than as the documented flag.
    expect(args).not.toContain("-s");
    expect(args[args.length - 1]).toBe("-");
  });

  test("full-access drops the sandbox instead of narrowing it", () => {
    const args = codexArgs(BIN, "gpt-5.6-sol", "full-access", "");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // No sandbox_mode alongside it: the two would be contradictory, and the
    // bypass flag already implies the approval policy.
    expect(args.some((a) => a.startsWith("sandbox_mode="))).toBe(false);
    expect(args.some((a) => a.startsWith("approval_policy="))).toBe(false);
  });

  test("the prompt is never an argv element", () => {
    // It goes in on stdin. A prompt in argv would hit ARG_MAX on a long paste
    // and would put what the user typed into the process table.
    const args = codexArgs(BIN, "gpt-5.6-sol", "read-only", "");
    expect(args.filter((a) => a === "-")).toHaveLength(1);
    expect(args).not.toContain("hello");
  });

  test("the default sandbox is the one that cannot write", () => {
    expect(DEFAULT_SANDBOX).toBe("read-only");
  });
});

/** One entry shaped like the real cache, trimmed to the fields that matter. */
const model = (o: Record<string, unknown>) => ({
  slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1,
  description: "…", base_instructions: "…several kilobytes…", ...o,
});

describe("parseModels", () => {
  test("keeps listed models, in priority order, as id and label only", () => {
    const raw = JSON.stringify({
      models: [
        model({ slug: "gpt-5.5", display_name: "GPT-5.5", priority: 3 }),
        model({ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", priority: 1 }),
        model({ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", priority: 2 }),
      ],
    });
    expect(parseModels(raw)).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
  });

  test("drops entries Codex does not itself offer to a human", () => {
    // The cache carries internal entries — a review model, service tiers — that
    // are not conversation models at all.
    const raw = JSON.stringify({
      models: [model({ slug: "codex-auto-review", visibility: "hidden" }), model({})],
    });
    expect(parseModels(raw).map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  test("drops an id the send path would then refuse", () => {
    // Offering a choice that fails validation on the way out is the one outcome
    // worth ruling out here — it would read as the chat being broken.
    const raw = JSON.stringify({
      models: [model({ slug: "gpt-5.6 --dangerously-bypass-approvals-and-sandbox" }), model({ slug: "GPT-Upper" }), model({})],
    });
    expect(parseModels(raw).map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  test("falls back to the slug when there is no display name", () => {
    expect(parseModels(JSON.stringify({ models: [model({ display_name: null })] })))
      .toEqual([{ id: "gpt-5.6-sol", label: "gpt-5.6-sol" }]);
  });

  test("a cache that is missing, malformed or reshaped yields nothing", () => {
    // Nothing here throws — codexModels() reads the emptiness as "use the
    // fallback list", which is what keeps a Codex release from emptying the
    // dropdown on a machine where the CLI works fine.
    expect(parseModels("")).toEqual([]);
    expect(parseModels("not json")).toEqual([]);
    expect(parseModels("{}")).toEqual([]);
    expect(parseModels(JSON.stringify({ models: "gpt-5.6-sol" }))).toEqual([]);
    expect(parseModels(JSON.stringify({ models: [null, 42, "x"] }))).toEqual([]);
  });
});

// --- the rollout reader ------------------------------------------------------
// Records shaped exactly as `~/.codex/sessions/**/rollout-*.jsonl` writes them,
// down to `output` being an inline array rather than a string holding one —
// which is the detail that matters, since reading only the string form left
// every replayed tool row showing no output while looking perfectly healthy.
const line = (o: unknown) => JSON.stringify(o);
const msg = (kind: string, message: string, timestamp: string) =>
  line({ type: "event_msg", timestamp, payload: { type: kind, message } });
const call = (call_id: string, name: string, input: string, timestamp: string) =>
  line({ type: "response_item", timestamp, payload: { type: "custom_tool_call", call_id, name, input, status: "completed" } });
const result = (call_id: string, text: string, timestamp: string) =>
  line({ type: "response_item", timestamp, payload: { type: "custom_tool_call_output", call_id, output: [{ type: "text", text }] } });

describe("parseRollout", () => {
  const ROLLOUT = [
    line({ type: "session_meta", timestamp: "2026-07-31T12:31:13.000Z", payload: { id: "019fb903", cwd: "/tmp/repo" } }),
    msg("user_message", "how many lines is the readme?", "2026-07-31T12:31:14.000Z"),
    msg("agent_message", "I’ll check.", "2026-07-31T12:31:15.000Z"),
    call("c1", "exec", '{"cmd":"wc -l README.md","yield_time_ms":10000}', "2026-07-31T12:31:16.000Z"),
    result("c1", "4 README.md\n", "2026-07-31T12:31:17.000Z"),
    msg("agent_message", "Four.", "2026-07-31T12:31:18.000Z"),
  ].join("\n");

  test("gives back the conversation the telemetry could not", () => {
    expect(parseRollout(ROLLOUT).filter((e) => e.kind === "message").map((e) => [e.role, e.text]))
      .toEqual([["user", "how many lines is the readme?"], ["assistant", "I’ll check."], ["assistant", "Four."]]);
  });

  test("a tool call carries the command it ran and what came back", () => {
    const [tool] = parseRollout(ROLLOUT).filter((e) => e.kind === "tool");
    // The command is a JSON field inside a snippet Codex wrote for its own
    // sandbox, so pulling it out is a read of generated code — worth pinning
    // precisely, because the fallback (showing the snippet) is much worse.
    expect(tool.target).toBe("wc -l README.md");
    // `output` arrives as an array of content blocks, not as a string.
    expect(tool.output).toBe("4 README.md");
  });

  test("entries come back in the order they happened", () => {
    // A resumed thread appends to the same file, so this is sorted rather than
    // assumed — the panel renders the array in order.
    const ts = parseRollout(ROLLOUT).map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts.every((t) => t > 0)).toBe(true);
  });

  test("an output with no call to attach to is dropped, not guessed at", () => {
    const orphan = [msg("user_message", "hi", "2026-07-31T12:31:14.000Z"), result("nope", "stray", "2026-07-31T12:31:15.000Z")].join("\n");
    expect(parseRollout(orphan).filter((e) => e.kind === "tool")).toHaveLength(0);
  });

  test("a truncated or corrupt file yields what it can, and never throws", () => {
    // These files are appended to by a live process, so reading one mid-write is
    // ordinary rather than exceptional. Losing the last line costs a row; a
    // throw here would cost the whole replay.
    const torn = ROLLOUT + '\n{"type":"event_msg","payload":{"type":"agent_m';
    expect(parseRollout(torn).filter((e) => e.kind === "message")).toHaveLength(3);
    expect(parseRollout("")).toEqual([]);
    expect(parseRollout("not json\n\n{}\n[]")).toEqual([]);
  });

  test("a message with no words is not replayed as an empty bubble", () => {
    expect(parseRollout(msg("agent_message", "", "2026-07-31T12:31:15.000Z"))).toEqual([]);
  });
});

// --- the rollout reader ------------------------------------------------------
// Lines below are trimmed from a real `~/.codex/sessions/**/rollout-*.jsonl`
// (CLI 0.146). Only the fields this parser reads are kept; the shapes are
// verbatim, including the two that were got wrong the first time — the result is
// an array of content blocks rather than a string holding one, and a call whose
// script failed still reports `status: "completed"`.
const roll = (o: Record<string, unknown>) => JSON.stringify(o);
const ROLLOUT = [
  roll({ timestamp: "2026-07-31T16:31:12.043Z", type: "session_meta", payload: { id: "019fb903", cwd: "/tmp/repo" } }),
  roll({ timestamp: "2026-07-31T16:31:12.044Z", type: "event_msg", payload: { type: "task_started" } }),
  roll({ timestamp: "2026-07-31T16:31:14.110Z", type: "event_msg", payload: { type: "user_message", message: "count the lines" } }),
  roll({ timestamp: "2026-07-31T16:31:15.671Z", type: "event_msg", payload: { type: "agent_message", message: "I’ll check." } }),
  roll({ timestamp: "2026-07-31T16:31:16.560Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call_a", name: "exec", status: "completed", input: 'const r = await tools.exec_command({"cmd":"wc -l README.md","workdir":"/tmp/repo"});' } }),
  roll({ timestamp: "2026-07-31T16:31:16.640Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_a", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: "4 README.md\n" }] } }),
  roll({ timestamp: "2026-07-31T16:31:16.641Z", type: "event_msg", payload: { type: "token_count", info: {} } }),
  roll({ timestamp: "2026-07-31T16:31:18.221Z", type: "event_msg", payload: { type: "agent_message", message: "Four." } }),
].join("\n");

describe("parseRollout", () => {
  test("replays the conversation and the tool runs between it", () => {
    expect(parseRollout(ROLLOUT).map((e) => [e.kind, e.role ?? e.tool, e.text ?? e.target])).toEqual([
      ["message", "user", "count the lines"],
      ["message", "assistant", "I’ll check."],
      // The command, pulled out of the JavaScript Codex wrote around it.
      ["tool", "exec", "wc -l README.md"],
      ["message", "assistant", "Four."],
    ]);
  });

  test("a result reaches the call that asked for it", () => {
    // The blocks arrive as a real array. Reading only the string form is what
    // made every replayed tool row show no output while looking healthy.
    const tool = parseRollout(ROLLOUT).find((e) => e.kind === "tool")!;
    expect(tool.output).toBe("Script completed\nOutput:\n4 README.md");
    expect(tool.is_error).toBe(false);
  });

  test("an edit names the file, not the patch boilerplate", () => {
    const line = roll({ timestamp: "2026-07-31T16:31:51.119Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c", name: "exec", input: 'const patch = "*** Begin Patch\\n*** Update File: /tmp/repo/README.md\\n@@\\n+x\\n*** End Patch";' } });
    expect(parseRollout(line)[0].target).toBe("/tmp/repo/README.md");
  });

  test("a script that failed is not replayed as having worked", () => {
    // `status` says "completed" — that is true of the call, not of the work.
    const lines = [
      roll({ timestamp: "2026-07-31T16:31:51.119Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c", name: "exec", status: "completed", input: "{}" } }),
      roll({ timestamp: "2026-07-31T16:31:51.161Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output: [{ text: "Script failed\nOutput:\npatch rejected: writing is blocked" }] } }),
    ].join("\n");
    expect(parseRollout(lines)[0].is_error).toBe(true);
  });

  test("output that merely mentions failure is not a failure", () => {
    // Anchored on purpose: a `grep` walking past those words has not failed.
    const lines = [
      roll({ timestamp: "2026-07-31T16:31:51.119Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "c", name: "exec", input: "{}" } }),
      roll({ timestamp: "2026-07-31T16:31:51.161Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output: [{ text: "Script completed\nOutput:\ntest.ts: Script failed to load" }] } }),
    ].join("\n");
    expect(parseRollout(lines)[0].is_error).toBe(false);
  });

  test("a truncated, empty or corrupt rollout costs the history, not the app", () => {
    // A rollout is being appended to while this reads it, so a half-written last
    // line is normal rather than exceptional.
    expect(parseRollout("")).toEqual([]);
    expect(parseRollout("{not json\n{\"type\":\"event_msg\"")).toEqual([]);
    expect(parseRollout(ROLLOUT + '\n{"timestamp":"2026-07-31T16:31:19Z","type":"event_msg","payl')).toHaveLength(4);
  });

  test("an orphaned result is dropped rather than inventing a call", () => {
    expect(parseRollout(roll({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "nobody", output: [{ text: "x" }] } }))).toEqual([]);
  });
});

// --- where a codex thread ran ------------------------------------------------
// Codex's OTel records carry no working directory — the payload keys are
// `message`, `event`, `prompt`, `tool_name`, `tool_use_id` and `usage`, and
// nothing else. So every Codex session landed with a NULL project_path and a
// project-scoped cockpit (the default) hid all of them: 1225 Codex events in
// the database and OpenAI absent from the provider list.
describe("remembering where a thread was launched", () => {
  test("a thread is located once its id is known", () => {
    const id = "019fb8db-e77f-7021-bde5-94acd40dd97f";
    expect(codexCwd(id)).toBeNull();
    noteCodexCwd(id, "/repo/checkout");
    expect(codexCwd(id)?.cwd).toBe("/repo/checkout");
  });

  test("an id that is not one is refused", () => {
    // This is keyed on something arriving over OTLP from outside.
    noteCodexCwd("../../etc", "/repo");
    expect(codexCwd("../../etc")).toBeNull();
  });

  test("the first answer stands", () => {
    // A thread does not move, and a later turn resuming it from a different
    // checkout must not relabel everything already recorded against it.
    const id = "019fb8e9-97de-7f60-908c-3c9950e9e443";
    noteCodexCwd(id, "/repo/first");
    noteCodexCwd(id, "/repo/second");
    expect(codexCwd(id)?.cwd).toBe("/repo/first");
  });

  test("it does not grow without bound", () => {
    // One row per thread this server has ever driven, on a process that runs
    // for weeks, is a leak rather than a cache.
    for (let i = 0; i < 700; i++) {
      noteCodexCwd(`019fb8db-e77f-7021-bde5-${String(i).padStart(12, "0")}`, `/repo/${i}`);
    }
    expect(codexCwd("019fb8db-e77f-7021-bde5-000000000000")).toBeNull();
    expect(codexCwd("019fb8db-e77f-7021-bde5-000000000699")?.cwd).toBe("/repo/699");
  });
});

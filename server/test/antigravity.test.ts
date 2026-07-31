import { test, expect, describe } from "bun:test";
import { antigravityArgs, parseModels, antigravityModels, frameToEvent, newFrameContext, ANTIGRAVITY_APP } from "../src/antigravity.ts";

/** How many subprocesses have been started. Counted rather than mocked, so the
 *  assertion is about what actually happens on the machine. */
const spawnCount = () => SPAWNS.n;
const SPAWNS = { n: 0 };
const realSpawn = Bun.spawn;
(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  SPAWNS.n++;
  return realSpawn(...args);
}) as typeof Bun.spawn;

// The two halves of driving a third CLI: the command line that starts a turn,
// and the mapping that turns what it streams back into events. Both are pure,
// and both are the kind of thing that breaks silently — a mode flag that stops
// being passed still runs, it just runs with more authority than the label
// claims.

const BIN = "/usr/bin/agy";
const UUID = "78126291-f204-4b7a-b218-9a7e7ba9ac9a";

describe("the command line", () => {
  test("a first turn names the model and asks for the streaming format", () => {
    const a = antigravityArgs(BIN, "gemini-3.1-pro-high", "request-review", "", "hello");
    expect(a).toEqual([BIN, "-p", "hello", "--output-format", "stream-json", "--model", "gemini-3.1-pro-high"]);
  });

  test("the default mode is spelled by passing no flag", () => {
    // `--mode` only accepts accept-edits and plan; passing it "request-review"
    // is rejected outright, so the default has to be the absence of the flag.
    const a = antigravityArgs(BIN, "m", "request-review", "", "hi");
    expect(a).not.toContain("--mode");
    expect(a).not.toContain("--dangerously-skip-permissions");
  });

  test("plan and accept-edits ride --mode", () => {
    expect(antigravityArgs(BIN, "m", "plan", "", "hi")).toContain("--mode");
    expect(antigravityArgs(BIN, "m", "plan", "", "hi")).toContain("plan");
    expect(antigravityArgs(BIN, "m", "accept-edits", "", "hi")).toContain("accept-edits");
  });

  test("the unattended mode is its own flag, not a --mode value", () => {
    const a = antigravityArgs(BIN, "m", "always-proceed", "", "hi");
    expect(a).toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--mode");
  });

  test("a follow-up resumes the conversation it belongs to", () => {
    const a = antigravityArgs(BIN, "m", "request-review", UUID, "again");
    expect(a).toContain("--conversation");
    expect(a[a.indexOf("--conversation") + 1]).toBe(UUID);
  });

  test("the prompt is one argv element, however odd it looks", () => {
    // It goes in argv rather than on stdin, so a prompt full of quotes,
    // newlines and leading dashes must survive as a single value rather than
    // being read as more flags.
    const nasty = "--model evil\n'; rm -rf /\n\"quoted\"";
    const a = antigravityArgs(BIN, "m", "request-review", "", nasty);
    expect(a[1]).toBe("-p");
    expect(a[2]).toBe(nasty);
    expect(a.filter((x) => x === "--model")).toHaveLength(1);
  });
});

describe("the model list does not stall the server", () => {
  // Regression. This used Bun.spawnSync, which blocks Bun's single event loop
  // for as long as `agy models` takes — measured at 1.3–2.2s on a cold run.
  // Nothing else was served in that window, so /health could not answer inside
  // probeServer's 2.5s budget, the dashboard decided it was talking to a
  // stranger, and every panel went empty behind a "Wrong server" banner. With
  // `bun --watch` the cost is re-paid on every save.
  test("is asked for asynchronously, never synchronously", async () => {
    const out = antigravityModels();
    expect(out, "antigravityModels must return a promise, not a resolved array").toBeInstanceOf(Promise);
    expect(Array.isArray(await out)).toBe(true);
  });

  test("concurrent callers share one lookup", async () => {
    // The panel mounts, React StrictMode mounts it twice, and a reconnect asks
    // again — three spawns of the same subprocess, serialised, for one answer.
    const spawns = spawnCount();
    await Promise.all([antigravityModels(), antigravityModels(), antigravityModels()]);
    expect(spawnCount() - spawns).toBeLessThanOrEqual(1);
  });

  test("a CLI that cannot answer is not re-asked on every request", async () => {
    // Memoising only on success meant a broken or unauthenticated `agy` paid
    // the full subprocess cost per request, forever.
    await antigravityModels();
    const spawns = spawnCount();
    await antigravityModels();
    expect(spawnCount()).toBe(spawns);
  });
});

describe("the model list", () => {
  test("reads the bare list `agy models` prints", () => {
    expect(parseModels("gemini-3.6-flash-low\nclaude-sonnet-4-6\ngpt-oss-120b-medium\n"))
      .toEqual([
        { id: "gemini-3.6-flash-low", label: "gemini-3.6-flash-low" },
        { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
        { id: "gpt-oss-120b-medium", label: "gpt-oss-120b-medium" },
      ]);
  });

  test("drops anything the send path would then refuse", () => {
    // The same MODEL_RE guards the spawn, so offering a choice that cannot be
    // sent is the one outcome worth ruling out here.
    const out = parseModels("gemini-3.1-pro-high\nAvailable models:\n  \nnot a model!\n");
    expect(out.map((m) => m.id)).toEqual(["gemini-3.1-pro-high"]);
  });

  test("does not repeat itself", () => {
    expect(parseModels("a-model\na-model\n").length).toBe(1);
  });
});

describe("frames as events", () => {
  const init = {
    event: "init",
    conversation_id: UUID,
    init: { model: "gemini-3.6-flash-low", cwd: "/repo", permission_mode: "request-review" },
  };

  test("init opens the session and fixes the model", () => {
    const ctx = newFrameContext();
    const e = frameToEvent(init, ctx)!;
    expect(e.hook_event_type).toBe("SessionStart");
    expect(e.session_id).toBe(UUID);
    expect(e.model_name).toBe("gemini-3.6-flash-low");
    // `source_app` is what tells the rest of the app which CLI this was. It has
    // to be the agent's own name rather than the model's: `agy` runs Claude
    // models too, so a model-derived answer would file those under Claude.
    expect(e.source_app).toBe(ANTIGRAVITY_APP);
  });

  test("every event says where it ran, or the fleet never shows it", () => {
    // db.ts lifts `project_path` and `cwd_path` straight out of the payload
    // JSON, and the fleet list filters on them. Events without these land in
    // the store and then appear nowhere — which looks exactly like the chat
    // never having been recorded at all. Found by driving a real turn, not by
    // reading the code.
    const ctx = newFrameContext("/repo/checkout");
    for (const f of [
      init,
      { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input", text_delta: "go" } },
      { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "list_dir" } },
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "list_dir", tool_info: { output: "x" } } },
      { event: "result", result: { status: "SUCCESS", usage: {} } },
    ]) {
      const e = frameToEvent(f, ctx);
      expect(e, JSON.stringify(f).slice(0, 40)).not.toBeNull();
      expect(e!.payload!.cwd, e!.hook_event_type).toBeTruthy();
      expect(e!.payload!.project_path, e!.hook_event_type).toBeTruthy();
    }
  });

  test("the directory the CLI reports wins over the one we asked for", () => {
    // `--add-dir` and a workspace can move it, and the init frame is the CLI
    // saying where it actually ended up.
    const ctx = newFrameContext("/repo/asked");
    frameToEvent({ ...init, init: { ...init.init, cwd: "/repo/actual" } }, ctx);
    expect(ctx.cwd).toBe("/repo/actual");
  });

  test("nothing is emitted before a conversation exists", () => {
    // Every event needs a session id, and until `init` there is none. Guessing
    // one would scatter a turn across sessions nobody can find.
    const ctx = newFrameContext();
    const orphan = { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input", text_delta: "hi" } };
    expect(frameToEvent(orphan, ctx)).toBeNull();
  });

  test("a tool becomes a Pre/Post pair sharing one id", () => {
    const ctx = newFrameContext();
    frameToEvent(init, ctx);
    const pre = frameToEvent({
      event: "step_update",
      step_update: { conversation_id: UUID, step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir" } },
    }, ctx)!;
    const post = frameToEvent({
      event: "step_update",
      step_update: { conversation_id: UUID, step_index: 3, state: "DONE", step_type: "tool", tool_name: "list_dir", duration_seconds: 0.04, tool_info: { name: "list_dir", output: "a\nb" } },
    }, ctx)!;
    expect(pre.hook_event_type).toBe("PreToolUse");
    expect(post.hook_event_type).toBe("PostToolUse");
    // The pairing is what produces a latency figure at all, so the two halves
    // must agree on the id.
    expect(pre.payload!.tool_use_id).toBe(post.payload!.tool_use_id);
    expect(post.payload!.tool_name).toBe("list_dir");
    expect(post.payload!.tool_response).toBe("a\nb");
  });

  test("a DONE half still names its tool if only the ACTIVE half carried it", () => {
    const ctx = newFrameContext();
    frameToEvent(init, ctx);
    frameToEvent({ event: "step_update", step_update: { step_index: 7, state: "ACTIVE", step_type: "tool", tool_name: "run_command" } }, ctx);
    const post = frameToEvent({ event: "step_update", step_update: { step_index: 7, state: "DONE", step_type: "tool", tool_info: { output: "ok" } } }, ctx)!;
    expect(post.payload!.tool_name).toBe("run_command");
  });

  test("the prompt is kept, the way Claude Code's hooks keep it", () => {
    const ctx = newFrameContext();
    frameToEvent(init, ctx);
    const e = frameToEvent({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input", text_delta: "list the files" } }, ctx)!;
    expect(e.hook_event_type).toBe("UserPromptSubmit");
    expect(e.payload!.prompt).toBe("list the files");
  });

  test("result closes the turn with what it spent", () => {
    const ctx = newFrameContext();
    frameToEvent(init, ctx);
    const e = frameToEvent({
      event: "result",
      result: { conversation_id: UUID, status: "SUCCESS", usage: { input_tokens: 16609, output_tokens: 108, thinking_tokens: 40, cache_read_tokens: 61046, total_tokens: 16717 } },
    }, ctx)!;
    expect(e.hook_event_type).toBe("Turn complete");
    const u = e.payload!.usage as Record<string, number>;
    expect(u.input_tokens).toBe(16609);
    expect(u.cache_read_tokens).toBe(61046);
    // Thinking tokens are already counted inside `output_tokens`, so adding
    // them again would bill every reasoning turn twice.
    expect(u.output_tokens).toBe(108);
  });

  test("the frames that are not events say so", () => {
    const ctx = newFrameContext();
    frameToEvent(init, ctx);
    for (const type of ["agent_response", "thinking", "checkpoint", "unknown", "error_message"]) {
      expect(frameToEvent({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: type } }, ctx), type).toBeNull();
    }
    expect(frameToEvent({ event: "something_new" }, ctx)).toBeNull();
  });

  test("a conversation id that is not one is refused", () => {
    // The id reaches `--conversation` on a command line and is the key every
    // event for this turn is filed under.
    const ctx = newFrameContext();
    expect(frameToEvent({ event: "init", conversation_id: "../../etc/passwd", init: {} }, ctx)).toBeNull();
    expect(ctx.sessionId).toBe("");
  });
});

// Codex's frames, folded into a chat.
//
// The frames below are a real capture from `codex exec --json` (CLI 0.146) —
// a first turn that ran a command, then a resumed turn that edited a file, then
// a one-word third turn. They are pasted verbatim rather than hand-written,
// because every assumption this parser makes about Codex's vocabulary was read
// off this capture and nothing else documents it.
import { test, expect, beforeAll, describe } from "bun:test";

let store: typeof import("../src/lib/chatStore.ts");
let frames: typeof import("../src/lib/codexFrames.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  store = await import("../src/lib/chatStore.ts");
  frames = await import("../src/lib/codexFrames.ts");
});

/** A codex chat mid-turn: the user's message and the empty assistant turn
 *  `send()` pushes before any frame arrives. */
function turning() {
  const c = store.newChat("/tmp/repo", "gpt-5.6-sol", "read-only", undefined, "codex");
  store.update(c.id, (x) => {
    x.messages.push({ role: "user", text: "go", tools: [], ts: Date.now() });
    x.messages.push({ role: "assistant", text: "", tools: [], ts: Date.now(), streaming: true });
  });
  return c.id;
}

const play = (id: string, ...fs: Array<Record<string, unknown>>) => {
  for (const f of fs) store.update(id, (c) => frames.applyCodexFrame(c, f));
};
const chat = (id: string) => store.getChat(id)!;
/** The assistant turn in progress — index 1, after the user message. */
const reply = (id: string) => chat(id).messages[1];

// --- the capture -------------------------------------------------------------
const THREAD = "019fb8f6-aabc-72e3-80fe-66edcdf559f5";
const TURN_ONE: Array<Record<string, unknown>> = [
  { type: "thread.started", thread_id: THREAD },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I’ll check the line count, read the README, and summarize." } },
  { type: "item.started", item: { id: "item_1", type: "command_execution", command: "/usr/bin/bash -lc \"wc -l README.md\"", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/usr/bin/bash -lc \"wc -l README.md\"", aggregated_output: "3 README.md\n", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "This is a scratch repository." } },
  { type: "turn.completed", usage: { input_tokens: 30377, cached_input_tokens: 24064, cache_write_input_tokens: 0, output_tokens: 132, reasoning_output_tokens: 19 } },
];

describe("a turn as codex actually reports it", () => {
  test("the thread id, the reply, and the command that ran all land", () => {
    const id = turning();
    play(id, ...TURN_ONE);
    const c = chat(id);
    // The id every following turn is resumed with.
    expect(c.sessionId).toBe(THREAD);
    const last = c.messages[c.messages.length - 1];
    // Codex says a turn in several complete items; they read as one reply, but
    // as separate paragraphs rather than one run-on sentence.
    expect(last.text).toBe("I’ll check the line count, read the README, and summarize.\n\nThis is a scratch repository.");
    const [tool] = last.tools;
    expect([tool.name, tool.target, tool.output, tool.error])
      .toEqual(["Bash", "/usr/bin/bash -lc \"wc -l README.md\"", "3 README.md", false]);
  });

  test("item.started and item.completed are one call, not two", () => {
    const id = turning();
    play(id, ...TURN_ONE);
    expect(reply(id).tools).toHaveLength(1);
  });

  test("a running command is not reported as having succeeded", () => {
    // `exit_code` is null while status is in_progress. Reading that as zero
    // would mark every command green before it had done anything.
    const id = turning();
    play(id, TURN_ONE[3]);
    expect(reply(id).tools[0].error).toBe(false);
    expect(reply(id).tools[0].output).toBe(null);
  });

  test("prose is taken from the terminal frame only, so it is never drawn twice", () => {
    // 0.146 emits each agent_message once, as item.completed. Folding
    // item.updated in as well would double the reply the day Codex starts
    // streaming deltas — a silent failure that reads as the model stuttering.
    // The cost of choosing this way round is a reply that lands whole instead
    // of typing itself out, which is what it does today regardless.
    const id = turning();
    play(id,
      { type: "item.updated", item: { id: "item_0", type: "agent_message", text: "Half a th" } },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Half a thought." } },
    );
    expect(reply(id).text).toBe("Half a thought.");
  });

  test("a failed command is marked from its exit code", () => {
    const id = turning();
    play(id, { type: "item.completed", item: { id: "i", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "completed" } });
    expect(reply(id).tools[0].error).toBe(true);
  });
});

describe("usage", () => {
  test("is assigned, not accumulated — codex reports thread totals", () => {
    // Measured against the real CLI: a one-word third turn moved output_tokens
    // from 258 to 263. Summing these would report several times the real spend
    // within a handful of turns.
    const id = turning();
    play(id, ...TURN_ONE);
    play(id, { type: "turn.completed", usage: { input_tokens: 61749, cached_input_tokens: 49152, cache_write_input_tokens: 0, output_tokens: 258 } });
    play(id, { type: "turn.completed", usage: { input_tokens: 77692, cached_input_tokens: 64256, cache_write_input_tokens: 0, output_tokens: 263 } });
    const u = chat(id).usage!;
    expect(u.output).toBe(263);
    expect(u.cacheRead).toBe(64256);
    // input_tokens includes the cached part; Claude's excludes it. The column
    // has to mean the same thing in both, so the cache is subtracted out.
    expect(u.input).toBe(77692 - 64256);
  });

  test("no context meter and no cost, because codex reports neither", () => {
    // The exec stream carries no per-turn prompt size and no window, and the
    // cumulative delta over-reads a turn that made several API calls. A missing
    // meter is better than one drawn nearly full on a session with room.
    const id = turning();
    play(id, ...TURN_ONE);
    expect(chat(id).usage!.contextTokens).toBe(0);
    expect(chat(id).usage!.costUsd).toBe(0);
  });

  test("a usage object missing fields does not produce NaN", () => {
    const id = turning();
    play(id, { type: "turn.completed", usage: {} });
    expect(chat(id).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, costUsd: 0 });
  });
});

describe("the other item types", () => {
  test("a file change names what it touched and what it did", () => {
    const id = turning();
    play(id, { type: "item.completed", item: { id: "i", type: "file_change", changes: [{ path: "/tmp/repo/README.md", kind: "update" }], status: "completed" } });
    const [t] = reply(id).tools;
    expect([t.name, t.target, t.note]).toEqual(["Edit", "/tmp/repo/README.md", "update"]);
  });

  test("reasoning is kept apart from the answer", () => {
    const id = turning();
    play(id, { type: "item.completed", item: { id: "i", type: "reasoning", text: "thinking out loud" } });
    const last = reply(id);
    expect(last.thinking).toBe("thinking out loud");
    expect(last.text).toBe("");
  });

  test("a web search shows its query", () => {
    const id = turning();
    play(id, { type: "item.completed", item: { id: "i", type: "web_search", query: "bun test timeout" } });
    const [t] = reply(id).tools;
    expect([t.name, t.target]).toEqual(["WebSearch", "bun test timeout"]);
  });
});

describe("failure", () => {
  test("a failed turn says so and asks for you", () => {
    const id = turning();
    play(id, { type: "turn.failed", error: { message: "rate limit reached" } });
    expect(reply(id).text).toContain("[error] rate limit reached");
    expect(chat(id).attention).toBe("blocked");
  });

  test("an error item is surfaced in the reply", () => {
    const id = turning();
    play(id, { type: "item.completed", item: { id: "i", type: "error", message: "the model refused" } });
    expect(reply(id).text).toContain("[error] the model refused");
  });
});

describe("frames we do not understand", () => {
  test("are ignored rather than drawn", () => {
    // Codex ships new item types regularly. A chat that printed "[unknown
    // frame]" every time one appeared would be worse than one that just does
    // not draw it yet.
    const id = turning();
    play(id,
      { type: "turn.started" },
      { type: "something.new", payload: { a: 1 } },
      { type: "item.completed", item: { id: "i", type: "a_type_from_the_future", detail: "x" } },
      { type: "item.completed", item: {} },
      {},
    );
    const c = chat(id);
    expect(c.messages).toHaveLength(2);
    expect(reply(id).text).toBe("");
    expect(reply(id).tools).toHaveLength(0);
  });
});

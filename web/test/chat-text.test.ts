import { test, expect, beforeAll } from "bun:test";

// A turn is one bubble, but the model reaches it in several frames: a sentence,
// a tool call, the next sentence. Those arrived concatenated raw, so a turn's
// separate remarks ran together mid-word and the bubble became one paragraph
// nobody can skim. These pin the join — and the case where adding a break of
// our own would damage the markdown instead of helping it.

let store: typeof import("../src/lib/chatStore.ts");
let api: typeof import("../src/lib/api.ts")["api"];
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  api = (await import("../src/lib/api.ts")).api;
  store = await import("../src/lib/chatStore.ts");
});

const active = () => true;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Replay a turn as the CLI actually frames it: one message per block. */
function replay(...blocks: Array<Record<string, unknown>>) {
  api.chatStream = (async (_p: unknown, onEvent: (o: Record<string, unknown>) => void) => {
    for (const b of blocks) onEvent({ type: "assistant", message: { content: [b] } });
  }) as typeof api.chatStream;
}

test("two sentences from two frames do not run together", async () => {
  replay(
    { type: "text", text: "The list is duplicated in your screenshot." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "rg dup" } },
    { type: "text", text: "Picking it up with the new finding." },
  );
  const c = store.newChat("/tmp/repo");
  await store.send(c.id, "go", active);
  await tick();
  const [m] = store.getChat(c.id)!.messages.filter((x) => x.role === "assistant");
  expect(m.text).toBe("The list is duplicated in your screenshot.\n\nPicking it up with the new finding.");
  store.closeChat(c.id);
});

test("a block that already ends in a break keeps its own spacing", async () => {
  // A list or a code fence closes with a newline. A blank line bolted on top of
  // it opens a gap the author did not write.
  replay(
    { type: "text", text: "Two things:\n- the fold\n- the join\n" },
    { type: "text", text: "Both shipped." },
  );
  const c = store.newChat("/tmp/repo");
  await store.send(c.id, "go", active);
  await tick();
  const [m] = store.getChat(c.id)!.messages.filter((x) => x.role === "assistant");
  expect(m.text).toBe("Two things:\n- the fold\n- the join\nBoth shipped.");
  store.closeChat(c.id);
});

test("reasoning is joined the same way the answer is", async () => {
  replay(
    { type: "thinking", thinking: "First I check the store." },
    { type: "thinking", thinking: "Then the panel." },
  );
  const c = store.newChat("/tmp/repo");
  await store.send(c.id, "go", active);
  await tick();
  const [m] = store.getChat(c.id)!.messages.filter((x) => x.role === "assistant");
  expect(m.thinking).toBe("First I check the store.\n\nThen the panel.");
  store.closeChat(c.id);
});

test("the join is a no-op on the first block and on an empty one", () => {
  expect(store.joinBlock("", "hello")).toBe("hello");
  expect(store.joinBlock("hello", "")).toBe("hello");
});

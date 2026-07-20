import { test, expect, beforeAll } from "bun:test";

// A tool the allowlist refused is invisible: `claude -p` has no terminal to
// prompt from, so the turn carries on without it and the only symptom is the
// model saying it is blocked. The banner exists to name it — which makes a
// false positive expensive, since it teaches you to distrust the one signal
// that means anything. These pin what does and does not raise it.

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

/** Replay one Bash call and the result it came back with. */
function replay(result: string) {
  api.chatStream = (async (_p: unknown, onEvent: (o: Record<string, unknown>) => void) => {
    onEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "find /" } }] },
    });
    onEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: result }] },
    });
  }) as typeof api.chatStream;
}

test("a real refusal names the tool so the banner can offer to allow it", async () => {
  replay("Claude requested permissions to use Bash, but you haven't granted it yet.");
  const c = store.newChat("/tmp/repo");
  await store.send(c.id, "go", active);
  await tick();
  expect(store.getChat(c.id)!.blockedTool).toBe("Bash");
  expect(store.getChat(c.id)!.attention).toBe("blocked");
  store.closeChat(c.id);
});

test("`Permission denied` in ordinary output is not a refusal", async () => {
  // The tool ran. It walked past a directory it could not read and said so —
  // which used to be enough to announce a block on a turn nothing blocked.
  replay("find: '/proc/1/task': Permission denied\nfind: '/root': Permission denied");
  const c = store.newChat("/tmp/repo");
  await store.send(c.id, "go", active);
  await tick();
  expect(store.getChat(c.id)!.blockedTool).toBeUndefined();
  store.closeChat(c.id);
});

test("bypass mode never raises the banner", async () => {
  // It sends no allowlist and `--dangerously-skip-permissions` refuses
  // nothing, so the banner's offer to add the tool to a list is meaningless
  // there — it points at a control the mode doesn't use.
  replay("Claude requested permissions to use Bash, but you haven't granted it yet.");
  const c = store.newChat("/tmp/repo");
  store.update(c.id, (x) => { x.mode = "bypassPermissions"; });
  await store.send(c.id, "go", active);
  await tick();
  expect(store.getChat(c.id)!.blockedTool).toBeUndefined();
  store.closeChat(c.id);
});

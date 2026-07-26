// Copying a whole chat out as markdown.
//
// What matters here is that nothing is silently lost. The panel folds tool calls
// and reasoning away, and a copy that quietly dropped what was folded would look
// complete and not be — which is worse than a copy that visibly says how much it
// trimmed.
import { test, expect } from "bun:test";
import { chatToMarkdown } from "../src/lib/chatTranscript.ts";
import type { Chat, ChatMsg } from "../src/lib/chatStore.ts";

const AT = new Date(2026, 6, 26, 19, 4).getTime();

function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: "c1", cwd: "/home/x/repo", model: "claude-opus-5", mode: "default",
    title: "A chat", messages: [], sessionId: "", sending: false, draft: "",
    attachments: [], queued: [], createdAt: AT, abort: null, unread: false,
    attention: "none", ...over,
  } as Chat;
}
const msg = (over: Partial<ChatMsg> = {}): ChatMsg =>
  ({ role: "assistant", text: "", tools: [], ts: AT, ...over }) as ChatMsg;

test("the header carries what a pasted chat is worthless without", () => {
  const out = chatToMarkdown(chat({ sessionId: "abcd-1234", resolvedModel: "claude-opus-5[1m]" }));
  expect(out).toContain("# A chat");
  // The directory and the model are exactly what nobody remembers to add by
  // hand when pasting a conversation into an issue.
  expect(out).toContain("`/home/x/repo`");
  expect(out).toContain("claude-opus-5[1m]");
  expect(out).toContain("abcd-1234");
});

test("an empty chat says so rather than copying nothing", () => {
  // A blank clipboard is indistinguishable from a copy that failed.
  expect(chatToMarkdown(chat())).toContain("(no messages yet)");
});

test("both speakers are named and stamped", () => {
  const out = chatToMarkdown(chat({
    messages: [msg({ role: "user", text: "do the thing" }), msg({ text: "done" })],
  }));
  expect(out).toContain("### You · 2026-07-26 19:04");
  expect(out).toContain("### Claude · 2026-07-26 19:04");
  expect(out).toContain("do the thing");
  expect(out).toContain("done");
});

test("folded reasoning and tool calls survive the copy", () => {
  const out = chatToMarkdown(chat({
    messages: [msg({
      text: "here you go",
      thinking: "first I should check the file",
      tools: [{ id: "t1", name: "Bash", target: "git status", output: "clean", error: false, ts: AT, note: "Check the tree" }],
    })],
  }));
  expect(out).toContain("first I should check the file");
  expect(out).toContain("**Bash(git status)**");
  expect(out).toContain("clean");
  expect(out).toContain("Check the tree");
  // Folded in the markdown too, the same shape the panel gives them — present
  // for whoever wants it, not in the way of the answer.
  expect(out).toContain("<details><summary>Thinking</summary>");
  expect(out).toContain("1 tool call");
});

test("a failed tool is marked as failed", () => {
  const out = chatToMarkdown(chat({
    messages: [msg({ tools: [{ id: "t1", name: "Bash", target: "false", output: "boom", error: true, ts: AT, note: null }] })],
  }));
  expect(out).toContain("— failed");
});

test("a huge tool output is trimmed visibly, not silently", () => {
  const out = chatToMarkdown(chat({
    messages: [msg({ tools: [{ id: "t1", name: "Read", target: "big.txt", output: "x".repeat(9_000), error: false, ts: AT, note: null }] })],
  }));
  expect(out).toContain("more characters]");
  // The point of the cap: one command's stdout must not become the whole
  // transcript.
  expect(out.length).toBeLessThan(9_000);
});

test("images are reported even when the pixels were dropped on reload", () => {
  const out = chatToMarkdown(chat({
    messages: [msg({ role: "user", text: "look", imagesDropped: 2 })],
  }));
  // Otherwise a restored chat reads as though the question had no screenshot,
  // and the answer below it makes no sense.
  expect(out).toContain("2 images attached");
});

test("a tmux chat carries the command that reopens it in a terminal", () => {
  const out = chatToMarkdown(chat({ attachCommand: "tmux -L agentglass attach -t abc" }));
  expect(out).toContain("tmux -L agentglass attach -t abc");
});

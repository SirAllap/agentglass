/*
 * Finding a chat.
 *
 * The list had no search, held forty rows, and hid some of them. So "All" meant
 * "the newest forty", said "All", and a conversation whose last model-bearing
 * line happened to be `<synthetic>` was not in it — or in any other scope —
 * with nothing anywhere to say so.
 *
 * Claude Code writes `<synthetic>` for an injected or interrupted turn, so that
 * filter was using the model name as a proxy for "has a transcript", and the
 * proxy is wrong in exactly the case that matters: a long conversation you
 * interrupted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeSessions, searchSessions, canResume } from "../src/mobile/chatList.ts";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const NOW = 1_800_000_000_000;
const s = (id: string, over: Record<string, unknown> = {}) => ({
  session_id: id, last_seen: NOW - 10_000, ended_at: null,
  model_name: "claude-opus-5", cost_usd: 1, ...over,
});

const FLEET = [
  s("a", { ai_title: "Rebuild the companion UI", cwd_path: "/home/x/code/agentglass", model_name: "claude-opus-5" }),
  s("b", { custom_title: "Port the pane resize handler", cwd_path: "/home/x/code/tmux-chat", model_name: "claude-haiku-4-5" }),
  s("c", { project_path: "/home/x/code/agentglass", source_app: "claude-code" }),
];

describe("search", () => {
  test("finds a chat by its title", () => {
    expect(searchSessions(FLEET, "companion").map((x) => x.session_id)).toEqual(["a"]);
  });

  test("finds one by its project", () => {
    expect(searchSessions(FLEET, "tmux").map((x) => x.session_id)).toEqual(["b"]);
  });

  test("finds one by its model", () => {
    expect(searchSessions(FLEET, "haiku").map((x) => x.session_id)).toEqual(["b"]);
  });

  test("finds one with no title at all, by id", () => {
    // The rows that read `agentglass:cd3fa401` are exactly the ones you cannot
    // pick out by eye, so the id has to be searchable.
    expect(searchSessions(FLEET, "c").some((x) => x.session_id === "c")).toBe(true);
  });

  test("every term must match, so two words narrow", () => {
    expect(searchSessions(FLEET, "companion tmux")).toHaveLength(0);
    expect(searchSessions(FLEET, "companion agentglass").map((x) => x.session_id)).toEqual(["a"]);
  });

  test("an empty query is not a filter", () => {
    expect(searchSessions(FLEET, "   ")).toHaveLength(3);
  });

  test("it is case insensitive", () => {
    expect(searchSessions(FLEET, "COMPANION").map((x) => x.session_id)).toEqual(["a"]);
  });
});

describe("nothing is hidden", () => {
  test("a synthetic model name does not remove a session from any scope", () => {
    const withSynthetic = [...FLEET, s("interrupted", { model_name: "<synthetic>" })];
    for (const scope of ["live", "today", "all"] as const) {
      expect(
        scopeSessions(withSynthetic, scope, NOW).some((x) => x.session_id === "interrupted"),
        `scope ${scope}`,
      ).toBe(true);
    }
  });

  test("a session with nowhere to run is listed and marked", () => {
    expect(canResume(s("orphan"))).toBe(false);
    expect(canResume(s("placed", { cwd_path: "/home/x/code/app" }))).toBe(true);
    expect(canResume(s("byproject", { project_path: "/home/x/code/app" }))).toBe(true);
  });
});

describe("the wiring", () => {
  test("the list fetches a page worth searching", () => {
    // 40 was the size while there was no search, and it is what made "All" a
    // lie. The desktop has always taken 200.
    const app = code(read("mobile/MobileApp.tsx"));
    expect(app).toContain("api.sessions(200)");
    expect(app).not.toContain("api.sessions(40)");
  });

  test("searching looks past the open scope", () => {
    // Answering out of the rows already on screen makes search feel broken:
    // the chat you are looking for is precisely the one not in front of you.
    const chats = code(read("mobile/MobileChats.tsx"));
    expect(chats).toContain("searchSessions(sessions, query)");
  });

  test("what an agent says is rendered as markdown", () => {
    // Half of it is code. As plain text a fenced block arrived as literal
    // backticks reflowed in a proportional font.
    const chats = code(read("mobile/MobileChats.tsx"));
    expect(chats).toContain("<Markdown text={text} />");
    // Your own message is not markup and stays verbatim.
    expect(chats).toContain("mine ?");
  });

  test("a code block scrolls rather than reflowing", () => {
    const ui = read("mobile/mobileUi.tsx");
    expect(ui).toContain(".mb-md pre{overflow-x:auto");
  });
});

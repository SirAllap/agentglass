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
import { scopeSessions, searchSessions, canResume } from "../src/model/chatList.ts";

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

/*
 * A fourth describe pinned the wiring — the page size, that search reads the
 * whole fleet rather than the open scope, markdown rendering, scrolling code
 * blocks — by reading MobileApp.tsx, MobileChats.tsx and mobileUi.tsx as text.
 * Those files no longer exist. The rules they encoded are the native Chats
 * tab's problem now, and asserting them against source is not how this app is
 * tested: it renders through Expo, so `.qa-shots/chats.png` is the evidence.
 */

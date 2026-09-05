/*
 * The Lantern's mark survives the process: it was an in-memory set, the
 * server restarted at 16:24, and the chat opened at 16:23 came back as an
 * agent that needed a person. Now it is a row.
 */
import { expect, test } from "bun:test";
import { noteLanternSession, isLanternSession, __resetLanternSessions, hookSaysLantern, LANTERN_PROMPT_MARK } from "../src/lantern.ts";

test("a marked session is still marked after the cache is dropped, as a restart drops it", () => {
  __resetLanternSessions();
  noteLanternSession("persist-me");
  __resetLanternSessions();
  expect(isLanternSession("persist-me")).toBe(true);
  expect(isLanternSession("never-marked")).toBe(false);
});

test("what a hook has to say to be the Lantern: the role, or the prompt the app itself wrote", () => {
  expect(hookSaysLantern({ role: "lantern", hook_event_type: "PreToolUse" })).toBe(true);
  expect(hookSaysLantern({ hook_event_type: "UserPromptSubmit", payload: { prompt: `${LANTERN_PROMPT_MARK}: you read the field` } })).toBe(true);
  expect(hookSaysLantern({ hook_event_type: "UserPromptSubmit", payload: { prompt: "fix the export" } })).toBe(false);
  expect(hookSaysLantern({ hook_event_type: "Notification", payload: { message: LANTERN_PROMPT_MARK } })).toBe(false);
});

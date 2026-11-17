// Every hook event that was not a wait cleared the session's wait with a
// DELETE, which removed nothing nearly every time: a write transaction per
// event on the server's only thread. The statement now runs only for a session
// that has a wait.
import { beforeEach, expect, test } from "bun:test";
import * as db from "../src/db.ts";

const hook = (session: string, type: string, message?: string) => ({
  session_id: session, hook_event_type: type, payload: message ? { message } : {},
});

beforeEach(() => db.__forgetWaits());

test("a session that is not waiting costs no statement, however much it does", () => {
  const before = db.waitDeletes;
  for (let i = 0; i < 50; i++) db.noteWaitFromHook(hook("memo-busy", i % 2 ? "PostToolUse" : "PreToolUse"));
  expect(db.waitDeletes - before).toBe(0);
});

test("a wait is still cleared by the next thing the session does, once", () => {
  db.noteWaitFromHook(hook("memo-asked", "Notification", "Claude needs your permission to use Bash"), 1_000);
  expect(db.latestWaits(["memo-asked"]).get("memo-asked")?.kind).toBe("permission");
  const before = db.waitDeletes;
  db.noteWaitFromHook(hook("memo-asked", "PreToolUse"));
  expect(db.latestWaits(["memo-asked"]).has("memo-asked")).toBe(false);
  db.noteWaitFromHook(hook("memo-asked", "PostToolUse"));
  expect(db.waitDeletes - before).toBe(1);
});

test("a wait written before this process started is known, and cleared", () => {
  db.noteWaitFromHook(hook("memo-old", "Notification", "Claude is waiting for your input"), 2_000);
  db.__forgetWaits(); // a restart: the set is read from the table again
  db.noteWaitFromHook(hook("memo-old", "UserPromptSubmit"));
  expect(db.latestWaits(["memo-old"]).has("memo-old")).toBe(false);
});

test("the Lantern's own chat still clears what it once recorded", () => {
  db.noteWaitFromHook(hook("memo-lantern", "Notification", "Claude is waiting for your input"), 3_000);
  db.noteWaitFromHook({ ...hook("memo-lantern", "Notification", "Claude is waiting for your input"), role: "lantern" });
  expect(db.latestWaits(["memo-lantern"]).has("memo-lantern")).toBe(false);
});

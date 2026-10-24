/*
 * "Somebody changed this card", decided by what changed. A comment moves the
 * tracker's one stamp too, and a person's own comment used to refuse the
 * assignee change they made next, as if a colleague had edited the card.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { __clearSeen, facetsOf, judgeStale, noteSeen } from "../src/cardStamp.ts";

const OLD = "Somebody changed this card while you had it open";
const KEY = "clickup:t1";
const at = (status: string, people: string[], priority: string | null = "high") => facetsOf(status, people.map((p) => ({ key: p, name: p })), priority);

beforeEach(() => __clearSeen());

describe("a stamp that moved under fields the write does not set", () => {
  test("goes ahead", () => {
    noteSeen(KEY, 100, at("open", ["Ana"]));
    // A comment moved the stamp; status, people and priority are as they were.
    expect(judgeStale(KEY, 100, at("open", ["Ana"]), ["assignees"], OLD)).toEqual({ go: true });
  });

  test("goes ahead when another field moved but this write does not set it", () => {
    noteSeen(KEY, 100, at("open", ["Ana"]));
    expect(judgeStale(KEY, 100, at("done", ["Ana"]), ["assignees"], OLD)).toEqual({ go: true });
    expect(judgeStale(KEY, 100, at("open", ["Ana", "Bo"]), ["status"], OLD)).toEqual({ go: true });
  });

  test("two orders of one group are one value", () => {
    noteSeen(KEY, 100, at("open", ["Bo", "Ana"]));
    expect(judgeStale(KEY, 100, at("open", ["Ana", "Bo"]), ["assignees"], OLD)).toEqual({ go: true });
  });
});

describe("a field the write sets moved", () => {
  test("stops and says which, in the person's words", () => {
    noteSeen(KEY, 100, at("open", ["Ana"]));
    expect(judgeStale(KEY, 100, at("open", ["Bo"]), ["assignees"], OLD)).toEqual({
      go: false,
      error: "This card changed while you had it open: it is now assigned to Bo. Reloaded",
    });
    expect(judgeStale(KEY, 100, at("open", []), ["assignees"], OLD)).toMatchObject({ go: false, error: expect.stringContaining("nobody assigned") });
    expect(judgeStale(KEY, 100, at("done", ["Ana"]), ["status"], OLD)).toMatchObject({ go: false, error: expect.stringContaining("its status is now done") });
    expect(judgeStale(KEY, 100, at("open", ["Ana"], "low"), ["priority"], OLD)).toMatchObject({ go: false, error: expect.stringContaining("its priority is now low") });
  });

  test("a write that sets two fields names every one that moved", () => {
    noteSeen(KEY, 100, at("open", ["Ana"]));
    const r = judgeStale(KEY, 100, at("done", ["Bo"]), ["status", "assignees"], OLD);
    expect(r).toMatchObject({ go: false, error: expect.stringContaining("its status is now done, it is now assigned to Bo") });
  });
});

describe("a stamp this process never saw", () => {
  test("keeps the tracker's own sentence", () => {
    expect(judgeStale(KEY, 100, at("open", ["Ana"]), ["assignees"], OLD)).toEqual({ go: false, error: OLD });
    noteSeen(KEY, 100, at("open", ["Ana"]));
    // Seen at another stamp, or another card: still no baseline for this one.
    expect(judgeStale(KEY, 99, at("open", ["Ana"]), ["assignees"], OLD)).toEqual({ go: false, error: OLD });
    expect(judgeStale("clickup:t2", 100, at("open", ["Ana"]), ["assignees"], OLD)).toEqual({ go: false, error: OLD });
  });

  test("a read with no stamp leaves no baseline", () => {
    noteSeen(KEY, 0, at("open", ["Ana"]));
    expect(judgeStale(KEY, 0, at("open", ["Ana"]), ["assignees"], OLD)).toEqual({ go: false, error: OLD });
  });
});

describe("memory is bounded", () => {
  test("a card keeps its last few stamps, oldest out first", () => {
    for (let s = 1; s <= 5; s++) noteSeen(KEY, s, at("open", ["Ana"]));
    expect(judgeStale(KEY, 1, at("open", ["Ana"]), ["status"], OLD)).toEqual({ go: false, error: OLD });
    expect(judgeStale(KEY, 2, at("open", ["Ana"]), ["status"], OLD)).toEqual({ go: true });
    expect(judgeStale(KEY, 5, at("open", ["Ana"]), ["status"], OLD)).toEqual({ go: true });
  });

  test("the process keeps the most recent cards, and a read refreshes its card", () => {
    noteSeen("jira:ORBIT-1", 1, at("To Do", []));
    for (let i = 0; i < 399; i++) noteSeen(`jira:FILL-${i}`, 1, at("To Do", []));
    // ORBIT-1 is the oldest of 400; reading it again makes it the newest.
    noteSeen("jira:ORBIT-1", 2, at("To Do", []));
    noteSeen("jira:FILL-X", 1, at("To Do", []));
    expect(judgeStale("jira:ORBIT-1", 2, at("To Do", []), ["status"], OLD)).toEqual({ go: true });
    expect(judgeStale("jira:FILL-0", 1, at("To Do", []), ["status"], OLD)).toEqual({ go: false, error: OLD });
  });
});

/*
 * Where a tapped Jira card goes.
 *
 * The trap: a Jira key and a ClickUp custom id are the same string shape
 * (`ORBIT-1042`), so a router that decides by shape sends every Jira tap to
 * `/card/[id]` — a screen whose every call is `/clickup/*`, and which answers
 * "that card could not be read" for a card that exists. The tracker is carried
 * in the alert's data, because only the alert knows which one it is about, and
 * a notification is untrusted data.
 */
import { describe, expect, test } from "bun:test";
import type { CardNote } from "../../shared/types.ts";
import { alertRoute } from "../src/notifications/target.ts";
import { decideLive, itemFromCard, type WatchContext } from "../src/notifications/watchAlerts.ts";

const note = (over: Partial<CardNote> = {}): CardNote => ({
  kind: "comment", tracker: "jira", id: "ORBIT-1042", label: "ORBIT-1042", title: "Dark mode in Settings",
  status: "In progress", who: "Ana", said: "Have a look", ...over,
});

const ctx: WatchContext = { enabled: true, foreground: false, handled: new Map(), now: 1_000_000 };

describe("a tapped card", () => {
  test("a Jira card lands on the Jira card screen", () => {
    expect(alertRoute({ kind: "watch", card: "ORBIT-1042", jira: true }))
      .toEqual({ pathname: "/jira/[key]", params: { key: "ORBIT-1042" } });
  });

  test("a ClickUp custom id of the same shape still lands on the card screen", () => {
    // Without the flag, nothing changed for the tracker that was here first.
    expect(alertRoute({ kind: "watch", card: "ORBIT-1042" }))
      .toEqual({ pathname: "/card/[id]", params: { id: "ORBIT-1042" } });
  });

  test("the flag does not make a hostile id acceptable", () => {
    for (const id of ["../pair", "a/b", "a b", "x".repeat(65), 7, null]) {
      expect(alertRoute({ kind: "watch", card: id, jira: true })).toBeNull();
    }
  });

  test("the route is built from constants, never from the data's own strings", () => {
    const to = alertRoute({ kind: "watch", card: "ORBIT-1042", jira: true, pathname: "/pair", href: "/pair" });
    expect(Object.keys(to ?? {})).toEqual(["pathname", "params"]);
  });
});

describe("a Jira card note", () => {
  test("it becomes a notification whose tap carries the tracker", () => {
    const item = itemFromCard(note())!;
    expect(item).toMatchObject({ group: "card:jira:ORBIT-1042", card: { id: "ORBIT-1042", jira: true } });
    const verdict = decideLive(item, ctx);
    expect(verdict.notify).toBe(true);
    expect(verdict.notify && verdict.raise.data).toEqual({ kind: "watch", card: "ORBIT-1042", jira: true });
  });

  test("a ClickUp note carries no flag", () => {
    const item = itemFromCard(note({ tracker: undefined, id: "86abc12" }))!;
    expect(item.card).toEqual({ id: "86abc12" });
    expect(item.group).toBe("card:86abc12");
  });

  test("the two trackers' cards never collapse into one notification", () => {
    const jira = itemFromCard(note())!;
    const clickup = itemFromCard(note({ tracker: undefined }))!;
    expect(jira.group).not.toBe(clickup.group);
    expect(jira.id).not.toBe(clickup.id);
  });
});

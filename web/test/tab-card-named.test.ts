/*
 * A tab's card: the one the start named wins; a branch guess that is an old
 * tracker key with a Jira twin shows the twin.
 */
import { describe, expect, test } from "bun:test";
import { tabCardRef, createTwinStore, pickTwin } from "../src/lib/tabCard.ts";

const jira = { keys: ["ORBIT"], site: "acme.atlassian.net" };

describe("tabCardRef", () => {
  test("a card named at start beats the branch guess", () => {
    const r = tabCardRef("ORBIT-1042", "LEGACY-2002-add-thing", () => null, jira);
    expect(r?.label.toUpperCase()).toBe("ORBIT-1042");
  });
  test("with nothing named the branch decides", () => {
    const r = tabCardRef(null, "ORBIT-77-add-thing", () => null, jira);
    expect(r?.label.toUpperCase()).toBe("ORBIT-77");
  });
  test("an old key with a Jira twin shows the twin", () => {
    const r = tabCardRef(null, "LEGACY-2002-add-thing", (k) => (k === "LEGACY-2002" ? "ORBIT-1042" : null), jira);
    expect(r?.label.toUpperCase()).toBe("ORBIT-1042");
  });
  test("an old key without a twin stays as guessed", () => {
    const r = tabCardRef(null, "LEGACY-2002-add-thing", () => null, jira);
    expect(r?.label.toUpperCase()).toBe("LEGACY-2002");
  });
});

describe("createTwinStore", () => {
  test("asks once per key, answers from memory after", async () => {
    let calls = 0;
    const s = createTwinStore(async () => { calls++; return "ORBIT-1042"; });
    expect(s.twinOf("LEGACY-2002")).toBeNull();
    await s.settled();
    expect(s.twinOf("LEGACY-2002")).toBe("ORBIT-1042");
    s.twinOf("LEGACY-2002");
    expect(calls).toBe(1);
  });
  test("a miss is remembered too", async () => {
    let calls = 0;
    const s = createTwinStore(async () => { calls++; return null; });
    s.twinOf("LEGACY-1"); await s.settled(); s.twinOf("LEGACY-1");
    expect(calls).toBe(1);
  });
});

describe("pickTwin", () => {
  const desc: Record<string, string> = {
    "ORBIT-5": "See LEGACY-2002 for context. Migrated from ClickUp LEGACY-777",
    "ORBIT-1042": "Migrated from ClickUp LEGACY-2002",
  };
  test("skips a hit that only mentions the old key", async () => {
    expect(await pickTwin("LEGACY-2002", ["ORBIT-5", "ORBIT-1042"], async (k) => desc[k])).toBe("ORBIT-1042");
  });
  test("none when no description names it", async () => {
    expect(await pickTwin("LEGACY-2002", ["ORBIT-5"], async (k) => desc[k])).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { epicsOf, isEpicKey, jumpRows, matchScore, placesOf, rankPlaces, projectOf, pushRecent, readTyped, sectionStep } from "../src/components/jira/list/jumpModel.ts";
import { chordTarget } from "../src/lib/jiraQueryPalette.ts";

const card = (n: number, title = "Thing " + n) => ({ id: "id" + n, customId: "ORBIT-" + n, title, status: "To do", tags: [] }) as unknown as ProviderTask;
const cards = Array.from({ length: 10 }, (_, i) => card(1040 + i));
const queries = Array.from({ length: 9 }, (_, i) => ({ id: "jql:" + i, name: "Query " + i, jql: "status = Q" + i, team: false }));

describe("jump palette: what is typed", () => {
  test("a bare number is the project's key, a full key is itself, q: and JQL are searches", () => {
    expect(projectOf(cards)).toBe("ORBIT");
    expect(readTyped("1042", "ORBIT")).toEqual({ kind: "key", key: "ORBIT-1042" });
    expect(readTyped("orbit-7", "ORBIT")).toEqual({ kind: "key", key: "ORBIT-7" });
    expect(readTyped("q: status = Done", "ORBIT")).toEqual({ kind: "jql", jql: "status = Done" });
    expect(readTyped("status = 'Code review' AND assignee = me", "ORBIT").kind).toBe("jql");
    expect(readTyped("login bug", "ORBIT").kind).toBe("none");
    expect(readTyped("1042", "").kind).toBe("none");
  });
});

describe("jump palette: sections", () => {
  const epics = Array.from({ length: 8 }, (_, i) => ({ key: "ORBIT-" + (100 + i), name: "Epic " + i }));
  test("saved capped at 7, cards at 6, epics and recent as the mockup", () => {
    const r = jumpRows({ text: "", queries, recent: ["a = 1", "b = 2", "c = 3", "d = 4"], epics, cards });
    expect([r.saved.length, r.recent.length, r.epics.length, r.cards.length]).toEqual([7, 4, 8, 6]);
  });
  test("cards filter by substring in natural order", () => {
    const r = jumpRows({ text: "1043", queries: [], recent: [], epics: [], cards });
    expect(r.cards.map((c) => c.customId)).toEqual(["ORBIT-1043"]);
  });
  test("recent keeps the newest 4 without repeats", () => {
    let l: string[] = [];
    for (const j of ["a = 1", "b = 2", "c = 3", "d = 4", "a = 1", "e = 5"]) l = pushRecent(l, j);
    expect(l).toEqual(["e = 5", "a = 1", "d = 4", "c = 3"]);
  });
  test("Tab walks to the next section and wraps", () => {
    const secs = ["Saved", "Saved", "Cards", "Cards", "Cards"];
    expect(sectionStep(secs, 0, 1)).toBe(2);
    expect(sectionStep(secs, 3, 1)).toBe(0);
    expect(sectionStep(secs, 3, -1)).toBe(0);
    expect(sectionStep(secs, 0, -1)).toBe(2);
  });
});

describe("jump palette: a typed key that is an epic", () => {
  const epics = [{ key: "ORBIT-266", name: "Security - remediation" }, { key: "ORBIT-100", name: "Epic 0" }];
  test("matches a board epic's key, case-insensitively", () => {
    expect(isEpicKey(epics, "ORBIT-266")).toBe(true);
    expect(isEpicKey(epics, "orbit-266")).toBe(true);
    expect(isEpicKey(epics, "ORBIT-9999")).toBe(false);
    expect(isEpicKey(epics, "ORBIT-1042")).toBe(false);
  });
  test("a jump palette source file runs the epic's task list on Enter instead of opening it", async () => {
    const src = await Bun.file(new URL("../src/components/jira/JiraJump.tsx", import.meta.url)).text();
    expect(src).toContain("const openKey = async (key: string, epic?: JiraBoardEpic) => {");
    expect(src).toContain('if (epic) { runJql("parent = " + epic.key); return; }');
    expect(src).toContain('if ((r.task.issueType ?? "").toLowerCase() === "epic") runJql("parent = " + key);');
    expect(src).toContain("const localEpic = epicsOf(epics, cards).find((e) => e.key.toUpperCase() === typed.key.toUpperCase());");
  });
  test("a typed key resolved to an epic is tagged in the row", async () => {
    const src = await Bun.file(new URL("../src/components/jira/JiraJump.tsx", import.meta.url)).text();
    expect(src).toContain("Epic · Enter opens task list");
  });
});

describe("Ctrl K collision", () => {
  test("inside the Jira view it opens the Jira palette, outside the app's", () => {
    expect(chordTarget(true, null, true)).toBe("jira");
    expect(chordTarget(false, null, true)).toBe("app");
    expect(chordTarget(true, { tagName: "TEXTAREA" }, true)).toBe("none");
    expect(chordTarget(true, null, false)).toBe("app");
  });
  test("App sends the chord through openJiraJump inside the Jira view", async () => {
    const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    expect(src).toContain("if (!(jiraViewActiveNow() && openJiraJump())) setPaletteOpen((o) => !o);");
  });
});

describe("jump palette: epics are first-class", () => {
  const epicCard = { ...card(7, "Security RBAC"), issueType: "Epic" } as ProviderTask;
  const child = { ...card(8), parent: { key: "ORBIT-9", title: "Billing rework", type: "Epic" } } as ProviderTask;
  test("an epic is found by its name and by its key, with its title, though the board lists none", () => {
    const all = [epicCard, child, ...cards];
    expect(jumpRows({ text: "security rbac", queries: [], recent: [], epics: [], cards: all }).epics).toEqual([{ key: "ORBIT-7", name: "Security RBAC" }]);
    expect(jumpRows({ text: "ORBIT-9", queries: [], recent: [], epics: [], cards: all }).epics).toEqual([{ key: "ORBIT-9", name: "Billing rework" }]);
  });
  test("the epic mark: a typed key that is an epic of the cards resolves to it; board epics win and are not doubled", () => {
    const list = epicsOf([{ key: "ORBIT-7", name: "Board name", color: "blue" }], [epicCard, child]);
    expect(list.map((e) => e.key)).toEqual(["ORBIT-7", "ORBIT-9"]);
    expect(list[0]!.name).toBe("Board name");
    expect(isEpicKey(list, "orbit-9")).toBe(true);
    expect(isEpicKey(list, "ORBIT-1042")).toBe(false);
  });
});

describe("jump palette: words find places and cards", () => {
  const spaces = [{ key: "ORB", name: "Orbit Platform" }];
  const epic = (key: string, summary: string) => ({ key, id: key, summary, status: "open", done: 0, total: 1, components: ["Security"] }) as never;
  const reads = {
    ORB: { state: "ready", tree: { space: "ORB", noEpic: 0, total: 1, done: 0, hidDone: 0, readAt: 0, components: [
      { id: "1", name: "Security", issues: 3, empty: false, epics: [epic("ORB-143", "Security - SSRF"), epic("ORB-7", "Billing rewrite")] },
      { id: "2", name: "Payments", issues: 0, empty: true, epics: [] },
    ] } },
  } as never;

  test("matchScore: case-insensitive, word prefix beats substring, every word must match", () => {
    expect(matchScore("Security - SSRF", "ssrf")).toBeGreaterThan(0);
    expect(matchScore("Security - SSRF", "SEC")).toBeGreaterThan(matchScore("Security - SSRF", "ecur"));
    expect(matchScore("Security - SSRF", "ecur")).toBeGreaterThan(0);
    expect(matchScore("Security - SSRF", "ssrf login")).toBe(0);
    expect(matchScore("Security - SSRF", "sec ssrf")).toBeGreaterThan(0);
    expect(matchScore("Billing", "ssrf")).toBe(0);
  });

  test("placesOf lists spaces, components and epics", () => {
    const p = placesOf(spaces, reads);
    expect(p.map((x) => x.kind + ":" + x.name)).toEqual(["space:Orbit Platform", "component:Security", "component:Payments", "epic:Security - SSRF", "epic:Billing rewrite"]);
  });

  test("rankPlaces: ssrf finds the epic by a word of its name, best match first", () => {
    const p = placesOf(spaces, reads);
    expect(rankPlaces(p, "ssrf").map((x) => x.key)).toEqual(["ORB-143"]);
    expect(rankPlaces(p, "secur").map((x) => x.name)).toEqual(["Security", "Security - SSRF"]);
    expect(rankPlaces(p, "orb-14").map((x) => x.key)).toEqual(["ORB-143"]);
    expect(rankPlaces(p, "nothing")).toEqual([]);
  });

  test("cards on the board match by key or title words, best first", () => {
    const cs = [card(1, "Fix login"), card(2, "SSRF guard on webhooks"), card(3, "Block ssrf in fetch")];
    const r = jumpRows({ text: "ssrf", queries: [], recent: [], epics: [], cards: cs });
    expect(r.cards.map((c) => c.customId)).toEqual(["ORBIT-2", "ORBIT-3"]);
  });

  test("global: inside epic A's page (only A's cards loaded), a query naming epic B still lists B", () => {
    const inA = [card(1, "Rotate keys"), card(2, "Audit log")];
    const r = jumpRows({ text: "ssrf", queries: [], recent: [], epics: [{ key: "ORB-7", name: "Billing rewrite" }], cards: inA });
    expect(r.cards).toEqual([]);
    expect(rankPlaces(placesOf(spaces, reads), "ssrf").map((x) => x.key)).toEqual(["ORB-143"]);
  });
});

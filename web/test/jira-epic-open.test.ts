/*
 * Opening a card from a link, and the epic link in a card's header, load the epic's page and nothing carried over.
 * Fakes only (ORBIT-*): the data shape is epic ORBIT-122 > task ORBIT-128 > sub-task ORBIT-130.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderTask } from "../../shared/providers.ts";
import { epicOfCard, scopeOfCard, scopeOfFound } from "../src/lib/jiraCardScope.ts";
import { placeOf } from "../src/components/jira/detail/DetailHeader.tsx";
import { scopeIdOf } from "../src/lib/jiraTree.ts";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const mk = (over: Partial<ProviderTask>) => ({ id: "ORBIT-1", customId: "ORBIT-1", title: "t", list: "Orbit Platform", listId: "ORBIT", issueType: "Task", ...over }) as ProviderTask;
const epicParent = { key: "ORBIT-122", title: "Security RBAC", type: "Epic" };
const task = mk({ id: "ORBIT-128", customId: "ORBIT-128", parent: epicParent });
const sub = mk({ id: "ORBIT-130", customId: "ORBIT-130", issueType: "Sub-task", parent: { key: "ORBIT-128", title: "Task" } });
const EPIC_SCOPE = scopeIdOf({ kind: "epic", space: "ORBIT", epic: "ORBIT-122" } as Parameters<typeof scopeIdOf>[0]);

describe("the page a found card opens", () => {
  test("a task opens its epic's page", () => { expect(scopeOfCard(task)).toBe(EPIC_SCOPE); });
  test("a sub-task walks up: parent task, then its epic", () => {
    expect(scopeOfCard(sub, task)).toBe(EPIC_SCOPE);
    expect(epicOfCard(sub, task)?.title).toBe("Security RBAC");
  });
  test("no epic: the space page", () => { expect(scopeOfCard(mk({}))).toBe(scopeIdOf({ kind: "space", space: "ORBIT" })); });
  test("a sub-task whose parent is unreadable falls back to the space, never to nothing", () => {
    expect(scopeOfCard(sub, null)).toBe(scopeIdOf({ kind: "space", space: "ORBIT" }));
  });
  test("scopeOfFound reads the parent through the source", async () => {
    const asked: string[] = [];
    const source = { find: async (k: string) => { asked.push(k); return { ok: true, task } as never; } };
    expect(await scopeOfFound(source, sub)).toBe(EPIC_SCOPE);
    expect(asked).toEqual(["ORBIT-128"]);
  });
});

describe("the sub-task's path line", () => {
  test("shows the parent's epic and links it", () => {
    const p = placeOf(sub, undefined, task);
    expect(p.epic).toEqual({ name: "Security RBAC", key: "ORBIT-122" });
  });
  test("without the parent read yet it shows the space only", () => { expect(placeOf(sub, undefined).epic).toBeUndefined(); });
  test("DetailHeader reads the parent for a sub-task", () => {
    expect(read("components/jira/detail/DetailHeader.tsx")).toMatch(/useCardRead\(/);
  });
});

describe("the header link and the link-open carry nothing over (filter audit entry points)", () => {
  const panel = read("components/TasksPanel.tsx");
  const req = panel.slice(panel.indexOf("const { viewId, areaId } = jiraReq.want;"), panel.indexOf("}, [jiraReq.seq]);"));
  test("a view request from the card header leaves Looked up", () => { expect(req).toContain("setOnLooked(false)"); });
  test("a card found by key loads its scope page, selected, off Looked up", () => {
    const rev = panel.slice(panel.indexOf("const reveal = useCallback("), panel.indexOf("}, [jump?.n", panel.indexOf("const reveal = useCallback(")));
    expect(rev).toContain("scopeOfFound(");
    expect(rev).toContain("load(scope");
  });
});

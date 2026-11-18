/*
 * The Family block's rules as pure functions: umbrella and progress, siblings in Jira's order with this card marked, blockers from
 * issue links in both directions, keys named in the text (resolved or only "mentioned"), the warning, the hint, sibling steps.
 * Invented keys; links built through the server's own linkedOf so the fixture has the real Jira shape.
 */
import { describe, expect, test } from "bun:test";
import { linkedOf } from "../../server/src/jiraCardRead.ts";
import { familyBlockOf, familyOpen, hasDependencies, hasFamily, hasRelated, mentionedKeys, siblingStep, wayOf } from "../src/lib/familyBlock.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const task = (key: string, status: string, kind: ProviderTask["statusKind"], extra: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id: key, customId: key, title: `${key} title`, url: "", status, statusKind: kind, tags: [], ...extra }) as unknown as ProviderTask;
const stub = (key: string, status: string, kind: "new" | "indeterminate" | "done") =>
  ({ key, fields: { summary: `${key} title`, status: { name: status, statusCategory: { key: kind } } } });
const toRow = (s: unknown): ProviderTask | null => {
  const o = s as { key: string; fields: { status: { name: string; statusCategory: { key: string } } } };
  return task(o.key, o.fields.status.name, o.fields.status.statusCategory.key === "done" ? "done" : "open");
};
const linksOf = (issuelinks: unknown[]) => linkedOf({ issuelinks }, toRow);
const blocks = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
const relates = { name: "Relates", inward: "relates to", outward: "relates to" };

const me = task("ORBIT-135", "In progress", "open", { issueType: "Sub-task", parent: { key: "ORBIT-123", title: "RBAC reporting", type: "Task" } });
const umbrella = task("ORBIT-123", "In progress", "open", { issueType: "Task" });
const subs = [task("ORBIT-134", "Done", "done"), me, task("ORBIT-136", "To do", "open"), task("ORBIT-137", "To do", "open")];

describe("wayOf", () => {
  test("reads each side of the link wording", () => {
    expect(wayOf("is blocked by")).toBe("blockedBy");
    expect(wayOf("depends on")).toBe("blockedBy");
    expect(wayOf("blocks")).toBe("blocks");
    expect(wayOf("is depended on by")).toBe("blocks");
    expect(wayOf("relates to")).toBeNull();
  });
});

describe("familyBlockOf", () => {
  test("umbrella with progress, siblings in Jira's order, this card marked", () => {
    const m = familyBlockOf({ card: me, parent: { task: umbrella, subtasks: subs } });
    expect(m.umbrella).toMatchObject({ key: "ORBIT-123", progress: { done: 1, total: 4 } });
    expect(m.siblings.map((s) => s.key)).toEqual(["ORBIT-134", "ORBIT-135", "ORBIT-136", "ORBIT-137"]);
    expect(m.siblings.filter((s) => s.current).map((s) => s.key)).toEqual(["ORBIT-135"]);
  });
  test("before the umbrella is read: its stub, no progress, no siblings", () => {
    const m = familyBlockOf({ card: me });
    expect(m.umbrella).toMatchObject({ key: "ORBIT-123", title: "RBAC reporting", progress: null });
    expect(m.siblings).toEqual([]);
  });
  test("a card that is not a sub-task has no umbrella", () => {
    expect(familyBlockOf({ card: task("ORBIT-9", "To do", "open", { issueType: "Story" }) }).umbrella).toBeNull();
  });
  test("a blocker from an inward link warns; relates-to is ignored; a done blocker is resolved and does not warn", () => {
    const linked = linksOf([
      { id: "1", type: blocks, inwardIssue: stub("ORBIT-77", "In development", "indeterminate") },
      { id: "2", type: relates, outwardIssue: stub("ORBIT-88", "To do", "new") },
      { id: "3", type: blocks, outwardIssue: stub("ORBIT-90", "To do", "new") },
    ]);
    const m = familyBlockOf({ card: me, linked, parent: { task: umbrella, subtasks: subs } });
    expect(m.deps.map((d) => [d.way, d.key, d.resolved])).toEqual([["blockedBy", "ORBIT-77", false], ["blocks", "ORBIT-90", false]]);
    expect(m.warning).toBe("Blocked by ORBIT-77 (In development) - don't merge alone");
    const done = familyBlockOf({ card: me, linked: linksOf([{ id: "1", type: blocks, inwardIssue: stub("ORBIT-77", "Done", "done") }]) });
    expect(done.deps[0]!.resolved).toBe(true);
    expect(done.warning).toBeNull();
  });
  test("two unresolved blockers say so; a resolved one does not count", () => {
    const two = familyBlockOf({ card: me, linked: linksOf([
      { id: "1", type: blocks, inwardIssue: stub("ORBIT-77", "Code review", "indeterminate") },
      { id: "2", type: blocks, inwardIssue: stub("ORBIT-78", "To do", "new") },
      { id: "3", type: blocks, inwardIssue: stub("ORBIT-79", "Done", "done") },
    ]) });
    expect(two.warning).toBe("Blocked by ORBIT-77 and 1 more - don't merge alone");
    const one = familyBlockOf({ card: me, linked: linksOf([
      { id: "1", type: blocks, inwardIssue: stub("ORBIT-77", "Code review", "indeterminate") },
      { id: "3", type: blocks, inwardIssue: stub("ORBIT-79", "Done", "done") },
    ]) });
    expect(one.warning).toBe("Blocked by ORBIT-77 (Code review) - don't merge alone");
  });
  test("the umbrella's own links count, and say so", () => {
    const m = familyBlockOf({ card: me, parent: { task: umbrella, subtasks: subs, linked: linksOf([{ id: "9", type: blocks, inwardIssue: stub("ORBIT-50", "To do", "new") }]) } });
    expect(m.deps[0]).toMatchObject({ key: "ORBIT-50", from: "umbrella", way: "blockedBy" });
    expect(m.warning).toContain("ORBIT-50");
  });
  test("a key in the text resolves only against fetched cards; otherwise it is only mentioned", () => {
    const m = familyBlockOf({ card: me, description: "Depends on ORBIT-136 and also blocked by ORBIT-999.", parent: { task: umbrella, subtasks: subs } });
    expect(m.deps.map((d) => [d.key, d.via])).toEqual([["ORBIT-136", "text"]]);
    expect(m.mentioned).toEqual(["ORBIT-999"]);
    expect(m.warning).toBeNull(); // only a Jira link raises the alarm
  });
  test("hint counts the open siblings (not this card, not done ones); alert only with a real blocker", () => {
    const quiet = familyBlockOf({ card: me, parent: { task: umbrella, subtasks: subs } });
    expect(quiet.hint).toEqual({ text: "Part of ORBIT-123: 2 sibling cards still open", alert: false });
    const loud = familyBlockOf({ card: me, linked: linksOf([{ id: "1", type: blocks, inwardIssue: stub("ORBIT-77", "To do", "new") }]), parent: { task: umbrella, subtasks: subs } });
    expect(loud.hint?.alert).toBe(true);
    expect(familyBlockOf({ card: me, parent: { task: { ...umbrella, statusKind: "done" }, subtasks: subs } }).hint).toBeNull();
  });
});

describe("Dependencies and Related", () => {
  const dup = { name: "Duplicate", inward: "is duplicated by", outward: "duplicates" };
  const linked = linksOf([
    { id: "1", type: blocks, inwardIssue: stub("ORBIT-882", "In development", "indeterminate") },
    { id: "2", type: relates, inwardIssue: stub("ORBIT-882", "In development", "indeterminate") },
    { id: "3", type: relates, outwardIssue: stub("ORBIT-90", "Done", "done") },
    { id: "4", type: dup, outwardIssue: stub("ORBIT-91", "To do", "new") },
    { id: "5", type: dup, inwardIssue: stub("ORBIT-92", "To do", "new") },
    { id: "6", type: blocks, outwardIssue: stub("ORBIT-93", "To do", "new") },
  ]);
  test("blocking links go to Dependencies, every other type to Related under the site's own phrase, in site order", () => {
    const m = familyBlockOf({ card: task("ORBIT-9", "To do", "open", { issueType: "Story" }), linked });
    expect(m.deps.map((d) => [d.way, d.key])).toEqual([["blockedBy", "ORBIT-882"], ["blocks", "ORBIT-93"]]);
    expect(m.related.map((g) => [g.phrase, g.rows.map((r) => r.key)])).toEqual([
      ["relates to", ["ORBIT-882", "ORBIT-90"]], ["duplicates", ["ORBIT-91"]], ["is duplicated by", ["ORBIT-92"]],
    ]);
    expect(m.related[0]!.rows[1]!.resolved).toBe(true);
  });
  test("a card linked under two types shows under each", () => {
    const m = familyBlockOf({ card: me, linked });
    expect(m.deps.some((d) => d.key === "ORBIT-882")).toBe(true);
    expect(m.related.find((g) => g.phrase === "relates to")!.rows.some((r) => r.key === "ORBIT-882")).toBe(true);
  });
  test("a block with nothing in it is not drawn; family is parent and siblings only", () => {
    const plain = familyBlockOf({ card: task("ORBIT-9", "To do", "open", { issueType: "Story" }) });
    expect([hasFamily(plain), hasDependencies(plain), hasRelated(plain)]).toEqual([false, false, false]);
    const rel = familyBlockOf({ card: task("ORBIT-9", "To do", "open", { issueType: "Story" }), linked: linksOf([{ id: "3", type: relates, outwardIssue: stub("ORBIT-90", "To do", "new") }]) });
    expect([hasFamily(rel), hasDependencies(rel), hasRelated(rel)]).toEqual([false, false, true]);
    expect(rel.warning).toBeNull();
  });
  test("the server keeps every link with the type's own wording for this card's side", () => {
    expect(linked.map((l) => [l.phrase, l.type, l.direction])).toEqual([
      ["is blocked by", "Blocks", "in"], ["relates to", "Relates", "in"], ["relates to", "Relates", "out"],
      ["duplicates", "Duplicate", "out"], ["is duplicated by", "Duplicate", "in"], ["blocks", "Blocks", "out"],
    ]);
  });
});

describe("mentionedKeys, siblingStep, familyOpen", () => {
  test("keys are unique, upper-cased, and never the card itself", () => {
    expect(mentionedKeys("after orbit-5. Waiting on ORBIT-5 and depends on ORBIT-135", "ORBIT-135")).toEqual(["ORBIT-5"]);
  });
  test("steps go to the previous/next sibling and stop at the ends", () => {
    const { siblings } = familyBlockOf({ card: me, parent: { task: umbrella, subtasks: subs } });
    expect(siblingStep(siblings, -1)).toBe("ORBIT-134");
    expect(siblingStep(siblings, 1)).toBe("ORBIT-136");
    const first = familyBlockOf({ card: subs[0]!, parent: { task: umbrella, subtasks: subs } }).siblings;
    expect(siblingStep(first, -1)).toBeNull();
  });
  test("open by default only with a blocker; the person's choice wins", () => {
    const calm = familyBlockOf({ card: me, parent: { task: umbrella, subtasks: subs } });
    const hot = familyBlockOf({ card: me, linked: linksOf([{ id: "1", type: blocks, inwardIssue: stub("ORBIT-77", "To do", "new") }]) });
    expect(familyOpen(null, calm)).toBe(false);
    expect(familyOpen(null, hot)).toBe(true);
    expect(familyOpen("compact", hot)).toBe(false);
    expect(familyOpen("open", calm)).toBe(true);
  });
});

describe("sources", () => {
  const src = (p: string) => Bun.file(import.meta.dir + "/../src/" + p).text();
  test("the block sits under the title in the card, the shortcut avoids the bare brackets, storage is guarded, the skin leaves it alone", async () => {
    expect(await src("components/jira/JiraCard.tsx")).toMatch(/<DetailHeader[\s\S]*<FamilyBlock[\s\S]*<DockTabs/);
    const block = await src("components/jira/detail/FamilyBlock.tsx");
    expect(block).toContain("e.altKey");
    expect(block).toMatch(/try \{ return localStorage/);
    expect(block).not.toContain("title=");
    expect(await src("jiraMock.css")).not.toMatch(/agx-fam/);
  });
  test("the three blocks carry sentence-case labels and the Dependencies block holds the warning chip", async () => {
    const block = await src("components/jira/detail/FamilyBlock.tsx");
    for (const label of ['aria-label="Family"', 'aria-label="Dependencies"', 'aria-label="Related"', "<span>Family</span>", ">Dependencies<", ">Related<"]) expect(block).toContain(label);
    expect(block).toMatch(/aria-label="Dependencies"[\s\S]*m\.warning[\s\S]*aria-label="Related"/);
  });
  test("the pull request panel shows the same warning", async () => {
    expect(await src("components/PrPanel.tsx")).toContain("<BlockerWarning cardKey={query} />");
  });
});

// The block sits right under the header's action row; with no top margin its
// border touched the buttons. Asserted against the stylesheet it ships.
test("the Family block keeps a gap under the header's action row", async () => {
  const { FAMILY_CSS } = await import("../src/components/jira/detail/FamilyBlock.tsx");
  const root = FAMILY_CSS.match(/\.agx-fam\{[^}]*\}/);
  expect(root).not.toBeNull();
  const margin = root![0].match(/margin:(\d+)px/);
  expect(margin).not.toBeNull();
  expect(Number(margin![1])).toBeGreaterThanOrEqual(8);
});

describe("Family for a card that has sub-tasks", () => {
  const parent = task("ORBIT-1780", "In progress", "open", { issueType: "Task" });
  test("a parent with one sub-task shows Family with that child", () => {
    const m = familyBlockOf({ card: parent, subtasks: [task("ORBIT-1853", "To do", "open")] });
    expect(hasFamily(m)).toBe(true);
    expect(m.children.map((c) => c.key)).toEqual(["ORBIT-1853"]);
  });
  test("a card with neither parent nor sub-tasks shows no Family", () => {
    expect(hasFamily(familyBlockOf({ card: parent, subtasks: [] }))).toBe(false);
    expect(hasFamily(familyBlockOf({ card: parent }))).toBe(false);
  });
});

test("Work tab hides an empty Workers section instead of a bare heading", async () => {
  const src = await Bun.file(new URL("../src/components/jira/detail/WorkTab.tsx", import.meta.url)).text();
  expect(src).toContain("sessions.length > 0 && <JiraSection id=\"sessions\"");
});

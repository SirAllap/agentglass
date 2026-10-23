/*
 * The merge form's card row for a Jira card.
 *
 * What a mistake costs: a merge form that offers to move a card it could not
 * read, a move offered while writing is switched off, a request per keystroke
 * of a list nobody opened, a move that needs a field picked anyway, and the
 * merge form for a ClickUp card changed in passing. Requests are counted at
 * `fetch`; the wiring that cannot run without a renderer is asserted against
 * the source, the way the house does.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

let mod: typeof import("../src/lib/mergeJira.ts");
let sent: string[] = [];
let answers: Record<string, () => Response> = {};

beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    sent.push(u.pathname);
    const a = answers[u.pathname];
    if (!a) throw new TypeError("no network");
    return a();
  });
  mod = await import("../src/lib/mergeJira.ts");
});
beforeEach(() => { sent = []; answers = {}; });

const json = (body: unknown) => () => Response.json(body);
const ref = { label: "ORBIT-1042", query: "orbit-1042" };
const task = { id: "20042", customId: "ORBIT-1042", title: "Fix timeout", status: "In Progress", statusColor: "#ffab00", updated: 1768294800000 };
const move = (id: string, label: string, extra: object = {}) => ({ id, name: `move ${id}`, label, toStatus: label, toKind: "open", ...extra });
const status = (writes: boolean) => json({ connected: true, site: "acme.atlassian.net", writes, prefixes: ["ORBIT"] });

describe("looking the card up", () => {
  test("writes on: the card, the switch and the moves, three reads and no write", async () => {
    answers["/jira/find"] = json({ ok: true, task, asked: "ORBIT-1042" });
    answers["/jira/status"] = status(true);
    answers["/jira/transitions"] = json({ ok: true, options: [move("21", "In Review"), move("41", "Done", { toKind: "done", needs: ["resolution"] })] });
    const r = await mod.lookUpJiraCard(ref);
    expect(r.ok).toBe(true);
    expect(r.ok && r.card).toMatchObject({ key: "ORBIT-1042", label: "ORBIT-1042", query: "orbit-1042", status: "In Progress", updated: 1768294800000, writes: true });
    expect(r.ok && r.card.options.map((o) => [o.key, o.label, o.needs])).toEqual([["21", "In Review", undefined], ["41", "Done", ["resolution"]]]);
    expect([...sent].sort()).toEqual(["/jira/find", "/jira/status", "/jira/transitions"]);
  });

  test("writes off: the moves are never asked for", async () => {
    answers["/jira/find"] = json({ ok: true, task });
    answers["/jira/status"] = status(false);
    const r = await mod.lookUpJiraCard(ref);
    expect(r.ok && r.card).toMatchObject({ writes: false, options: [] });
    expect(sent).not.toContain("/jira/transitions");
  });

  test("a status answer with no switch in it is writes off, not on", async () => {
    answers["/jira/find"] = json({ ok: true, task });
    answers["/jira/status"] = json({ connected: true });
    const r = await mod.lookUpJiraCard(ref);
    expect(r.ok && r.card.writes).toBe(false);
    expect(sent).not.toContain("/jira/transitions");
  });

  test("a card that cannot be moved says so, and the merge is not blocked", async () => {
    answers["/jira/find"] = json({ ok: true, task });
    answers["/jira/status"] = status(true);
    answers["/jira/transitions"] = json({ ok: true, options: [], cannot: "You cannot move ORBIT-1042" });
    const r = await mod.lookUpJiraCard(ref);
    expect(r.ok && r.card).toMatchObject({ options: [], cannot: "You cannot move ORBIT-1042" });
  });

  test("a card that is not found is a reason, not a crash", async () => {
    answers["/jira/find"] = json({ ok: false, error: "ORBIT-1042 was not found or you cannot see it" });
    answers["/jira/status"] = status(true);
    expect(await mod.lookUpJiraCard(ref)).toEqual({ ok: false, why: "ORBIT-1042 was not found or you cannot see it" });
    answers = {};
    expect(await mod.lookUpJiraCard(ref)).toEqual({ ok: false, why: "Jira could not find it" });
  });
});

describe("the answer", () => {
  const card = {
    key: "ORBIT-1042", label: "ORBIT-1042", query: "orbit-1042", title: "Fix timeout", status: "In Progress", updated: 5, writes: true,
    options: [
      { key: "21", label: "In Review", toStatus: "In Review", toKind: "open" as const },
      { key: "41", label: "Done", toStatus: "Done", toKind: "done" as const, needs: ["resolution"] },
    ],
  };
  test("leaving it there sends no card at all", () => {
    expect(mod.jiraMergeMove(card, "")).toBeUndefined();
  });
  test("a pick is the move's id, the stamp, and the site's own word for where it goes", () => {
    expect(mod.jiraMergeMove(card, "21")).toEqual({ id: "ORBIT-1042", label: "ORBIT-1042", to: "21", toLabel: "In Review", updated: 5, tracker: "jira", query: "orbit-1042" });
  });
  test("a move that needs a field is never an answer, and neither is one that is not offered", () => {
    expect(mod.jiraMergeMove(card, "41")).toBeUndefined();
    expect(mod.jiraMergeMove(card, "99")).toBeUndefined();
  });
});

describe("wiring that needs a renderer, asserted against the source", () => {
  const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

  test("the merge dialog reads a Jira card in its own row and never runs ClickUp's lookup for it", async () => {
    const dialog = code(await read("components/MergeDialog.tsx"));
    expect(dialog).toContain('ref.tracker === "jira" || !mergeOn');
    expect(dialog).toContain("<MergeJiraCard");
    expect(dialog).toContain("jiraMergeMove(jira.card, jira.pick)");
  });

  test("the merge sends a Jira card through the move, with the stamp, and ClickUp's two calls are still there", async () => {
    const panel = await read("components/PrPanel.tsx");
    const run = panel.slice(panel.indexOf("const runMerge = async"), panel.indexOf("const doAutoMerge"));
    expect(run).toContain('move.tracker === "jira" ? api.jiraTransition(move.id, move.to, move.updated)');
    expect(run).toContain("move.write ? api.clickupCard(move.id, move.write, move.updated) : api.clickupStatus(move.id, move.to, move.updated)");
    expect(run).toContain('move.tracker === "jira" ? move.query');
  });

  test("a disabled row of a list is read and not chosen", async () => {
    const select = code(await read("components/Select.tsx"));
    expect(select).toContain("options.find((o) => o.value === v)?.disabled");
  });

  test("the sentence for a refused token names the tracker that refused it", async () => {
    const { mergeNote } = await import("../src/lib/cardMove.ts");
    expect(mergeNote(true, { asked: true, ok: false, unauthorised: true, tracker: "Jira" })).toBe("Merged — the card did not move: Jira refused this token. Reconnect it in Settings.");
    expect(mergeNote(true, { asked: true, ok: false, unauthorised: true })).toBe("Merged — the card did not move: ClickUp refused this token. Reconnect it in Settings.");
    expect(mergeNote(true, { asked: true, ok: true, to: "In Review", tracker: "Jira" })).toBe("Merged · card moved to In Review");
  });

  test("the Jira picker lists what the tracker offers, and the Select never sees a move it cannot make", async () => {
    const pick = code(await read("components/TrackerStatusPick.tsx"));
    expect(pick).toContain("tracker.statusOptions(task)");
    expect(pick).toContain("tracker.setStatus(task, opt)");
    expect(pick).toContain("opt.needs?.length");
    expect(pick).toContain("putCard(query, r.task)");
  });
});

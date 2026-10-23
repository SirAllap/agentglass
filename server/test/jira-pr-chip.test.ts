/*
 * THE JIRA CARD ON A PULL REQUEST ROW, FOR A KEY NO BOARD HOLDS.
 *
 * The list draws a card from caches alone, so a pull request naming a key that
 * sits on none of the saved boards had no chip row while the same pull request
 * against ClickUp had one. `resolveJiraCards` asks once per list read for the
 * keys nothing holds. What is pinned here is the cost (one search for a page,
 * none for what is already held), that a failed search draws nothing less than
 * before, and that the card panel and the list share what each read.
 *
 * The search is a seam; no network is touched and every file is under a
 * private temp dir.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTask, SavedView } from "../../shared/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-pr-chip-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const V = await import("../src/jiraviews.ts");
const R = await import("../src/jiraprcards.ts");
const { cardFor } = await import("../src/prs.ts");

const SITE = "acme.atlassian.net";
const view: SavedView = { id: "board:12", name: "Orbit board", url: "", addedAt: 0 };
const task = (key: string, extra: Partial<ProviderTask> = {}): ProviderTask => ({
  id: String(10000 + Number(key.split("-")[1])), customId: key, title: "Retry the export", url: `https://${SITE}/browse/${key}`,
  status: "In Review", statusKind: "open", priority: "high", due: null, updated: 1, tags: [], list: "Orbit", listId: key.split("-")[0],
  assignees: ["Ada Example"], people: [{ key: "u1", name: "Ada Example", initials: "AE" }], mine: false, ...extra,
}) as ProviderTask;

const connect = () => C.setCredential("jira", { token: "t0k", email: "ada@example.com", site: SITE, auth: "basic", account: "Ada Example" });
/** The rows of a list page, as the second GitHub pass hands them over. */
const rows = (...titles: string[]) => titles.map((title, i) => ({ number: i + 1, headRefName: `branch-${i}`, title }));

let asked: string[] = [];
let listed = 0;
let answer: (jql: string) => ReturnType<Parameters<typeof R.__setReader>[0] & {}> = async () => ({ ok: true, data: { tasks: [], truncated: false } });
const knows = (...ts: ProviderTask[]) => { answer = async () => ({ ok: true, data: { tasks: ts, truncated: false } }); };

beforeEach(() => {
  C.__clearAll();
  C.__setCredentialsPath(join(dir, "creds.json"));
  V.__setJiraViewsPath(join(dir, "jira-views.json"));
  V.__clear();
  V.addView(SITE, view);
  R.__clearPrCards();
  asked = []; listed = 0;
  R.__setLister(async () => { listed++; return { ok: true, data: { keys: ["ORBIT", "ACME"] } }; });
  answer = async () => ({ ok: true, data: { tasks: [], truncated: false } });
  R.__setReader(async (_c, jql) => { asked.push(jql); return answer(jql); });
});

afterAll(() => {
  R.__setReader(null);
  R.__setLister(null);
  C.__clearAll();
  C.__setCredentialsPath(null);
  V.__setJiraViewsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

/** A board that names the project, so the key is read without asking the site which projects exist. */
const boardKnowsOrbit = () => V.putCache(SITE, view.id, { view, tasks: [task("ORBIT-1")], columns: [], at: 1 });

describe("a page of pull requests naming Jira keys", () => {
  it("costs exactly one search for three rows naming two keys", async () => {
    connect(); boardKnowsOrbit();
    knows(task("ORBIT-1042"), task("ORBIT-7"));
    await R.resolveJiraCards(rows("ORBIT-1042: retry", "ORBIT-1042: second part", "ORBIT-7 fix the export"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe("key in (ORBIT-1042, ORBIT-7)");
    expect(cardFor("", "ORBIT-1042: retry")).toMatchObject({ customId: "ORBIT-1042", status: "In Review", tracker: "jira" });
    expect(cardFor("", "ORBIT-7 fix the export")?.people?.[0]?.name).toBe("Ada Example");
  });

  it("costs nothing for a key read a moment ago, found or not", async () => {
    connect(); boardKnowsOrbit();
    knows(task("ORBIT-1042"));
    await R.resolveJiraCards(rows("ORBIT-1042: retry", "ORBIT-9999: nobody has this"));
    await R.resolveJiraCards(rows("ORBIT-1042: retry", "ORBIT-9999: nobody has this"));
    expect(asked).toHaveLength(1);
  });

  it("costs nothing for a key a saved board read just now", async () => {
    connect();
    V.putCache(SITE, view.id, { view, tasks: [task("ORBIT-1042")], columns: [], at: Date.now() });
    await R.resolveJiraCards(rows("ORBIT-1042: retry"));
    expect(asked).toHaveLength(0);
    expect(cardFor("", "ORBIT-1042: retry")?.customId).toBe("ORBIT-1042");
  });

  it("asks for at most fifty keys in the one search", async () => {
    connect(); boardKnowsOrbit();
    await R.resolveJiraCards(rows(...Array.from({ length: 60 }, (_, i) => `ORBIT-${100 + i}: thing`)));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.split(",")).toHaveLength(R.BATCH_MAX);
  });

  it("keeps the chips it had when the search fails, and does not ask again at once", async () => {
    connect(); boardKnowsOrbit();
    knows(task("ORBIT-1042"));
    await R.resolveJiraCards(rows("ORBIT-1042: retry"));
    // The card is older than the re-ask window, then Jira stops answering.
    R.holdCard(SITE, task("ORBIT-1042"), Date.now() - 6 * 60_000);
    answer = async () => ({ ok: false, error: "Jira answered 503", status: 503 });
    await R.resolveJiraCards(rows("ORBIT-1042: retry", "ORBIT-8: new"));
    expect(cardFor("", "ORBIT-1042: retry")).toMatchObject({ customId: "ORBIT-1042", status: "In Review" });
    const after = asked.length;
    await R.resolveJiraCards(rows("ORBIT-1042: retry", "ORBIT-8: new"));
    expect(asked.length).toBe(after);
  });

  it("asks the site for its projects once when a key-shaped word is on no cached card, and reads the key against them", async () => {
    connect();
    knows(task("ACME-5"));
    await R.resolveJiraCards(rows("ACME-5: add the thing"));
    await R.resolveJiraCards(rows("ACME-5: add the thing", "ORBIT-6: other"));
    expect(listed).toBe(1);
    expect(cardFor("", "ACME-5: add the thing")?.customId).toBe("ACME-5");
  });

  it("does not take a word that only looks like a key for a card", async () => {
    connect();
    await R.resolveJiraCards(rows("utf-8 handling", "release/v2-1409"));
    expect(asked).toHaveLength(0);
  });

  it("draws nothing extra for a pull request that names no key, and nothing without a connection", async () => {
    boardKnowsOrbit();
    await R.resolveJiraCards(rows("ORBIT-1042: retry"));
    expect(asked).toHaveLength(0);
    connect();
    await R.resolveJiraCards(rows("Update the readme"));
    expect(asked).toHaveLength(0);
    expect(cardFor("", "Update the readme")).toBeUndefined();
  });
});

describe("one fact, two views", () => {
  it("a card the panel read is drawn by the list without a search", async () => {
    connect(); boardKnowsOrbit();
    R.holdCard(SITE, task("ORBIT-1042", { status: "Done" }));
    await R.resolveJiraCards(rows("ORBIT-1042: retry"));
    expect(asked).toHaveLength(0);
    expect(cardFor("", "ORBIT-1042: retry")?.status).toBe("Done");
  });

  it("the freshest of the board and the resolved card wins", () => {
    connect();
    V.putCache(SITE, view.id, { view, tasks: [task("ORBIT-1042", { status: "To Do" })], columns: [], at: Date.now() - 3_600_000 });
    R.holdCard(SITE, task("ORBIT-1042", { status: "In Review" }));
    expect(cardFor("", "ORBIT-1042: retry")?.status).toBe("In Review");
  });

  it("an older reading never replaces a newer one", () => {
    R.holdCard(SITE, task("ORBIT-1042", { status: "Done" }));
    R.holdCard(SITE, task("ORBIT-1042", { status: "To Do" }), Date.now() - 60_000);
    expect(R.heldCard(SITE, "ORBIT-1042")?.task.status).toBe("Done");
  });
});

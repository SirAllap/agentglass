/*
 * The Jira bell: what it says, what it must not say twice, and what one look
 * costs.
 *
 * The diff is driven with a stand-in reader (it is the thing worth testing, and
 * a site would only make it slow). The request counts and the query as sent are
 * asserted against the stand-in site, for Cloud and for a self-hosted one,
 * because "one request a tick" is a claim about the wire and not about a
 * function. Each case names the mistake it would catch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";
import { startJiraProxy, type JiraProxy } from "./fixtures/jiraTextProxy.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-watch-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_WRITE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const W = await import("../src/jirawatch.ts");
type Task = import("../../shared/providers.ts").ProviderTask;

const credFile = join(dir, "creds.json");
const watchFile = join(dir, "jira-watch.json");
const MIN = 60_000;
const T0 = Date.parse("2026-10-10T12:00:00.000Z");

/** The few fields the watch reads; the rest of a card is not its business. */
const card = (id: string, status: string, updated: number, o: Partial<Task> = {}): Task => ({
  id, customId: `ORBIT-${id}`, title: `Card ${id}`, url: `https://acme.atlassian.net/browse/ORBIT-${id}`,
  status, statusKind: "open", priority: null, due: null, updated, tags: [], list: "Orbit", assignees: [], ...o,
} as Task);

type Answer = Awaited<ReturnType<import("../src/jirawatch.ts").JiraReader>>;
type CommentAnswer = Awaited<ReturnType<import("../src/jirawatch.ts").JiraCommentReader>>;
let queue: Answer[] = [];
let asked: string[] = [];
/** Comments by card key, and every key whose comments were read in one poll. */
let threads: Record<string, CommentAnswer["data"]> = {};
let opened: string[] = [];
/** Answers to the follow look, which is asked once per poll after the first. */
let follow: Answer[] = [];
const say = (tasks: Task[], truncated = false): Answer => ({ ok: true, data: { tasks, truncated } });

beforeEach(() => {
  W.__setJiraWatchPath(watchFile);
  rmSync(watchFile, { force: true });
  W.__resetJiraTrouble();
  W.__setJiraMe(["acc-0001"]);
  queue = []; asked = []; threads = {}; opened = []; follow = [];
  W.__setJiraReader(async (jql) => {
    asked.push(jql);
    // The follow look is answered empty unless a test queues one for it.
    if (jql.startsWith("(reporter")) return follow.shift() ?? say([]);
    return queue.shift() ?? say([]);
  });
  W.__setJiraCommentReader(async (key) => {
    opened.push(key);
    return { ok: true, data: threads[key] ?? { comments: [] } };
  });
});
afterEach(() => { W.__setJiraMover(null); W.__setJiraReader(null); W.__setJiraCommentReader(null); W.__setJiraMe(null); });
afterAll(() => {
  W.__setJiraWatchPath(null);
  W.__setJiraReader(null);
  W.__setJiraCommentReader(null);
  W.__setJiraMe(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("what is said", () => {
  test("the first look is silent, and reads the whole open set once", async () => {
    queue = [say([card("1", "To Do", T0 - 5 * MIN), card("2", "In Progress", T0 - 9 * MIN)])];
    expect(await W.pollJira(T0)).toEqual([]);
    expect(asked).toEqual([J.MINE_JQL]);
    expect(JSON.parse(readFileSync(watchFile, "utf8")).at).toBe(T0);
  });

  test("a quiet card that moves later is a move, not an assignment", async () => {
    queue = [say([card("1", "To Do", T0 - 3 * 24 * 60 * MIN)]), say([card("1", "In Progress", T0 + 2 * MIN)])];
    await W.pollJira(T0);
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes.map((n) => [n.kind, n.label, n.status, n.was])).toEqual([["status", "ORBIT-1", "In Progress", "To Do"]]);
  });

  test("a new card is announced once, and the minute that is read twice does not repeat it", async () => {
    queue = [say([]), say([card("3", "To Do", T0 + 1 * MIN)]), say([card("3", "To Do", T0 + 1 * MIN)])];
    await W.pollJira(T0);
    const first = await W.pollJira(T0 + 6 * MIN);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "assigned", tracker: "jira", id: "ORBIT-3", label: "ORBIT-3", status: "To Do", url: "https://acme.atlassian.net/browse/ORBIT-3" });
    expect(await W.pollJira(T0 + 12 * MIN)).toEqual([]);
  });

  test("a card that arrives already finished is not an assignment", async () => {
    queue = [say([]), say([card("4", "Done", T0 + MIN, { statusKind: "done" })])];
    await W.pollJira(T0);
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
  });

  test("an answer older than one already seen is a lagging index, not a move back", async () => {
    queue = [say([card("5", "In Progress", T0 + MIN)]), say([card("5", "To Do", T0 - MIN)])];
    await W.pollJira(T0);
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
    expect(JSON.parse(readFileSync(watchFile, "utf8")).seen["5"].status).toBe("In Progress");
  });

  test("more than eight in one look is eight, the newest", async () => {
    const many = Array.from({ length: 12 }, (_, i) => card(String(100 + i), "To Do", T0 + (i + 1) * 1000));
    queue = [say([]), say(many)];
    await W.pollJira(T0);
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes).toHaveLength(8);
    expect(notes.map((n) => n.id)).toEqual(many.slice(4).map((t) => t.customId!));
  });
});

describe("who moved a card", () => {
  const moveTwice = async (): Promise<Awaited<ReturnType<typeof W.pollJira>>> => {
    queue = [say([card("1", "To Do", T0 - 3 * 24 * 60 * MIN)]), say([card("1", "In Progress", T0 + 2 * MIN)])];
    await W.pollJira(T0);
    return W.pollJira(T0 + 6 * MIN);
  };

  test("someone else's move names them and is not mine", async () => {
    const asked2: string[] = [];
    W.__setJiraMover(async (key, to) => { asked2.push(`${key}>${to}`); return { who: "Grace", whoId: "acc-0002" }; });
    const notes = await moveTwice();
    expect(notes.map((n) => [n.kind, n.who, n.byMe])).toEqual([["status", "Grace", false]]);
    expect(asked2).toEqual(["ORBIT-1>In Progress"]);
  });

  test("my own move says so, and an unreadable changelog claims nothing", async () => {
    W.__setJiraMover(async () => ({ who: "Ada", whoId: "ACC-0001" }));
    expect((await moveTwice()).map((n) => n.byMe)).toEqual([true]);
    rmSync(watchFile, { force: true }); W.__setJiraWatchPath(watchFile);
    W.__setJiraMover(async () => null);
    const n = (await moveTwice())[0]!;
    expect(n.who).toBeUndefined();
    expect(n.byMe).toBeUndefined();
  });
});

describe("who moved a card: the changelog", () => {
  const ev = (to: string, whoId: string): any => ({ who: whoId, whoId, edit: { field: "status", toString: to } });
  /** A 10-per-page changelog of `n` events, oldest first; `at(i)` makes event i. */
  const pages = (n: number, at: (i: number) => any, log: number[]) => async (_k: string, from: number): Promise<any> => {
    log.push(from);
    const events = Array.from({ length: Math.min(10, n - from) }, (_, j) => at(from + j));
    return { ok: true, data: { events, total: n, ...(from + 10 < n ? { next: from + 10 } : {}) } };
  };
  afterEach(() => W.__setJiraHistory(null));
  const moveTwice = async (): Promise<Awaited<ReturnType<typeof W.pollJira>>> => {
    queue = [say([card("1", "To Do", T0 - 3 * 24 * 60 * MIN)]), say([card("1", "In Progress", T0 + 2 * MIN)])];
    await W.pollJira(T0);
    return W.pollJira(T0 + 6 * MIN);
  };

  test("on a long card the latest move into the status wins, not an older one", async () => {
    const log: number[] = [];
    // Event 3 and event 44 both move into Done; 44 is the latest.
    W.__setJiraHistory(pages(45, (i) => (i === 3 ? ev("Done", "old") : i === 44 ? ev("Done", "new") : ev("x", "z")), log));
    expect(await W.latestMover("ORBIT-1", "Done")).toEqual({ who: "new", whoId: "new" });
    expect(log).toEqual([0, 40]);
  });

  test("reads at most three pages, from the end", async () => {
    const log: number[] = [];
    W.__setJiraHistory(pages(100, () => ev("x", "z"), log));
    expect(await W.latestMover("ORBIT-1", "Done")).toBeNull();
    expect(log).toEqual([0, 90, 80]);
  });

  test("a short card is one request", async () => {
    const log: number[] = [];
    W.__setJiraHistory(pages(4, (i) => (i === 2 ? ev("Done", "acc") : ev("x", "z")), log));
    expect((await W.latestMover("ORBIT-1", "Done"))?.whoId).toBe("acc");
    expect(log).toEqual([0]);
  });

  test("with no account id of mine, a move is never called not-mine", async () => {
    W.__setJiraMe([]);
    W.__setJiraMover(async () => ({ who: "Ada", whoId: "ACC-0001" }));
    const n = (await moveTwice())[0]!;
    expect(n.who).toBe("Ada");
    expect(n.byMe).toBeUndefined();
  });

  test("one poll asks the changelog of four cards, no more", async () => {
    let calls = 0;
    W.__setJiraMover(async () => { calls++; return { who: "G", whoId: "acc-2" }; });
    const was = Array.from({ length: 6 }, (_, i) => card(String(200 + i), "To Do", T0 - 3 * 24 * 60 * MIN));
    const now = Array.from({ length: 6 }, (_, i) => card(String(200 + i), "In Progress", T0 + (i + 1) * 1000));
    queue = [say(was), say(now)];
    await W.pollJira(T0);
    expect(await W.pollJira(T0 + 6 * MIN)).toHaveLength(6);
    expect(calls).toBe(4);
  });
});

describe("a card this app gave to somebody", () => {
  test("given to me: not announced as assigned", async () => {
    queue = [say([card("8", "To Do", T0)])];
    await W.pollJira(T0);
    W.rememberOwnAssign(card("9", "To Do", T0 + MIN, { mine: true }), T0 + MIN);
    queue = [say([card("9", "To Do", T0 + MIN)])];
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
  });

  test("given away: a lagging answer is skipped, and the card coming back to me later is news", async () => {
    queue = [say([card("7", "In Progress", T0)])];
    await W.pollJira(T0);
    W.rememberOwnAssign(card("7", "In Progress", T0 + MIN, { mine: false }), T0 + MIN);
    queue = [say([card("7", "In Progress", T0)])];
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
    queue = [say([card("7", "In Progress", T0 + 30 * MIN)])];
    expect((await W.pollJira(T0 + 36 * MIN)).map((n) => n.kind)).toEqual(["assigned"]);
  });
});

describe("a card this app moved itself", () => {
  const seed = async () => {
    queue = [say([card("7", "In Progress", T0)])];
    await W.pollJira(T0);
  };

  test("is not announced when the search catches up", async () => {
    await seed();
    W.rememberOwnMove(card("7", "In Progress", T0), "QA", T0 + MIN);
    queue = [say([card("7", "QA", T0 + 2 * MIN)])];
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
  });

  test("is not announced as moving BACK when the search still shows the old status", async () => {
    await seed();
    W.rememberOwnMove(card("7", "In Progress", T0), "QA", T0 + MIN);
    queue = [say([card("7", "In Progress", T0 + 2 * MIN)]), say([card("7", "QA", T0 + 3 * MIN)])];
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
    expect(await W.pollJira(T0 + 12 * MIN)).toEqual([]);
  });

  test("does not hide the next real move by somebody else", async () => {
    await seed();
    W.rememberOwnMove(card("7", "In Progress", T0), "QA", T0 + MIN);
    queue = [say([card("7", "In Progress", T0 + 2 * MIN)]), say([card("7", "Done", T0 + 9 * MIN, { statusKind: "done" })])];
    await W.pollJira(T0 + 6 * MIN);
    const notes = await W.pollJira(T0 + 12 * MIN);
    expect(notes.map((n) => [n.status, n.was])).toEqual([["Done", "QA"]]);
  });

  test("once it has caught up, moving the card back to where it was IS news", async () => {
    await seed();
    W.rememberOwnMove(card("7", "In Progress", T0), "QA", T0 + MIN);
    queue = [say([card("7", "QA", T0 + 2 * MIN)]), say([card("7", "In Progress", T0 + 5 * MIN)])];
    await W.pollJira(T0 + 3 * MIN);
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes.map((n) => [n.status, n.was])).toEqual([["In Progress", "QA"]]);
  });

  test("a disconnect forgets it too: the first look after reconnecting records the card", async () => {
    await seed();
    W.rememberOwnMove(card("7", "In Progress", T0), "QA", T0 + MIN);
    W.forgetJiraWatch();
    queue = [say([card("7", "In Progress", T0 + 2 * MIN)]), say([card("7", "In Progress", T0 + 2 * MIN)])];
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
    expect(await W.pollJira(T0 + 12 * MIN)).toEqual([]);
  });

  test("is forgotten after a while: an old status then IS news", async () => {
    await seed();
    W.rememberOwnMove(card("7", "In Progress", T0), "QA", T0 + MIN);
    queue = [say([card("7", "In Progress", T0 + 20 * MIN)])];
    const notes = await W.pollJira(T0 + 30 * MIN);
    expect(notes.map((n) => [n.status, n.was])).toEqual([["In Progress", "QA"]]);
  });
});

describe("failures are said once, and lose nothing", () => {
  const refused = { ok: false, unauthorised: true, error: "Jira refused these credentials." } as Answer;

  test("a revoked token: nothing announced, the mark stays, one warning for many polls, then one 'working again'", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      queue = [say([card("1", "To Do", T0)])];
      await W.pollJira(T0);
      queue = [refused, refused, refused];
      for (let i = 1; i <= 3; i++) expect(await W.pollJira(T0 + i * 6 * MIN)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("Reconnect Jira");
      expect(W.jiraWatchTrouble()).toMatchObject({ unauthorised: true, runs: 3 });
      expect(JSON.parse(readFileSync(watchFile, "utf8")).at).toBe(T0);
      queue = [say([card("1", "In Progress", T0 + 25 * MIN)])];
      const back = await W.pollJira(T0 + 30 * MIN);
      expect(back.map((n) => n.kind)).toEqual(["status"]);
      expect(W.jiraWatchTrouble()).toBeNull();
      expect(log.mock.calls.filter((c) => String(c[0]).includes("working again"))).toHaveLength(1);
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  test("a hold of our own does not turn a refused token into a wait-and-see", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      queue = [say([]), refused, { ok: false, throttled: true, error: "Jira is limiting requests, try again in 10s" } as Answer];
      await W.pollJira(T0);
      await W.pollJira(T0 + 6 * MIN);
      await W.pollJira(T0 + 12 * MIN);
      expect(W.jiraWatchTrouble()).toMatchObject({ unauthorised: true, error: expect.stringContaining("refused") });
    } finally { warn.mockRestore(); }
  });

});

describe("what somebody wrote on a card", () => {
  /** A card comment as the reader hands it back. */
  const note = (id: string, at: number, o: Partial<NonNullable<CommentAnswer["data"]>["comments"][number]> = {}) => ({
    id, who: "Grace Sample", text: `Comment ${id}`, at, initials: "GS", ...o,
  });
  const seed = async () => {
    queue = [say([card("1", "To Do", T0)])];
    await W.pollJira(T0);
  };

  test("a comment on a card of mine is said once, with who wrote it and what they said", async () => {
    await seed();
    queue = [say([card("1", "To Do", T0 + 5 * MIN)])];
    threads = { "ORBIT-1": { comments: [note("c1", T0 + 4 * MIN)] } };
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes.map((n) => [n.kind, n.label, n.who, n.said])).toEqual([["comment", "ORBIT-1", "Grace Sample", "Comment c1"]]);
    expect(notes[0]!.tracker).toBe("jira");
    // The window carries a minute twice, so the same comment comes back: still one note.
    queue = [say([card("1", "To Do", T0 + 11 * MIN)])];
    expect(await W.pollJira(T0 + 12 * MIN)).toEqual([]);
  });

  test("a comment that names me is a mention, not a comment", async () => {
    await seed();
    queue = [say([card("1", "To Do", T0 + 5 * MIN)])];
    threads = { "ORBIT-1": { comments: [note("c2", T0 + 4 * MIN, { mentions: [{ id: "acc-0001", name: "Ada Example" }] })] } };
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes.map((n) => [n.kind, n.said])).toEqual([["mention", "Comment c2"]]);
  });

  test("my own comment is not news", async () => {
    await seed();
    queue = [say([card("1", "To Do", T0 + 5 * MIN)])];
    threads = { "ORBIT-1": { comments: [note("c3", T0 + 4 * MIN, { mine: true, who: "Ada Example" })] } };
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
  });

  test("a comment older than the last look is not announced, however late the read", async () => {
    await seed();
    queue = [say([card("1", "To Do", T0 + 5 * MIN)])];
    threads = { "ORBIT-1": { comments: [note("c4", T0 - MIN)] } };
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
  });

  test("a mention on somebody else's card is news; their plain comment is not", async () => {
    await seed();
    // The follow look finds a card I reported: not mine, so only a comment that names me is worth a note.
    follow = [say([card("2", "In Progress", T0 + 5 * MIN, { mine: false })])];
    threads = { "ORBIT-2": { comments: [note("c5", T0 + 4 * MIN), note("c6", T0 + 4 * MIN, { mentions: [{ id: "acc-0001", name: "Ada Example" }] })] } };
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes.map((n) => [n.kind, n.label])).toEqual([["mention", "ORBIT-2"]]);
  });

  test("the first look reads no comments at all", async () => {
    queue = [say([card("1", "To Do", T0)])];
    threads = { "ORBIT-1": { comments: [note("c7", T0 - MIN)] } };
    await W.pollJira(T0);
    expect(opened).toEqual([]);
    expect(asked).toEqual([J.MINE_JQL]);
  });

  test("a quiet tick reads no comments: the reads follow the cards that changed", async () => {
    await seed();
    queue = [say([])];
    await W.pollJira(T0 + 6 * MIN);
    expect(opened).toEqual([]);
    // And the follow look is asked beside the window, never instead of it.
    expect(asked.slice(1)).toEqual([W.windowJql(T0, T0 + 6 * MIN), W.followJql(T0, T0 + 6 * MIN)]);
  });

  test("a read cut short at twelve cards still reads the rest next time", async () => {
    await seed();
    const many = Array.from({ length: 14 }, (_, i) => card(String(200 + i), "To Do", T0 + (i + 1) * 1000));
    queue = [say(many)];
    await W.pollJira(T0 + 6 * MIN);
    expect(opened).toHaveLength(12);
  });
});

describe("the window", () => {
  test("is relative to the site's clock, with the minute re-read, oldest change first", () => {
    expect(W.windowJql(T0, T0 + 6 * MIN)).toBe("assignee = currentUser() AND updated >= -8m ORDER BY updated ASC");
    expect(W.windowJql(T0, T0 + 1)).toBe("assignee = currentUser() AND updated >= -3m ORDER BY updated ASC");
    expect(W.windowJql(T0, T0 + 3 * 24 * 60 * MIN)).toContain("-4322m");
  });

  test("the follow look asks about the cards I report or watch over the same window", () => {
    expect(W.followJql(T0, T0 + 6 * MIN)).toBe("(reporter = currentUser() OR watcher = currentUser()) AND updated >= -8m ORDER BY updated ASC");
  });

  test("a read cut short advances the mark to the last card read, not past it", async () => {
    queue = [say([]), say([card("1", "To Do", T0 + 1 * MIN), card("2", "To Do", T0 + 2 * MIN)], true)];
    await W.pollJira(T0);
    await W.pollJira(T0 + 60 * MIN);
    expect(JSON.parse(readFileSync(watchFile, "utf8")).at).toBe(T0 + 2 * MIN);
  });

  test("a first look cut short still moves the mark to now: it read the newest, the window is not older changes", async () => {
    queue = [say([card("1", "To Do", T0 - 2 * MIN)], true)];
    await W.pollJira(T0);
    expect(JSON.parse(readFileSync(watchFile, "utf8")).at).toBe(T0);
  });
});

describe("state", () => {
  test("survives a restart: nothing is announced again", async () => {
    queue = [say([card("1", "To Do", T0)])];
    await W.pollJira(T0);
    W.__setJiraWatchPath(watchFile); // drops the in-memory copy, keeps the file
    queue = [say([card("1", "To Do", T0)])];
    expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
    expect(asked[1]).toContain("updated >= -");
  });

  test("a disconnect forgets what it knew", async () => {
    queue = [say([card("1", "To Do", T0)])];
    await W.pollJira(T0);
    expect(existsSync(watchFile)).toBe(true);
    W.forgetJiraWatch();
    expect(existsSync(watchFile)).toBe(false);
  });

  test("the last-seen map is a de-duplicator, not a history", async () => {
    const many = Array.from({ length: 2005 }, (_, i) => card(String(1000 + i), "To Do", T0 + i));
    queue = [say(many)];
    await W.pollJira(T0);
    const seen = JSON.parse(readFileSync(watchFile, "utf8")).seen as Record<string, unknown>;
    expect(Object.keys(seen)).toHaveLength(2000);
    expect(seen["1000"]).toBeUndefined();
    expect(seen["3004"]).toBeDefined();
  });

  test("with nothing connected and no stand-in, nothing is asked", async () => {
    C.__setCredentialsPath(credFile);
    C.__clearAll();
    W.__setJiraReader(null);
    expect(await W.pollJira(T0)).toEqual([]);
    // Not a failure either: there was nothing to ask, so nothing to complain about.
    expect(W.jiraWatchTrouble()).toBeNull();
    expect(existsSync(watchFile)).toBe(false);
    C.__setCredentialsPath(null);
  });
});

// ---------------------------------------------------------------------------
// against a site: the count of requests and the query as sent
// ---------------------------------------------------------------------------

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`one look costs one request (${flavor})`, () => {
    let fake: FakeJira;
    let proxy: JiraProxy;
    beforeAll(() => { fake = startFakeJira({ flavor, pageSize: 50 }); proxy = startJiraProxy(fake.base); });
    afterAll(async () => { await proxy.stop(); await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      proxy.jql.length = 0;
      W.__setJiraReader(null);
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(proxy.base);
      J.__setJiraGuard(null);
      const r = flavor === "cloud"
        ? await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })
        : await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT });
      expect(r.ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); C.__clearAll(); C.__setCredentialsPath(null); });

    const searches = () => fake.requests.filter((r) => /\/search/.test(r.path));
    const reads = () => fake.requests.filter((r) => /\/comment/.test(r.path));

    test("the first look is one search; the next is the window and the follow look, and nothing else on a quiet site", async () => {
      // Nothing here is reported or watched by me, so the follow look is empty and
      // no comment is read: the only requests of a quiet tick are the two searches.
      for (const i of Object.values(fake.state.issues)) i.reporter = "acc-0002";
      expect(await W.pollJira(T0)).toEqual([]);
      expect(fake.requests).toHaveLength(1);
      expect(searches()).toHaveLength(1);
      expect(proxy.jql[0]).toBe(J.MINE_JQL);
      expect(reads()).toHaveLength(0);

      expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
      expect(searches()).toHaveLength(3);
      expect(proxy.jql[1]).toBe("assignee = currentUser() AND updated >= -8m ORDER BY updated ASC");
      expect(proxy.jql[2]).toBe("(reporter = currentUser() OR watcher = currentUser()) AND updated >= -8m ORDER BY updated ASC");
      expect(reads()).toHaveLength(0);
    });

    test("a card that moved on the site is announced once with the status it left", async () => {
      await W.pollJira(T0);
      const issue = fake.state.issues["ORBIT-1042"]!;
      issue.statusId = "4";
      issue.updated = "2026-01-14T09:00:00.000+0000";
      const notes = await W.pollJira(T0 + 6 * MIN);
      expect(notes.map((n) => [n.kind, n.id, n.status, n.was])).toEqual([["status", "ORBIT-1042", "QA", "In Progress"]]);
      expect(await W.pollJira(T0 + 12 * MIN)).toEqual([]);
    });

    test("a held rate limit skips the next look with no request at all", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      await W.pollJira(T0);
      fake.requests.length = 0;
      fake.fail({ path: flavor === "cloud" ? "/search/jql" : "/search", status: 429, retryAfter: 30, times: 1 });
      expect(await W.pollJira(T0 + 6 * MIN)).toEqual([]);
      expect(fake.requests).toHaveLength(1);
      expect(W.jiraWatchTrouble()?.unauthorised).toBeUndefined();
      expect(await W.pollJira(T0 + 7 * MIN)).toEqual([]);
      expect(fake.requests).toHaveLength(1);
      // The mark did not move on either failure.
      expect(JSON.parse(readFileSync(watchFile, "utf8")).at).toBe(T0);
      warn.mockRestore();
    });
  });
}

describe("against a site: a comment that names me", () => {
  let fake: FakeJira;
  let proxy: JiraProxy;
  beforeAll(() => { fake = startFakeJira({ flavor: "cloud", pageSize: 50 }); proxy = startJiraProxy(fake.base); });
  afterAll(async () => { await proxy.stop(); await fake.stop(); });
  beforeEach(async () => {
    fake.reset();
    proxy.jql.length = 0;
    W.__setJiraReader(null);
    W.__setJiraCommentReader(null);
    C.__setCredentialsPath(credFile);
    C.__clearAll();
    J.__setJiraBase(proxy.base);
    J.__setJiraGuard(null);
    expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).ok).toBe(true);
    fake.requests.length = 0;
  });
  afterEach(() => { J.__setJiraBase(null); C.__clearAll(); C.__setCredentialsPath(null); });

  test("a mention on my card is announced with the author and the words, and read once", async () => {
    await W.pollJira(T0);
    const issue = fake.state.issues["ORBIT-1042"]!;
    const at = new Date(T0 + 5 * MIN).toISOString();
    issue.comments.push({
      id: "30200", author: "acc-0002", created: at, updated: at,
      body: { version: 1, type: "doc", content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "acc-0001", text: "@Ada Example" } },
        { type: "text", text: " can you take a look at the retry loop?" },
      ] }] },
    });
    fake.requests.length = 0;
    const notes = await W.pollJira(T0 + 6 * MIN);
    expect(notes.map((n) => [n.kind, n.label, n.who])).toEqual([["mention", "ORBIT-1042", "Grace Sample"]]);
    expect(notes[0]!.said).toContain("can you take a look");
    // The card's comments are read once; the other cards the window returned are theirs.
    expect(fake.requests.filter((r) => r.path === "/issue/ORBIT-1042/comment")).toHaveLength(1);
    expect(await W.pollJira(T0 + 12 * MIN)).toEqual([]);
  });
});

describe("a second page only when the first was full", () => {
  let fake: FakeJira;
  beforeAll(() => { fake = startFakeJira({ pageSize: 2 }); });
  afterAll(async () => { await fake.stop(); });
  test("two cards on a page of two and one more: two searches", async () => {
    W.__setJiraReader(null);
    C.__setCredentialsPath(credFile);
    C.__clearAll();
    J.__setJiraBase(fake.base);
    J.__setJiraGuard(null);
    expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).ok).toBe(true);
    fake.requests.length = 0;
    await W.pollJira(T0);
    expect(fake.requests.filter((r) => r.path === "/search/jql")).toHaveLength(2);
    expect(fake.requests).toHaveLength(2);
    J.__setJiraBase(null); C.__clearAll(); C.__setCredentialsPath(null);
  });
});

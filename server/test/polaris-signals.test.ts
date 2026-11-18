/*
 * The three signals the Signals door adds: a stale card, an overlap between two
 * open pull requests, and a bot's verdict on the head commit. Each is a quiet
 * line on an item that never moves it to another class. Fixtures are invented
 * (acme/orbit, ORBIT-1042).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { recent } from "../src/gitlog.ts";
import { PRESETS, type PolarisItem, type PolarisSettings } from "../../shared/polaris.ts";
import type { SavedView } from "../../shared/providers.ts";
import type { PrSummary } from "../../shared/types.ts";
import { writePolaris } from "../src/config.ts";
import { polarisItems, signalSources, type PolarisIo } from "../src/polaris.ts";
import {
  __resetSignals, __signalStats, botCounts, botLabels, botVerdict, botVerdictLine, CARD_TTL_MS, jiraCardViews, overlapLine, overlapSignals, PAGE_CAP, staleCardOf, trackerCards, withSignals,
  type CardState, type TrackerSource,
} from "../src/polarisSignals.ts";

const ROOT = "/work/acme/orbit";
const NOW = Date.UTC(2026, 9, 20);
const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
const savedHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-signals-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  __resetSignals();
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const item = (over: Partial<PolarisItem> = {}): PolarisItem => ({
  number: 7, title: "Retry the webhook sender", url: "https://example.invalid/7", author: "ada", head: "feat/ORBIT-1042-retry",
  ignored: false, draft: null, proposed: [], dropped: [], headSha: "1".repeat(40), canSync: false, syncDraft: null,
  cls: "Cleared to land", reason: "ready", sentence: "Cleared to land.", ...over,
});
const settings = (over: Partial<PolarisSettings> = {}): PolarisSettings => ({
  version: 1, enabled: true, botReviewers: [], preset: "guided", doors: structuredClone(PRESETS.guided.doors), ...over,
});

describe("a stale card", () => {
  const card = (over: Partial<CardState> = {}): CardState => ({ id: "cu_9", customId: "ORBIT-1042", title: "Retry the webhook sender", status: "In progress", statusKind: "other", updated: NOW - 9 * DAY, ...over });

  test("a card that is not done, named by the branch, untouched for seven days or more, says so", () => {
    expect(staleCardOf(item(), [card()], NOW)).toEqual({ kind: "staleCard", text: "Card ORBIT-1042 has not moved for 9 days." });
    expect(staleCardOf(item(), [card({ updated: NOW - 2 * DAY })], NOW)).toBeNull();
    expect(staleCardOf(item(), [card({ statusKind: "done" })], NOW)).toBeNull();
    expect(staleCardOf(item({ head: "feat/other", title: "Something else" }), [card()], NOW)).toBeNull();
  });

  test("a card the tracker does not call done counts, whether open or a custom bucket", () => {
    expect(staleCardOf(item(), [card({ statusKind: "open" })], NOW)).toEqual({ kind: "staleCard", text: "Card ORBIT-1042 has not moved for 9 days." });
    expect(staleCardOf(item(), [card({ statusKind: "other" })], NOW)).toEqual({ kind: "staleCard", text: "Card ORBIT-1042 has not moved for 9 days." });
  });

  test("when both trackers hold the card, the Jira one is the card the line is about", () => {
    /* A migrated pull request: the ClickUp card kept the old id and Jira has
       the key. The line must be the Jira card's, whether the ClickUp one is
       stale, fresh or done. */
    const clickup = card({ id: "cu_9", customId: "LEGACY-1042", tracker: undefined });
    const jira = card({ id: "10", customId: "ORBIT-1042", status: "In review", tracker: "jira" });
    expect(staleCardOf(item(), [clickup, jira], NOW)).toEqual({ kind: "staleCard", text: "Card ORBIT-1042 has not moved for 9 days." });
    expect(staleCardOf(item(), [card({ customId: "LEGACY-1042", updated: NOW }), jira], NOW)).toEqual({ kind: "staleCard", text: "Card ORBIT-1042 has not moved for 9 days." });
    // A Jira card that moved two days ago is the answer, and no line is right.
    expect(staleCardOf(item(), [clickup, card({ customId: "ORBIT-1042", tracker: "jira", updated: NOW - 2 * DAY })], NOW)).toBeNull();
  });

  test("no tracker configured is no signal, and the line never changes the verdict", () => {
    expect(withSignals([item()], { cards: null })[0]!.signals).toBeUndefined();
    const [said] = withSignals([item()], { cards: [card()] }, NOW);
    expect(said!.signals).toEqual([{ kind: "staleCard", text: "Card ORBIT-1042 has not moved for 9 days." }]);
    expect(said!.cls).toBe("Cleared to land");
    expect(said!.reason).toBe("ready");
    expect(said!.sentence).toBe("Cleared to land.");
  });
});

describe("a pull request overlap", () => {
  test("the line names the other pull request, the shared files and what a merge would do", () => {
    expect(overlapLine(318, ["shared/polaris.ts", "server/src/polaris.ts"], true))
      .toBe("Overlaps #318 in shared/polaris.ts, server/src/polaris.ts. Merging both would conflict.");
    expect(overlapLine(318, ["a.ts"], false)).toBe("Overlaps #318 in a.ts. Merging both is clean.");
    expect(overlapLine(318, ["a", "b", "c", "d"], null)).toBe("Overlaps #318 in a, b, c and 1 more.");
  });

  test("two branches on the same lines conflict; a third on another file is not an overlap", async () => {
    const root = mkdtempSync(join(tmpdir(), "agx-orbit-overlap-"));
    dirs.push(root);
    const run = (...args: string[]) => {
      const r = git(root, args);
      if (r.code !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    run("init", "-q", "-b", "main");
    run("config", "user.email", "orbit@example.invalid");
    run("config", "user.name", "Orbit");
    writeFileSync(join(root, "shared.ts"), "one\ntwo\n");
    writeFileSync(join(root, "other.ts"), "alpha\n");
    run("add", ".");
    run("commit", "-q", "-m", "base");
    run("checkout", "-q", "-b", "pr-a");
    writeFileSync(join(root, "shared.ts"), "one A\ntwo\n");
    run("commit", "-q", "-am", "a");
    run("checkout", "-q", "main");
    run("checkout", "-q", "-b", "pr-b");
    writeFileSync(join(root, "shared.ts"), "one B\ntwo\n");
    run("commit", "-q", "-am", "b");
    run("checkout", "-q", "main");
    run("checkout", "-q", "-b", "pr-c");
    writeFileSync(join(root, "other.ts"), "beta\n");
    run("commit", "-q", "-am", "c");
    run("checkout", "-q", "main");

    const sha = (ref: string) => run("rev-parse", ref);
    const aSha = sha("pr-a");
    const out = await overlapSignals(root, [
      { number: 1, head: "pr-a", base: "main", headSha: aSha },
      { number: 2, head: "pr-b", base: "main", headSha: sha("pr-b") },
      { number: 3, head: "pr-c", base: "main", headSha: sha("pr-c") },
    ]);
    expect(out.get(1)).toEqual(["Overlaps #2 in shared.ts. Merging both would conflict."]);
    expect(out.get(2)).toEqual(["Overlaps #1 in shared.ts. Merging both would conflict."]);
    expect(out.has(3)).toBe(false);

    // The local branch moves on, the head GitHub reported does not: by branch name the overlap is gone, by the commit it stays.
    run("branch", "-f", "pr-a", "main");
    const byName = await overlapSignals(root, [{ number: 1, head: "pr-a", base: "main" }, { number: 2, head: "pr-b", base: "main" }]);
    expect(byName.size).toBe(0);
    const bySha = await overlapSignals(root, [{ number: 1, head: "pr-a", base: "main", headSha: aSha }, { number: 2, head: "pr-b", base: "main", headSha: sha("pr-b") }]);
    expect(bySha.get(1)).toEqual(["Overlaps #2 in shared.ts. Merging both would conflict."]);

    // A full ref name is read as itself, the way rev-parse reads it, not sent back to rev-parse.
    const full = await overlapSignals(root, [{ number: 1, head: "pr-b", base: "refs/heads/main", headSha: sha("pr-b") }, { number: 2, head: "pr-a", base: "refs/heads/main", headSha: aSha }]);
    expect(full.get(1)).toEqual(["Overlaps #2 in shared.ts. Merging both would conflict."]);
  });

  test("the ref and file reads are awaited, not blocking, and one head read twice costs one diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "agx-orbit-overlap-async-"));
    dirs.push(root);
    const run = (...args: string[]) => {
      const r = git(root, args);
      if (r.code !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    run("init", "-q", "-b", "main");
    run("config", "user.email", "orbit@example.invalid");
    run("config", "user.name", "Orbit");
    writeFileSync(join(root, "a.ts"), "one\n");
    writeFileSync(join(root, "b.ts"), "alpha\n");
    run("add", ".");
    run("commit", "-q", "-m", "base");
    run("checkout", "-q", "-b", "pr-a");
    writeFileSync(join(root, "a.ts"), "two\n");
    run("commit", "-q", "-am", "a");
    run("checkout", "-q", "main");
    run("checkout", "-q", "-b", "pr-b");
    writeFileSync(join(root, "b.ts"), "beta\n");
    run("commit", "-q", "-am", "b");
    run("checkout", "-q", "main");
    // Different files: no overlap, so no merge-tree, which is the one blocking read still left in this path.
    const rows = [
      { number: 1, head: "pr-a", base: "main", headSha: run("rev-parse", "pr-a") },
      { number: 2, head: "pr-b", base: "main" },
    ];
    expect((await overlapSignals(root, rows)).size).toBe(0);

    const blocking = Bun.spawnSync;
    let blocked = 0;
    Bun.spawnSync = ((...args: Parameters<typeof blocking>) => { blocked++; return blocking(...args); }) as typeof blocking;
    try {
      const since = Math.max(0, ...recent().map((e) => e.id));
      expect((await overlapSignals(root, rows)).size).toBe(0);
      // The single server thread is never held by a `Bun.spawnSync` here...
      expect(blocked).toBe(0);
      // ...and the same head against the same base is not diffed a second time.
      expect(recent(since).filter((e) => e.args[0] === "diff")).toHaveLength(0);
    } finally {
      Bun.spawnSync = blocking;
    }
  });

  test("every head and base of the list is read in two git calls, not a rev-parse per name", async () => {
    const root = mkdtempSync(join(tmpdir(), "agx-orbit-overlap-batch-"));
    dirs.push(root);
    const run = (...args: string[]) => {
      const r = git(root, args);
      if (r.code !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    run("init", "-q", "-b", "main");
    run("config", "user.email", "orbit@example.invalid");
    run("config", "user.name", "Orbit");
    writeFileSync(join(root, "shared.ts"), "one\n");
    run("add", ".");
    run("commit", "-q", "-m", "base");
    const rows: { number: number; head: string; base: string; headSha?: string }[] = [];
    for (const [i, line] of ["A", "B", "C", "D"].entries()) {
      run("checkout", "-q", "-b", `pr-${i}`, "main");
      writeFileSync(join(root, "shared.ts"), `one ${line}\n`);
      run("commit", "-q", "-am", line);
      rows.push(i % 2 ? { number: i, head: `pr-${i}`, base: "main" } : { number: i, head: `pr-${i}`, base: "main", headSha: run("rev-parse", "HEAD") });
    }
    run("checkout", "-q", "main");
    // A head nobody fetched and a branch that does not exist answer nothing, as rev-parse would.
    rows.push({ number: 9, head: "gone", base: "main", headSha: "0".repeat(40) }, { number: 10, head: "nowhere", base: "main" });
    const since = Math.max(0, ...recent().map((e) => e.id));
    const out = await overlapSignals(root, rows);
    expect(out.get(0)).toEqual([1, 2, 3].map((n) => `Overlaps #${n} in shared.ts. Merging both would conflict.`));
    expect(out.has(9) || out.has(10)).toBe(false);
    const calls = recent(since, 1000).map((e) => e.args[0]);
    expect(calls.filter((c) => c === "rev-parse")).toHaveLength(0);
    expect(calls.filter((c) => c === "for-each-ref" || c === "rev-list")).toHaveLength(2);
  });
});

describe("a bot verdict", () => {
  test("a label at the start of a line counts, in any case and in brackets or bold; prose does not", () => {
    expect(botLabels("Blocker: the migration runs twice\n[major] two tests\n**Nit:** spacing\nthis is a major problem")).toEqual(["blocker", "major", "nit"]);
    expect(botCounts(botLabels("- minor: rename\nMAJOR: cache\nnot a label"))).toEqual({ blocker: 0, major: 1, minor: 1, nit: 0 });
    expect(botVerdictLine({ blocker: 1, major: 3, minor: 0, nit: 0 })).toBe("bot review on head: 1 blocker, 3 major");
    expect(botVerdictLine({ blocker: 0, major: 0, minor: 0, nit: 0 })).toBeNull();
  });

  test("no bot login configured reads nothing, and a signal never changes the verdict", async () => {
    expect(await botVerdict(ROOT, 7, "1".repeat(40), [])).toBeNull();
    const [said] = withSignals([item()], { bots: new Map([[7, { blocker: 1, major: 0, minor: 0, nit: 0 }]]) });
    expect(said!.signals).toEqual([{ kind: "botVerdict", text: "bot review on head: 1 blocker" }]);
    expect(said!.cls).toBe("Cleared to land");
    expect(said!.reason).toBe("ready");
  });
});

describe("the door and the budget", () => {
  const rows = [{ number: 7, head: "feat/ORBIT-1042-retry", base: "main", headSha: "1".repeat(40) }];

  test("signals off reads nothing at all", async () => {
    let cards = 0;
    const io: PolarisIo = { rerunJob: async () => ({ ok: true }), readJobs: async () => null, cards: async () => { cards++; return []; } };
    expect(await signalSources(ROOT, settings({ doors: { ...PRESETS.guided.doors, signals: { mode: "off" } } }), rows, io)).toBeNull();
    expect(cards).toBe(0);
  });

  test("no tracker and no bot login configured: the sources are empty, not invented", async () => {
    const src = await signalSources(ROOT, settings(), rows, { rerunJob: async () => ({ ok: true }), readJobs: async () => null });
    expect(src).toEqual({ cards: null, overlaps: new Map(), bots: new Map() });
  });

  test("a bot verdict per pull request, a few read at a time rather than one after another", async () => {
    let inFlight = 0;
    let most = 0;
    const many = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, head: `feat/ORBIT-104${i}`, base: "main", headSha: "1".repeat(40) }));
    const io: PolarisIo = {
      rerunJob: async () => ({ ok: true }), readJobs: async () => null,
      botVerdict: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return { blocker: 0, major: 0, minor: 0, nit: 0 };
      },
    };
    const src = await signalSources(ROOT, settings({ botReviewers: ["orbit-bot"] }), many, io);
    expect(src?.bots?.size).toBe(9);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
  });

  test("watch only: the card door is off, so the tracker is not asked, and the counter stays at zero", async () => {
    let asked = 0;
    const io: PolarisIo = { rerunJob: async () => ({ ok: true }), readJobs: async () => null, cards: async () => { asked++; return []; } };
    const src = await signalSources(ROOT, settings({ doors: PRESETS.watchOnly.doors }), rows, io);
    expect(asked).toBe(0);
    expect(src?.cards).toBeNull();
    expect(__signalStats().requests).toBe(0);
  });
});

describe("the card budget", () => {
  const card: CardState = { id: "cu_9", customId: "ORBIT-1042", title: "Retry the webhook sender", status: "In progress", statusKind: "other", updated: NOW };

  test("no tracker configured reads null and asks nothing", async () => {
    expect(await trackerCards({ clickup: false, jira: false, cached: [] })).toBeNull();
    expect(__signalStats()).toEqual({ requests: 0, cacheHits: 0 });
  });

  test("one list request per five minutes, whatever the number of calls", async () => {
    let asked = 0;
    // A real read fills the integration's cache; the next call answers from it.
    const cache: { at: number; cards: CardState[] }[] = [];
    const source: TrackerSource = { clickup: true, jira: false, cached: cache, now: NOW, readClickup: async () => { asked++; cache.push({ at: NOW, cards: [card] }); return [card]; } };
    expect(await trackerCards(source)).toEqual([card]);
    expect(asked).toBe(1);
    expect(__signalStats()).toEqual({ requests: 1, cacheHits: 0 });
    expect(await trackerCards(source)).toEqual([card]);
    expect(asked).toBe(1);
    expect(__signalStats()).toEqual({ requests: 1, cacheHits: 1 });
  });

  test("both trackers are read, one list each, and both counters see it", async () => {
    let clickup = 0;
    let jira = 0;
    const cu: CardState = { ...card, statusKind: "other" };
    const ji: CardState = { ...card, id: "10", statusKind: "open" };
    const source: TrackerSource = {
      clickup: true, jira: true, cached: [], now: NOW,
      readClickup: async () => { clickup++; return [cu]; },
      readJira: async () => { jira++; return [ji]; },
    };
    expect(await trackerCards(source)).toEqual([cu, ji]);
    expect([clickup, jira]).toEqual([1, 1]);
    expect(__signalStats()).toEqual({ requests: 2, cacheHits: 0 });
  });

  test("a fresh integration cache answers without a request, and the window reopening reads once", async () => {
    let asked = 0;
    const held: CardState = { ...card, title: "Held in the integration's cache" };
    const read = async () => { asked++; return [card]; };
    const cache = [{ at: NOW - 60_000, cards: [held] }];
    expect(await trackerCards({ clickup: true, jira: false, cached: cache, now: NOW, readClickup: read })).toEqual([held]);
    expect(asked).toBe(0);
    expect(__signalStats()).toEqual({ requests: 0, cacheHits: 1 });
    expect(await trackerCards({ clickup: true, jira: false, cached: cache, now: NOW + CARD_TTL_MS, readClickup: read })).toEqual([card]);
    expect(asked).toBe(1);
    expect(__signalStats().requests).toBe(1);
  });

  test("every saved Jira view is read live, not only the first board", () => {
    /* A card on the second board, or on a filter the person saved, was only
       ever found in the cache — and then only until that cache went stale. */
    const views: SavedView[] = [
      { id: "me:assigned", name: "Assigned to me", url: "", addedAt: 0, builtin: true },
      { id: "board:2", name: "Orbit", listId: "2", listName: "Orbit", url: "", addedAt: 1 },
      { id: "board:5", name: "Platform", listId: "5", listName: "Platform", url: "", addedAt: 2 },
      { id: "filter:7", name: "Mine going stale", url: "", addedAt: 3 },
    ];
    expect(jiraCardViews(views).map((v) => v.id)).toEqual(["board:2", "board:5", "filter:7"]);
  });

  test("the board read a signal makes is the unforced one: the section shows what is held, it does not wait on the network", async () => {
    const src = await Bun.file(new URL("../src/polarisSignals.ts", import.meta.url)).text();
    const call = /readView\(view\.id[^)]*\)/.exec(src)?.[0];
    expect(call).toBe("readView(view.id)");
  });
});

describe("the bot verdict reads", () => {
  const HEAD = "a".repeat(40);
  const OLD = "b".repeat(40);
  const json = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
  /** The page a read asked for, from the request's own `page` parameter: a read that carries none asked for the first. */
  const pageOf = (path: string): number => Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
  const ghAt = (h: { comments?: unknown; reviews?: unknown; checkRuns?: unknown }) => async (args: string[]) => {
    const path = args[1] ?? "";
    if (path.includes("/comments")) return json(h.comments ?? []);
    if (path.includes("/reviews")) return json(h.reviews ?? []);
    if (path.includes("/check-runs")) return json(h.checkRuns ?? { check_runs: [] });
    return { code: 1, stdout: "", stderr: "unexpected read" };
  };

  test("only the head commit and only the logins in the setting, and a review body counts", async () => {
    const counts = await botVerdict("gh:acme/orbit", 7, HEAD, ["orbit-bot"], ghAt({
      comments: [
        { body: "Blocker: the migration runs twice", commit_id: HEAD, user: { login: "orbit-bot" } },
        { body: "[major] on an older commit", commit_id: OLD, user: { login: "orbit-bot" } },
        { body: "[major] by a person", commit_id: HEAD, user: { login: "ada" } },
      ],
      reviews: [
        { body: "**Nit:** spacing", commit_id: HEAD, user: { login: "Orbit-Bot" } },
        { body: "Minor: on an older review", commit_id: OLD, user: { login: "orbit-bot" } },
      ],
      checkRuns: { check_runs: [
        { name: "orbit-bot", head_sha: HEAD, app: { slug: "orbit-bot" }, output: { summary: "Major: cache" } },
        { name: "other", head_sha: HEAD, app: { slug: "other" }, output: { summary: "Blocker: not ours" } },
        { name: "orbit-bot", head_sha: OLD, app: { slug: "orbit-bot" }, output: { summary: "Blocker: older head" } },
      ] },
    }));
    expect(counts).toEqual({ blocker: 1, major: 1, minor: 0, nit: 1 });
  });

  test("a different list of bot logins is not answered from the other list's read", async () => {
    let reads = 0;
    const run = async (args: string[]) => {
      reads++;
      return ghAt({ comments: [{ body: "Blocker: the migration runs twice", commit_id: HEAD, user: { login: "orbit-bot" } }] })(args);
    };
    expect(await botVerdict("gh:acme/orbit", 9, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 1, major: 0, minor: 0, nit: 0 });
    // The person narrowed the list and nothing matched it: the earlier read does not answer for this one.
    expect(await botVerdict("gh:acme/orbit", 9, HEAD, ["someone-else"], run)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
    expect(reads).toBe(6);
  });

  test("a full page is followed, so the newer comments on the next page are read", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ body: `note ${i}`, commit_id: HEAD, user: { login: "orbit-bot" } }));
    const second = [{ body: "Blocker: late", commit_id: HEAD, user: { login: "orbit-bot" } }];
    const run = async (args: string[]) => {
      const path = args[1] ?? "";
      if (!path.includes("/comments")) return ghAt({})(args);
      return json(pageOf(path) === 1 ? first : second);
    };
    expect(await botVerdict("gh:acme/orbit", 10, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 1, major: 0, minor: 0, nit: 0 });
  });

  test("a read that fills the last page it is allowed is not kept as a complete one", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ body: `note ${i}`, commit_id: HEAD, user: { login: "orbit-bot" } }));
    let late = false;
    const commentReads: string[] = [];
    const run = async (args: string[]) => {
      const path = args[1] ?? "";
      if (!path.includes("/comments")) return ghAt({})(args);
      commentReads.push(path);
      const said = late && pageOf(path) === 1 ? [...full.slice(1), { body: "Blocker: late", commit_id: HEAD, user: { login: "orbit-bot" } }] : full;
      return json(said);
    };
    expect(await botVerdict("gh:acme/orbit", 11, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
    expect(commentReads).toHaveLength(PAGE_CAP);
    // Five full pages say nothing about a sixth: nothing was kept, so the next pass asks again.
    late = true;
    expect(await botVerdict("gh:acme/orbit", 11, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 1, major: 0, minor: 0, nit: 0 });
    expect(commentReads).toHaveLength(PAGE_CAP * 2);
  });

  test("a page that came back full is whole when the next one is empty, and is kept for the window", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ({ name: `run-${i}`, head_sha: HEAD, app: { slug: "orbit-bot" }, output: { summary: `note ${i}` } }));
    let reads = 0;
    const run = async (args: string[]) => {
      reads++;
      const path = args[1] ?? "";
      if (path.includes("/check-runs")) return json(pageOf(path) === 1 ? { check_runs: hundred } : { check_runs: [] });
      return json([]);
    };
    expect(await botVerdict("gh:acme/orbit", 13, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
    const spent = reads;
    // Exactly a page of check runs is not a truncated read: the second call inside the window spends nothing.
    expect(await botVerdict("gh:acme/orbit", 13, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
    expect(reads).toBe(spent);
  });

  test("a read gh refused is not remembered as zero counts", async () => {
    let reviewsFail = true;
    let reviewsRead = 0;
    const run = async (args: string[]) => {
      const path = args[1] ?? "";
      if (path.includes("/reviews")) {
        reviewsRead++;
        return reviewsFail ? { code: 1, stdout: "", stderr: "gh: not now" } : json([{ body: "Blocker: later", commit_id: HEAD, user: { login: "orbit-bot" } }]);
      }
      if (path.includes("/comments")) return json([]);
      return json({ check_runs: [] });
    };
    expect(await botVerdict("gh:acme/orbit", 8, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 });
    reviewsFail = false;
    expect(await botVerdict("gh:acme/orbit", 8, HEAD, ["orbit-bot"], run)).toEqual({ blocker: 1, major: 0, minor: 0, nit: 0 });
    expect(reviewsRead).toBe(2);
  });
});

describe("a signal never re-files an item", () => {
  test("through polarisItems the class, reason and sentence are the classifier's own", async () => {
    writePolaris(ROOT, { enabled: true, preset: "fullAutopilot", botReviewers: ["orbit-bot"], doors: structuredClone(PRESETS.fullAutopilot.doors) });
    const row: PrSummary = {
      number: 7, title: "Retry the webhook sender", author: "ada", state: "OPEN", isDraft: false, headRefName: "feat/ORBIT-1042-retry",
      baseRefName: "main", url: "https://example.invalid/7", updatedAt: "2026-10-20T00:00:00Z", reviewDecision: "APPROVED", additions: 3, deletions: 1,
      changedFiles: 1, labels: [], assignees: [], milestone: null, mergeable: "MERGEABLE", checksLoaded: true, headSha: "1".repeat(40),
      checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
      humanReview: { kind: "approved", who: ["ada"] },
    };
    const io: PolarisIo = {
      rerunJob: async () => ({ ok: true }), readJobs: async () => null,
      list: async () => ({ ok: true, repo: { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" }, prs: [row], fetchedAt: 1, stale: false, loading: false }),
      overlaps: async () => new Map([[7, ["Overlaps #12 in shared.ts. Merging both would conflict."]]]),
      cards: async () => [{ id: "cu_9", customId: "ORBIT-1042", title: "Retry the webhook sender", status: "In progress", statusKind: "other", updated: NOW - 9 * DAY }],
      botVerdict: async () => ({ blocker: 1, major: 0, minor: 0, nit: 0 }),
    };
    const [it] = (await polarisItems(ROOT, io)).items;
    expect(it!.signals?.map((s) => s.kind)).toEqual(["staleCard", "overlap", "botVerdict"]);
    expect([it!.cls, it!.reason, it!.sentence]).toEqual(["Cleared to land", "ready", "Cleared to land."]);
  });
});

// Thirty open pull requests sharing files were thirty blocking merges in a row
// on the server's only thread: one stall of 8.4 s, every terminal frozen with it.
const signalsSource = await Bun.file(new URL("../src/polarisSignals.ts", import.meta.url)).text();
test("nothing in the signals blocks the server's thread on git", () => {
  const code = signalsSource.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  expect(code).not.toMatch(/[^A-Za-z.]git\(/);
  expect(code).not.toMatch(/spawnSync/);
  expect(code).toMatch(/await conflicts\(/);
});

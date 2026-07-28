/*
 * A queue you can believe, in the two ways it was lying.
 *
 * One: the count. Pull requests were fetched per *checkout*, and this machine
 * keeps three worktrees of the same repository, so one red pull request drew
 * three identical cards and told you there were three things to do.
 *
 * Two: "Later". The Settings row said "hidden until they change" and neither
 * half held — the list was component state, so the queue you emptied refilled
 * on reload, and it was keyed on the item's id, which for a stalled agent or a
 * red pull request never changes at all.
 *
 * The fix for the second turns on `mark`: what a card is reporting, written by
 * the kind that knows which of its fields are news. The trap it has to avoid is
 * the copy, which reads `idle 5m` and `Exited (1) 3 hours ago` — key a snooze
 * on that and every one of them expires within the minute.
 */
import { describe, expect, it } from "bun:test";
import { buildQueue, type NowInput } from "../src/mobile/nowQueue.ts";
import { dedupePrs, mainCheckouts } from "../src/mobile/prRows.ts";
import {
  deviceStore, restoreAll, snooze, unsnoozed, type SnoozeStore,
} from "../src/mobile/snooze.ts";
import type { SessionRollup, PrSummary, DockerContainer } from "../../shared/types.ts";

const NOW = 1_700_000_000_000;
const base: NowInput = { gates: [], sessions: [], prs: [], containers: [], me: "me", now: NOW };

const rollup = (over: Partial<PrSummary["checks"]> = {}) => ({
  total: 5, success: 5, failure: 0, skipped: 0, pending: 0,
  allDone: true, verdict: "green" as const, failing: [], ...over,
});

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 482, title: "Round prices at the cart boundary", author: "me",
  state: "OPEN", isDraft: false, headRefName: "fix/x", baseRefName: "main",
  url: "https://github.com/a/b/pull/482", updatedAt: new Date(NOW - 60_000).toISOString(),
  reviewDecision: null, additions: 84, deletions: 31, changedFiles: 6,
  labels: [], assignees: [], milestone: null, checks: rollup(), checksLoaded: true, ...over,
});

const session = (over: Partial<SessionRollup> = {}): SessionRollup => ({
  session_id: "s1", source_app: "claude-code", model_name: "opus",
  project_path: "/home/me/shop-api", ai_title: "Round prices at the boundary",
  started_at: NOW - 3_600_000, ended_at: null, last_seen: NOW - 6 * 60_000,
  event_count: 10, tool_count: 4, error_count: 0,
  input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 1,
  ...over,
});

const ctr = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "c1", name: "otel-collector", image: "otel/collector", state: "exited",
  status: "Exited (1) 3 hours ago", ports: "", project: "infra", service: "otel",
  runningFor: "3 hours", size: "0B", ...over,
});

/** A localStorage that is only a Map, so a test can hold two of them. */
function fakeStore(): SnoozeStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, getItem: (k) => raw.get(k) ?? null, setItem: (k, v) => { raw.set(k, v); } };
}

// ── one pull request is one card ───────────────────────────────────────

describe("counting a pull request once", () => {
  const rows = (scope: "mine" | "review", repo = "shop-api", number = 482) =>
    ({ repo, scope, pr: { number, url: `https://github.com/a/${repo}/pull/${number}` } });

  it("three worktrees of one repository still make one card", () => {
    // Every checkout of a repository answers the same question with the same
    // answer. Before this, the queue said "3 things want you" and the hero's
    // number was the number of directories on disk.
    expect(dedupePrs([rows("mine"), rows("mine"), rows("mine")])).toHaveLength(1);
  });

  it("yours wins over asked-to-review when both come back", () => {
    // A pull request you own and were also added to is a thing to fix, not a
    // thing to read. Whichever order the two fetches land in.
    expect(dedupePrs([rows("review"), rows("mine")])[0]!.scope).toBe("mine");
    expect(dedupePrs([rows("mine"), rows("review")])[0]!.scope).toBe("mine");
  });

  it("the same number in two repositories is two things", () => {
    const out = dedupePrs([rows("mine", "shop-api"), rows("mine", "shop-web")]);
    expect(out).toHaveLength(2);
  });

  it("asks one checkout per repository, not one per directory", () => {
    // The root cause. Three worktrees is a normal way to work here, and each
    // one answered GitHub's question identically because a worktree shares the
    // remote — so the fix is to stop asking three times, and dedupe is the
    // belt to that pair of braces.
    const list = [
      { root: "/w/shop-api" },
      { root: "/w/shop-api-fix", worktreeOf: "/w/shop-api" },
      { root: "/w/shop-api-spike", worktreeOf: "/w/shop-api" },
      { root: "/w/shop-web" },
    ];
    expect(mainCheckouts(list).map((r) => r.root)).toEqual(["/w/shop-api", "/w/shop-web"]);
  });

  it("keeps a worktree whose main checkout the phone cannot see", () => {
    // Otherwise that repository's pull requests vanish entirely, which is a
    // worse bug than counting them twice.
    const list = [{ root: "/w/detached", worktreeOf: "/elsewhere/shop-api" }];
    expect(mainCheckouts(list)).toHaveLength(1);
  });

  it("falls back to repo and number when there is no url", () => {
    const bare = (scope: "mine" | "review") => ({ repo: "shop-api", scope, pr: { number: 482 } });
    expect(dedupePrs([bare("mine"), bare("review")])).toHaveLength(1);
  });
});

// ── what "unchanged" means ─────────────────────────────────────────────

describe("the mark a snooze is keyed on", () => {
  const input: NowInput = {
    ...base,
    sessions: [session()],
    containers: [ctr()],
    // A halted checkout is in here so the time-invariance rule below covers it
    // too: this card has no timestamp of its own and takes `now` as its sort
    // key, which is exactly the shape that leaks a clock into a mark.
    trees: { "/w/shop-api": { state: "merging", conflicts: ["/w/shop-api/a.ts"] } },
    prs: [{ root: "/r", repo: "shop-api", scope: "mine", pr: pr({ checks: rollup({ failure: 1, failing: [{ name: "test" }] as PrSummary["checks"]["failing"] }) }) }],
  };

  it("does not move just because time passed", () => {
    // The rule, over every kind at once: nothing in a mark may be derived from
    // `now`. An hour and a half is far past the minute at which `idle 5m` and
    // docker's "3 hours ago" both roll over.
    const later = 90 * 60_000;
    const a = buildQueue(input);
    const b = buildQueue({
      ...input,
      now: NOW + later,
      sessions: input.sessions.map((s) => ({ ...s })),
      containers: [ctr({ status: "Exited (1) 4 hours ago" })],
    });
    expect(b.map((i) => i.mark)).toEqual(a.map((i) => i.mark));
  });

  it("and the copy does move, which is why it cannot be the key", () => {
    // Guards the guard above: if the subtitles were static, the test would pass
    // for the wrong reason.
    const a = buildQueue(input);
    const b = buildQueue({ ...input, now: NOW + 90 * 60_000 });
    expect(b.map((i) => i.sub)).not.toEqual(a.map((i) => i.sub));
  });

  it("moves when the agent speaks again", () => {
    const a = buildQueue({ ...base, sessions: [session({ last_seen: NOW - 6 * 60_000 })] });
    const b = buildQueue({ ...base, sessions: [session({ last_seen: NOW - 5 * 60_000 })] });
    expect(b[0]!.mark).not.toBe(a[0]!.mark);
    expect(b[0]!.id).toBe(a[0]!.id);
  });

  it("moves when a different check is the one failing", () => {
    const red = (name: string) => buildQueue({
      ...base,
      prs: [{ root: "/r", repo: "shop-api", scope: "mine", pr: pr({ checks: rollup({ failure: 1, failing: [{ name }] as PrSummary["checks"]["failing"] }) }) }],
    })[0]!;
    expect(red("unit").mark).not.toBe(red("e2e").mark);
  });

  it("moves when a conflict is resolved, so progress is not hidden", () => {
    // Two of three resolved is news: the card should come back saying so rather
    // than staying put because it is "the same repository".
    const m = (n: number) => buildQueue({
      ...base,
      trees: { "/w/a": { state: "merging", conflicts: Array.from({ length: n }, (_, i) => `f${i}`) } },
    })[0]!.mark;
    expect(m(3)).not.toBe(m(1));
    expect(m(3)).toBe(m(3));
  });

  it("moves when a container's exit code changes but not when its age does", () => {
    const mark = (over: Partial<DockerContainer>) =>
      buildQueue({ ...base, containers: [ctr(over)] })[0]!.mark;
    expect(mark({ status: "Exited (1) 3 hours ago" }))
      .toBe(mark({ status: "Exited (1) 9 hours ago" }));
    expect(mark({ status: "Exited (1) 3 hours ago" }))
      .not.toBe(mark({ status: "Exited (137) 3 hours ago" }));
  });
});

// ── later, and how it lifts ────────────────────────────────────────────

describe("Later", () => {
  const item = (mark: string) => ({ mark });

  it("hides the card", () => {
    const s = fakeStore();
    snooze(s, item("a"), NOW);
    expect(unsnoozed(s, [item("a"), item("b")], NOW).map((i) => i.mark)).toEqual(["b"]);
  });

  it("survives the tab being closed", () => {
    // The whole failure of the old one: `dismissed` was useState, so a queue
    // you emptied on the train was full again at the office.
    const s = fakeStore();
    snooze(s, item("a"), NOW);
    const reopened: SnoozeStore = { getItem: (k) => s.raw.get(k) ?? null, setItem: () => {} };
    expect(unsnoozed(reopened, [item("a")], NOW)).toHaveLength(0);
  });

  it("lifts itself the moment the card has something new to say", () => {
    const s = fakeStore();
    snooze(s, item("red:shop#482:T1:unit"), NOW);
    // Checks re-ran and a different one failed.
    expect(unsnoozed(s, [item("red:shop#482:T1:e2e")], NOW)).toHaveLength(1);
  });

  it("lifts after twelve hours even if nothing changed", () => {
    const s = fakeStore();
    snooze(s, item("a"), NOW);
    expect(unsnoozed(s, [item("a")], NOW + 11 * 3_600_000)).toHaveLength(0);
    expect(unsnoozed(s, [item("a")], NOW + 13 * 3_600_000)).toHaveLength(1);
  });

  it("Restore brings back everything at once", () => {
    const s = fakeStore();
    snooze(s, item("a"), NOW);
    snooze(s, item("b"), NOW);
    expect(unsnoozed(s, [item("a"), item("b")], NOW)).toHaveLength(0);
    restoreAll(s);
    expect(unsnoozed(s, [item("a"), item("b")], NOW)).toHaveLength(2);
  });

  it("does not accumulate expired entries on the way through", () => {
    const s = fakeStore();
    snooze(s, item("old"), NOW);
    snooze(s, item("new"), NOW + 13 * 3_600_000);
    expect(JSON.parse(s.raw.get("mb.snoozed")!)).toEqual({ new: { at: NOW + 13 * 3_600_000 } });
  });

  it("shows everything rather than failing on a value it cannot read", () => {
    const bad: SnoozeStore = { getItem: () => "{not json", setItem: () => {} };
    expect(unsnoozed(bad, [item("a")], NOW)).toHaveLength(1);
    expect(unsnoozed({ getItem: () => "[1,2,3]", setItem: () => {} }, [item("a")], NOW)).toHaveLength(1);
  });

  /** Runs `fn` with `localStorage` replaced, however it is broken today. */
  function withStorage(desc: PropertyDescriptor, fn: () => void) {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, ...desc });
    try { fn(); } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  }

  it("keeps working where touching localStorage throws", () => {
    // Safari with site data blocked throws on access rather than returning
    // null. A phone in that mode should get the tab-lifetime behaviour
    // everybody had before this module, not a crashed queue.
    withStorage({ get() { throw new Error("SecurityError"); } }, () => {
      const s = deviceStore();
      restoreAll(s);
      snooze(s, item("a"), NOW);
      expect(unsnoozed(s, [item("a")], NOW)).toHaveLength(0);
    });
  });

  it("keeps working where reads succeed and writes throw", () => {
    // The case a read probe cannot see, and the one that matters most: every
    // "Later" you tap would be accepted and do nothing at all.
    withStorage({
      value: {
        getItem: () => null,
        setItem: () => { throw new Error("QuotaExceededError"); },
        removeItem: () => {},
      },
    }, () => {
      const s = deviceStore();
      restoreAll(s);
      snooze(s, item("a"), NOW);
      expect(unsnoozed(s, [item("a")], NOW)).toHaveLength(0);
    });
  });

  it("uses localStorage when localStorage works", () => {
    // And the other way round: the fallback must not swallow the durable path,
    // or nothing survives a reload and we are back where we started.
    const raw = new Map<string, string>();
    withStorage({
      value: {
        getItem: (k: string) => raw.get(k) ?? null,
        setItem: (k: string, v: string) => { raw.set(k, v); },
        removeItem: (k: string) => { raw.delete(k); },
      },
    }, () => {
      snooze(deviceStore(), item("a"), NOW);
      expect(raw.get("mb.snoozed")).toContain("\"a\"");
      expect([...raw.keys()]).toEqual(["mb.snoozed"]);
    });
  });
});

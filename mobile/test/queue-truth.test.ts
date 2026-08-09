/*
 * A queue you can believe, in the two ways it was lying.
 *
 * One: the count. Pull requests were fetched per *checkout*, and this machine
 * keeps three worktrees of the same repository, so one red pull request drew
 * three identical cards and told you there were three things to do.
 *
 * Two: "Later" — hidden until they change, which held in neither half. That
 * half of the suite went with the browser companion: "Later" was `snooze.ts`
 * over `localStorage`, and this app has neither the storage nor the feature.
 *
 * What survives it is `mark`: what a card is reporting, written by the kind
 * that knows which of its fields are news. It is still worth this much testing
 * with nothing snoozing on it, because it is the identity a re-render compares
 * against — the trap is the copy, which reads `idle 5m` and `Exited (1) 3 hours
 * ago`, so a mark taken from what the card SAYS moves every minute on its own.
 */
import { describe, expect, it } from "bun:test";
import { buildQueue, type NowInput } from "../src/model/nowQueue.ts";
import { dedupePrs, mainCheckouts } from "../src/model/prRows.ts";
import type { SessionRollup, PrSummary, DockerContainer } from "../../shared/types.ts";

const NOW = 1_700_000_000_000;
const base: NowInput = { gates: [], sessions: [], prs: [], containers: [], me: "me", now: NOW };

const rollup = (over: Partial<PrSummary["checks"]> = {}) => ({
  total: 5, success: 5, failure: 0, skipped: 0, pending: 0,
  allDone: true, verdict: "green" as const, failing: [], ...over,
});

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 482,
  // Defaulted before the spread, so a case can still say CONFLICTING.
  mergeable: "MERGEABLE", title: "Round prices at the cart boundary", author: "me",
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
  status: "Exited (1) 3 hours ago", ports: "", project: "infra", service: "otel", workingDir: null,
  runningFor: "3 hours", size: "0B", ...over,
});

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

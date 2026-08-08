import { describe, expect, it } from "bun:test";
import { buildQueue, waitingItems, newsItems, type NowInput } from "../src/model/nowQueue.ts";
import type { PendingGate, SessionRollup, PrSummary, DockerContainer } from "../../shared/types.ts";

const NOW = 1_700_000_000_000;

const base: NowInput = { gates: [], sessions: [], prs: [], containers: [], me: "me", now: NOW };

const gate = (over: Partial<PendingGate> = {}): PendingGate => ({
  id: "g1", tool_name: "Bash", summary: "Run the production backfill",
  source_app: "claude-code", created: NOW - 5_000, session_id: "s1", ...over,
} as PendingGate);

const session = (over: Partial<SessionRollup> = {}): SessionRollup => ({
  session_id: "s1", source_app: "claude-code", model_name: "opus",
  project_path: "/home/me/shop-api", ai_title: "Round prices at the boundary",
  started_at: NOW - 3_600_000, ended_at: null, last_seen: NOW - 6 * 60_000,
  event_count: 10, tool_count: 4, error_count: 0,
  input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 1,
  ...over,
});

const rollup = (over: Partial<PrSummary["checks"]> = {}) => ({
  total: 5, success: 5, failure: 0, skipped: 0, pending: 0,
  allDone: true, verdict: "green" as const, failing: [], ...over,
});

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 482, title: "Round prices at the cart boundary", author: "someone",
  state: "OPEN", isDraft: false, headRefName: "fix/x", baseRefName: "main",
  url: "https://github.com/a/b/pull/482", updatedAt: new Date(NOW - 60_000).toISOString(),
  reviewDecision: null, additions: 84, deletions: 31, changedFiles: 6,
  labels: [], assignees: [], milestone: null, checks: rollup(), checksLoaded: true, ...over,
});

const ctr = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "c1", name: "otel-collector", image: "otel/collector", state: "running",
  status: "Up 2 hours", ports: "", project: "infra", service: "otel", workingDir: null,
  runningFor: "2 hours", size: "0B", ...over,
});

describe("a repository git stopped part-way", () => {
  // `treeState()` has reported this from the server since the beginning and the
  // phone read `branch.name` and nothing else, so a checkout sitting on a
  // half-finished rebase was indistinguishable from a clean one — on the one
  // surface whose whole job is telling you something needs a person.
  it("reaches the queue at all", () => {
    const q = buildQueue({ ...base, trees: { "/w/shop-api": { state: "merging", conflicts: ["/w/shop-api/a.ts"] } } });
    expect(q).toHaveLength(1);
    expect(q[0]!.id).toBe("halt:/w/shop-api");
    expect(q[0]!.origin.t).toBe("halt");
  });

  it("outranks everything except a blocked agent", () => {
    // Nothing in that checkout moves again — not a commit, not a branch switch,
    // not an agent working in it — until somebody decides.
    const q = buildQueue({
      ...base,
      gates: [gate()],
      containers: [ctr({ state: "exited", status: "Exited (1) 3 hours ago" })],
      trees: { "/w/shop-api": { state: "rebasing", conflicts: [] } },
    });
    expect(q[0]!.origin.t).toBe("gate");
    expect(q[1]!.origin.t).toBe("halt");
  });

  it("draws no age, because git does not record when it stopped", () => {
    // `ts: now` made the header read "now" forever and, inside the band, made
    // this item beat everything that had a real moment.
    const q = buildQueue({ ...base, trees: { "/w/a": { state: "merging", conflicts: [] } } });
    expect(q[0]!.ts).toBeUndefined();
  });

  it("names the repository, because the queue spans all of them", () => {
    const q = buildQueue({ ...base, trees: { "/w/shop-api": { state: "merging", conflicts: [] } } });
    expect(q[0]!.title).toContain("shop-api");
  });

  it("says nothing about clean checkouts, or about none at all", () => {
    expect(buildQueue({ ...base, trees: { "/w/a": { state: "clean", conflicts: [] } } })).toHaveLength(0);
    expect(buildQueue({ ...base, trees: { "/w/a": { conflicts: [] } } })).toHaveLength(0);
    expect(buildQueue({ ...base, trees: {} })).toHaveLength(0);
    expect(buildQueue(base)).toHaveLength(0);
  });
});

describe("buildQueue", () => {
  it("puts a blocked agent above everything else", () => {
    const q = buildQueue({
      ...base,
      gates: [gate()],
      containers: [ctr({ state: "exited" })],
      prs: [{ root: "/r", repo: "shop-api", scope: "review", pr: pr() }],
    });
    expect(q[0]!.tone).toBe("crit");
    expect(q[0]!.id).toBe("gate:g1");
  });

  it("only calls an agent stopped once it has actually gone quiet", () => {
    const busy = buildQueue({ ...base, sessions: [session({ last_seen: NOW - 30_000 })] });
    expect(busy).toHaveLength(0);

    const quiet = buildQueue({ ...base, sessions: [session({ last_seen: NOW - 6 * 60_000 })] });
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.kind).toContain("Stopped");
  });

  it("drops an agent that went quiet yesterday", () => {
    // A queue you cannot empty is a dashboard, and this is the item that would
    // never leave it.
    const q = buildQueue({ ...base, sessions: [session({ last_seen: NOW - 20 * 60 * 60_000 })] });
    expect(q).toHaveLength(0);
  });

  it("ignores an ended session however long ago it spoke", () => {
    const q = buildQueue({ ...base, sessions: [session({ ended_at: NOW - 60_000 })] });
    expect(q).toHaveLength(0);
  });

  it("raises your own red pull request, and not somebody else's", () => {
    const red = rollup({ failure: 1, success: 4, verdict: "red", failing: [{ name: "e2e", workflow: "CI", state: "failure", done: true }] });
    const mine = buildQueue({ ...base, prs: [{ root: "/r", repo: "shop-api", scope: "mine", pr: pr({ checks: red }) }] });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toContain("e2e");

    const theirs = buildQueue({ ...base, prs: [{ root: "/r", repo: "shop-api", scope: "review", pr: pr({ checks: red, author: "other" }) }] });
    expect(theirs.every((i) => i.kind !== "CI went red")).toBe(true);
  });

  it("offers a merge only when it is approved, green and not a draft", () => {
    const ready = (over: Partial<PrSummary>) =>
      buildQueue({ ...base, prs: [{ root: "/r", repo: "s", scope: "mine", pr: pr({ reviewDecision: "APPROVED", ...over }) }] });

    expect(ready({})).toHaveLength(1);
    expect(ready({})[0]!.kind).toBe("Ready to merge");
    expect(ready({ isDraft: true })).toHaveLength(0);
    expect(ready({ checks: rollup({ pending: 1 }) })).toHaveLength(0);
    expect(ready({ reviewDecision: "REVIEW_REQUIRED" })).toHaveLength(0);
  });

  it("does not claim a merge is ready before the checks have been fetched", () => {
    // `checksLoaded` false means "not asked yet", which is a different claim
    // from "nothing failed" — offering a merge on it would be a guess.
    const q = buildQueue({
      ...base,
      prs: [{ root: "/r", repo: "s", scope: "mine", pr: pr({ reviewDecision: "APPROVED", checksLoaded: false }) }],
    });
    expect(q).toHaveLength(0);
  });

  it("reports a container that fell over, but not one that never started", () => {
    const down = buildQueue({ ...base, containers: [ctr({ state: "exited", status: "Exited (1) 2m ago" })] });
    expect(down).toHaveLength(1);
    expect(down[0]!.tone).toBe("bad");

    const never = buildQueue({ ...base, containers: [ctr({ state: "created" })] });
    expect(never).toHaveLength(0);

    const fine = buildQueue({ ...base, containers: [ctr()] });
    expect(fine).toHaveLength(0);
  });

  it("leaves a job that finished alone", () => {
    // A migration exits 0 and stays exited. Calling that "down" means the
    // queue can never be emptied, which is the one thing it has to do.
    const done = buildQueue({ ...base, containers: [ctr({ name: "shop-migrate", state: "exited", status: "Exited (0) 3 hours ago" })] });
    expect(done).toHaveLength(0);

    const crashed = buildQueue({ ...base, containers: [ctr({ state: "exited", status: "Exited (137) 1 minute ago" })] });
    expect(crashed).toHaveLength(1);

    const looping = buildQueue({ ...base, containers: [ctr({ state: "restarting", status: "Restarting (1) 8 seconds ago" })] });
    expect(looping).toHaveLength(1);

    // No code to read is not proof it is fine, so it still gets raised.
    const opaque = buildQueue({ ...base, containers: [ctr({ state: "exited", status: "Exited recently" })] });
    expect(opaque).toHaveLength(1);
  });

  it("puts everything that is stopped above everything that is merely true", () => {
    const red = rollup({ failure: 1, verdict: "red", failing: [{ name: "e2e", workflow: "CI", state: "failure", done: true }] });
    const q = buildQueue({
      ...base,
      gates: [gate()],
      sessions: [session()],
      containers: [ctr({ state: "exited" })],
      prs: [
        { root: "/r", repo: "s", scope: "mine", pr: pr({ number: 1, checks: red }) },
        { root: "/r", repo: "s", scope: "mine", pr: pr({ number: 2, reviewDecision: "APPROVED" }) },
        { root: "/r", repo: "s", scope: "review", pr: pr({ number: 3, author: "other" }) },
      ],
    });
    // The rule that matters, first: anything stopped comes before anything
    // that is not, whatever its tone. Before this, a red build (`bad`) sorted
    // above a stalled agent (`plain`) — so the loudest card on the screen was
    // the one nothing was waiting on, and the one thing only a person could
    // restart was below it.
    expect(q.map((i) => i.waiting)).toEqual([true, true, false, false, false, false]);
    // And the old order still holds inside each half: blocked, broken,
    // finished, the rest.
    expect(q.map((i) => i.tone)).toEqual(["crit", "plain", "bad", "bad", "good", "plain"]);
  });

  it("counts a gate, a stalled agent and a halted checkout as stopped, and nothing else", () => {
    // The whole screen turns on this split, so it is worth stating flatly
    // rather than inferring from an order. A pull request needing review is a
    // person waiting, which is real and is not an agent that cannot continue —
    // and it is the kind there is always most of, which is what drowned the
    // gates when one number counted both.
    const red = rollup({ failure: 1, verdict: "red", failing: [{ name: "e2e", workflow: "CI", state: "failure", done: true }] });
    const q = buildQueue({
      ...base,
      gates: [gate()],
      sessions: [session()],
      containers: [ctr({ state: "exited" })],
      prs: [
        { root: "/r", repo: "s", scope: "mine", pr: pr({ number: 1, checks: red }) },
        { root: "/r", repo: "s", scope: "mine", pr: pr({ number: 2, reviewDecision: "APPROVED" }) },
        { root: "/r", repo: "s", scope: "review", pr: pr({ number: 3, author: "other" }) },
      ],
    });
    const stopped = q.filter((i) => i.waiting).map((i) => i.origin.t).sort();
    const news = q.filter((i) => !i.waiting).map((i) => i.origin.t).sort();
    expect(stopped).toEqual(["gate", "session"]);
    expect(news).toEqual(["container", "pr-ready", "pr-red", "pr-review"]);
  });

  it("counts a halted checkout as stopped", () => {
    // Its own case because it needs a tree rather than a session, and because
    // it is the one kind with no timestamp: nothing in that checkout moves
    // again until somebody decides, which is the definition being used here.
    const q = buildQueue({
      ...base,
      trees: { "/r": { state: "merging", conflicts: ["a.ts"] } },
    });
    expect(q).toHaveLength(1);
    expect(q[0]!.waiting).toBe(true);
  });

  it("separates the two halves cleanly for the view", () => {
    const q = buildQueue({ ...base, gates: [gate()], containers: [ctr({ state: "exited" })] });
    expect(waitingItems(q).map((i) => i.origin.t)).toEqual(["gate"]);
    expect(newsItems(q).map((i) => i.origin.t)).toEqual(["container"]);
    // Every item lands in exactly one of them.
    expect(waitingItems(q).length + newsItems(q).length).toBe(q.length);
  });
});

/*
 * The Inbox's ranking, its scope and its one number — as data.
 *
 * The screen is drawn from `collectInbox`, so the four things that can go wrong
 * are checkable here without a renderer:
 *
 *   - order: something stopped (blocking) outranks something abandoned (error),
 *     which outranks something merely worth knowing (warn); and inside a level
 *     the row that has waited longest comes first.
 *   - scope: a phone that may only look still SEES the gate and the settings
 *     request, but is not offered their controls, and a plan's Go needs full.
 *   - one failing source does not empty the list: the rows that answered are
 *     still there, and the one that did not is named.
 *   - the count is the rows: the bell and the list cannot disagree.
 *
 * Fixtures are hand-built shapes from the routes, never another module's
 * output, so a classifier that changed its mind cannot take this file with it.
 */
import { describe, expect, test } from "bun:test";
import type { PendingGate } from "../../shared/types.ts";
import type { SettingRequestView } from "../../shared/settingClass.ts";
import {
  WHY_NOT, agentRoster, collectInbox, rosterFoot, type PlanWaiting, type ReviewWaiting, type StoppedAgent,
  type WatchWaiting,
} from "../src/model/inbox.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");

const gate = (id: string, created: number, summary: string): PendingGate => ({
  id,
  source_app: "orbit",
  session_id: `s-${id}`,
  tool_name: "Bash",
  summary,
  created,
  where: "orbit · 2 build",
});

const setting = (id: string, at: number, expires: number): SettingRequestView => ({
  id,
  setting: "allow",
  label: "Allow `bun run build` to run",
  who: "agentglass · scratch:1",
  diff: ["Allow `bun run build` to run", "permissions: ask -> allow"],
  at,
  expires,
});

const review = (number: number, repo = "acme/orbit", root = "/src/orbit"): ReviewWaiting => ({
  root,
  repo,
  pr: { number, title: "Add dark mode to the settings rail", author: "ana", updatedAt: "2026-11-04T11:00:00Z" },
});

const agent = (name: string, extra: Partial<StoppedAgent> = {}): StoppedAgent => ({
  name,
  state: "waiting",
  needsYou: { kind: "permission", since: NOW - 10 * 60_000 },
  doing: "running the api tests",
  ...extra,
});

const fire = (seq: number, extra: Partial<WatchWaiting> = {}): WatchWaiting => ({
  seq,
  repo: "acme/orbit",
  number: 184,
  summary: "CI passed",
  detail: "49 of 49 checks passed",
  ok: true,
  payload: { title: "#184 is green", line: "49 of 49 checks passed", target: { kind: "pr", root: "/src/orbit" } },
  ...extra,
});

const plan = (id: string, extra: Partial<PlanWaiting> = {}): PlanWaiting => ({
  id,
  title: "Ship dark mode behind a flag",
  root: "/src/orbit",
  state: "ready",
  size: "M",
  updatedAt: NOW - 60 * 60_000,
  ...extra,
});

describe("the order", () => {
  test("blocking, then error, then warn", () => {
    const got = collectInbox({
      gates: [gate("g1", NOW - 60_000, "bun test")],
      agents: [agent("api-tests", { needsYou: { kind: "input", since: NOW - 90 * 60_000 } })],
      reviews: [review(184)],
      plans: [plan("fp_1")],
    }, "full", NOW);
    // A plan waiting for Go is blocking: the builder does not start until
    // somebody answers. Inside a level the one that has waited longest leads,
    // so the plan (an hour) comes before the gate (a minute).
    expect(got.items.map((i) => i.level)).toEqual(["blocking", "blocking", "error", "warn"]);
    expect(got.items.map((i) => i.id)).toEqual([
      "plan:fp_1", "gate:g1", "agent:api-tests", "review:acme/orbit#184",
    ]);
  });

  test("a Go card ranks above a watch that failed", () => {
    // The one thing on this list that is a decision outranks the news, even
    // when the news is a failure: Go blocks a worker on you.
    const got = collectInbox({
      plans: [plan("fp_1", { updatedAt: NOW - 5 * 60_000 })],
      watches: [fire(3, { ok: false, summary: "CI failed", payload: { title: "#189 failed in server tests" } })],
    }, "full", NOW);
    expect(got.items.map((i) => i.id)).toEqual(["plan:fp_1", "watch:000003"]);
    expect(got.items.map((i) => i.level)).toEqual(["blocking", "error"]);
  });

  test("inside a level, the one that has waited longest is first", () => {
    // Two gates: the older one is the agent that has been stopped longest, and
    // it is the one to answer. This is `gatesInOrder`'s rule, not the desk's
    // newest-first, and the two screens must agree.
    const got = collectInbox({
      gates: [gate("newer", NOW - 60_000, "bun test"), gate("older", NOW - 10 * 60_000, "bun lint")],
    }, "answer", NOW);
    expect(got.items.map((i) => i.id)).toEqual(["gate:older", "gate:newer"]);
  });

  test("a plan that is not ready is not waiting on anybody", () => {
    const got = collectInbox({ plans: [plan("fp_draft", { state: "draft" }), plan("fp_go", { state: "ready" })] }, "full", NOW);
    expect(got.items.map((i) => i.id)).toEqual(["plan:fp_go"]);
  });
});

describe("the scope", () => {
  const answers = {
    gates: [gate("g1", NOW - 60_000, "bun test")],
    settings: [setting("s1", NOW - 60_000, NOW + 8 * 60_000)],
    plans: [plan("fp_1")],
    reviews: [review(184)],
    agents: [agent("api-tests")],
  };

  test("read sees everything and may act on neither of the two answers", () => {
    const got = collectInbox(answers, "read", NOW);
    const can = Object.fromEntries(got.items.map((i) => [i.source, i.canAct]));
    expect(can.gate).toBe(false);
    expect(can.settings).toBe(false);
    // Opening a pull request or the terminal is a GET, so those rows stay live.
    expect(can.review).toBe(true);
    expect(can.agent).toBe(true);
  });

  test("answer may decide a gate and a settings request, not a plan", () => {
    const got = collectInbox(answers, "answer", NOW);
    const can = Object.fromEntries(got.items.map((i) => [i.source, i.canAct]));
    expect(can.gate).toBe(true);
    expect(can.settings).toBe(true);
    // Go spends a worker: POST, needs full.
    expect(can.plan).toBe(false);
  });

  test("full may act on everything", () => {
    const got = collectInbox(answers, "full", NOW);
    expect(got.items.every((i) => i.canAct)).toBe(true);
  });
});

describe("a source that did not answer", () => {
  test("does not empty the list, and is named", () => {
    const got = collectInbox({
      gates: [gate("g1", NOW - 60_000, "bun test")],
      settings: null,
      plans: null,
      failed: [
        { source: "settings", error: "Cannot reach the computer" },
        { source: "plans", error: "The computer did not answer in time" },
      ],
    }, "answer", NOW);
    expect(got.items.length).toBe(1);
    expect(got.items[0]?.id).toBe("gate:g1");
    expect(got.missing).toEqual([
      "Settings requests did not answer — Cannot reach the computer",
      "Flight plans did not answer — The computer did not answer in time",
    ]);
  });

  test("an expired request is not waiting, and not a failure either", () => {
    const got = collectInbox({
      settings: [setting("gone", NOW - 20 * 60_000, NOW - 1)],
    }, "answer", NOW);
    expect(got.items).toEqual([]);
    expect(got.missing).toEqual([]);
  });
});

describe("the count", () => {
  test("is exactly the rows the list draws", () => {
    const got = collectInbox({
      gates: [gate("g1", NOW - 60_000, "bun test")],
      settings: [setting("s1", NOW - 60_000, NOW + 8 * 60_000)],
      reviews: [review(184), review(181)],
      agents: [agent("api-tests")],
      plans: [plan("fp_1")],
    }, "full", NOW);
    expect(got.count).toBe(got.items.length);
    expect(got.count).toBe(6);
  });

  test("two checkouts of one repository file one review row", () => {
    // Six worktrees of one repository answer with the same pull request; "you
    // have two reviews" for one PR is a number nobody can act on.
    const got = collectInbox({
      reviews: [review(184), review(184), review(189, "acme/orbit", "/src/orbit-worktree")],
    }, "read", NOW);
    expect(got.items.map((i) => i.id)).toEqual(["review:acme/orbit#184", "review:acme/orbit#189"]);
  });
});

describe("a watch that fired", () => {
  test("is a warning when it reports a pass and an error when it reports a failure", () => {
    const got = collectInbox({ watches: [fire(1), fire(2, { ok: false, summary: "CI failed" })] }, "full", NOW);
    const by = Object.fromEntries(got.items.map((i) => [i.id, i.level]));
    expect(by["watch:000001"]).toBe("warn");
    expect(by["watch:000002"]).toBe("error");
  });

  test("keeps the order the computer decided, not the alphabet", () => {
    // The queue carries no clock; the id is what the sorter falls back to, so
    // it is zero-padded — `watch:9` would sort after `watch:12`.
    const got = collectInbox({ watches: [fire(9), fire(12), fire(10)] }, "full", NOW);
    expect(got.items.map((i) => i.id)).toEqual(["watch:000009", "watch:000010", "watch:000012"]);
  });

  test("says what happened, in the server's own words, and where", () => {
    const got = collectInbox({ watches: [fire(4)] }, "full", NOW);
    const row = got.items[0]!;
    expect(row.text).toBe("#184 is green");
    expect(row.detail).toBe("acme/orbit #184 · 49 of 49 checks passed");
    expect(row.action).toEqual({ kind: "watch", seq: 4, repo: "acme/orbit", number: 184, root: "/src/orbit" });
  });

  test("opens its pull request on a phone that may only look", () => {
    // Opening a PR is a GET. Settling the fire is a write, and `onAck` is what
    // refuses that — the row itself is still a live row.
    const got = collectInbox({ watches: [fire(4)] }, "read", NOW);
    expect(got.items[0]?.canAct).toBe(true);
  });

  test("counts toward the bell, and a route that failed is named", () => {
    const got = collectInbox({
      watches: [fire(1)],
      failed: [{ source: "watches", error: "Cannot reach the computer" }],
    }, "full", NOW);
    expect(got.count).toBe(1);
    expect(got.missing).toEqual(["Watches did not answer — Cannot reach the computer"]);
  });
});

describe("a Go card on a phone that may not press it", () => {
  test("is drawn, disabled, with the sentence that says what would change it", () => {
    const got = collectInbox({ plans: [plan("fp_1")] }, "read", NOW);
    const row = got.items[0]!;
    expect(row.source).toBe("plan");
    expect(row.canAct).toBe(false);
    // The control is not offered, and the reason is one line saying how to
    // repair it — not a dead button that posts into a 403.
    expect(WHY_NOT.plan).toContain("Go");
    expect(WHY_NOT.plan).toContain("pair");
  });

  test("a full pairing may act on it", () => {
    expect(collectInbox({ plans: [plan("fp_1")] }, "full", NOW).items[0]?.canAct).toBe(true);
  });
});

describe("the agents roster", () => {
  const working = agent("codex", {
    state: "working",
    needsYou: undefined,
    saidAt: NOW - 12 * 60_000,
    doing: "editing src/settings/rail.tsx",
    pulse: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4],
  });
  const finished = agent("docs", {
    state: "idle",
    needsYou: undefined,
    saidAt: NOW - 2 * 60_000,
    doing: "118 passed",
    pulse: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  });
  const waiting = agent("api-tests", { needsYou: { kind: "permission", since: NOW - 60_000 } });

  test("puts what is stopped on you first, and words each row", () => {
    const lines = agentRoster([working, finished, waiting], NOW);
    expect(lines.map((l) => l.name)).toEqual(["api-tests", "codex", "docs"]);
    expect(lines.map((l) => l.word)).toEqual(["waiting for you", "working", "finished"]);
    expect(lines[1]?.said).toBe("working 12m · editing src/settings/rail.tsx");
  });

  test("a pulse that stopped two buckets ago is finished, not working", () => {
    // The last hour in five-minute buckets: the tail is the same rule the
    // server's own `movingNow` uses.
    expect(agentRoster([finished], NOW)[0]?.mood).toBe("finished");
  });

  test("the foot counts the rows it is under", () => {
    expect(rosterFoot(agentRoster([working, finished, waiting], NOW)))
      .toBe("1 working, 1 finished, 1 waiting for you.");
    expect(rosterFoot([])).toBe("No agent has reported in this hour.");
  });
});

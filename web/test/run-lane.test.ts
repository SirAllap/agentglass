/*
 * The run lane, drawn.
 *
 * A run is one prompt asked in several checkouts at once, and the half of it
 * worth building is the ADOPTED leg: a pane the user started themselves, in a
 * checkout this app never cut, possibly running another vendor's CLI. Every
 * assertion below exists because that leg can be lost in one of three quiet
 * ways — drawn like the others, counted twice because it also sits in its
 * project group, or explained only in a tooltip nobody opens.
 *
 * There is no DOM under `bun test`, so what these render is the FIRST PAINT:
 * effects have not run and nothing has been fetched. Where a test needs the
 * per-leg numbers it seeds the store through a stubbed `fetch` first, which is
 * the same route the real panel takes and keeps the fixtures honest — they are
 * the bodies server/src/index.ts actually answers with.
 */
import { describe, expect, it, beforeEach, afterAll } from "bun:test";

/* A module-level store in a one-process suite: a watcher the previous FILE
   forgot to stop is still subscribed when this one starts, and its reads land
   in these counters. See __resetRunStore. */
beforeEach(() => { __resetRunStore(); });

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCard } from "../src/lib/derive.ts";
import type { LegActivity, Run, RunLeg } from "../src/lib/api.ts";
import { RunLane, RunLanes, laneRows, laneSpend, legDirs, cardsIn } from "../src/components/RunLane.tsx";
import { Fleet } from "../src/components/Fleet.tsx";
import { forgetRuns, refreshActivity, refreshRuns, __resetRunStore } from "../src/lib/runStore.ts";

/* ── the fixtures ─────────────────────────────────────────────────────────── */

const CUT = "/home/dev/orbit-run-8f2a1c-claude-code";
const CUT2 = "/home/dev/orbit-run-8f2a1c-codex";
/** The one nobody cut: an ordinary sibling checkout somebody made by hand. */
const MINE = "/home/dev/orbit-scratch";

const leg = (over: Partial<RunLeg> = {}): RunLeg => ({
  worktree: CUT,
  branch: "run-8f2a1c-claude-code",
  agent: "claude-code",
  paneId: "%41",
  state: "running",
  origin: "spawned",
  startedAt: 1_700_000_000_000,
  ...over,
});

/** Same shape, one field different — and a branch git calls `(detached)`,
 *  because nobody promised a hand-cut checkout would be on one. */
const adoptedLeg = (over: Partial<RunLeg> = {}): RunLeg =>
  leg({ worktree: MINE, branch: "(detached)", agent: "codex", paneId: "%7", origin: "adopted", ...over });

const run = (over: Partial<Run> = {}): Run => ({
  id: "8f2a1c",
  root: "/home/dev/orbit",
  prompt: "teach the importer to read CRLF files",
  legs: [leg()],
  startedAt: 1_700_000_000_000,
  ...over,
});

const act = (over: Partial<LegActivity> = {}): LegActivity => ({
  worktree: CUT,
  branch: "run-8f2a1c-claude-code",
  agent: "claude-code",
  origin: "spawned",
  state: "running",
  sessions: 1,
  events: 42,
  toolCalls: 17,
  errors: 0,
  costUsd: 0.31,
  providers: [{ provider: "Anthropic", events: 42, costUsd: 0.31 }],
  lastSeen: 1_700_000_100_000,
  ...over,
});

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  key: "orbit\0s1",
  source_app: "orbit",
  session_id: "s1",
  title: "reading the import fixtures",
  model_name: "claude-opus-4-8",
  status: "working",
  outcome: "unclear",
  lastAction: "Bash",
  lastType: "PostToolUse",
  events: 42,
  tools: 17,
  errors: 0,
  toolErrors: 0,
  cost: 0.31,
  tokens: 12_000,
  lastSeen: 1_700_000_100_000,
  lastErrorTs: 0,
  spark: [1, 2, 3],
  subagents: 0,
  subagentTypes: [],
  needBecause: "",
  cwd: CUT,
  project: "/home/dev/orbit",
  runningTool: null,
  runningSince: 0,
  evidenceAt: null,
  evidenceKind: null,
  liveness: "unknown",
  ctxTokens: 0,
  ctxTs: 0,
  ctxLimit: 0,
  worktree: "run-8f2a1c-claude-code",
  ...over,
});

/* ── the stub ─────────────────────────────────────────────────────────────── */

let answer: (url: string) => unknown = () => ({ runs: [] });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) =>
  new Response(JSON.stringify(answer(String(input))), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

beforeEach(() => { forgetRuns(); answer = () => ({ runs: [] }); });

const draw = (el: React.ReactElement) => renderToStaticMarkup(el);
const lane = (r: Run, cards: AgentCard[] = []) =>
  draw(React.createElement(RunLane, { run: r, cards, renderCard: (a: AgentCard) => a.title }));
/** The markup with every tooltip removed. What is left is what a person can
 *  read without knowing there is something to hover over. */
const noTooltips = (html: string) => html.replace(/title="[^"]*"/g, "");
const count = (html: string, needle: string) => html.split(needle).length - 1;

/* ── what a leg is joined to ──────────────────────────────────────────────── */

describe("the join is the directory, the way the server's is", () => {
  it("claims every checkout a run has a leg in", () => {
    expect([...legDirs([run({ legs: [leg(), adoptedLeg()] })])]).toEqual([CUT, MINE]);
  });

  it("takes the sessions running in that exact checkout, freshest first", () => {
    const here = [
      card({ key: "a", lastSeen: 10 }),
      card({ key: "b", lastSeen: 90 }),
      // A session in a subdirectory of the leg is NOT one of its sessions. The
      // server's own `cwd_path IN (…)` does not count it either, and a card
      // counted here that the bill does not count would put a row and a total
      // side by side that disagree.
      card({ key: "deep", cwd: `${CUT}/packages/importer` }),
      card({ key: "elsewhere", cwd: "/home/dev/orbit" }),
    ];
    expect(cardsIn(here, CUT).map((a) => a.key)).toEqual(["b", "a"]);
  });

  it("keeps the legs in the order the run recorded them", () => {
    // A comparison whose arms swap places when one gets ahead cannot be read
    // twice: the arm you were looking at is somewhere else now.
    const r = run({ legs: [leg(), adoptedLeg()] });
    const rows = laneRows(r, [act({ worktree: MINE, costUsd: 9 }), act()], []);
    expect(rows.map((x) => x.leg.worktree)).toEqual([CUT, MINE]);
    expect(rows[1]!.activity!.costUsd).toBe(9);
  });

  it("gives a leg nothing has been read for a null activity rather than a zero", () => {
    // Not the same as a leg that produced nothing, and the lane says which.
    expect(laneRows(run(), [], []).map((r) => r.activity)).toEqual([null]);
  });
});

/* ── the leg the app started ──────────────────────────────────────────────── */

describe("a leg the app cut", () => {
  it("names the run by its prompt and the leg by its branch and its agent", async () => {
    answer = () => ({ ok: true, run: run(), legs: [act()] });
    await refreshActivity("8f2a1c");
    const html = lane(run());
    expect(html).toContain("teach the importer to read CRLF files");
    expect(html).toContain("run-8f2a1c-claude-code");
    // The vendor is the one fact a run exists to compare, so it is on the leg
    // itself and not only inside whatever session card happens to be under it.
    expect(html).toContain("claude-code");
    expect(html).toContain("$0.31");
  });

  it("is drawn with the solid mark and no dotted enclosure anywhere", () => {
    const html = lane(run());
    expect(html).toContain('x="2.6"');          // the filled square
    expect(html).not.toContain("M6 1.6 10.4 6"); // the hollow diamond
    expect(html).not.toContain("dashed");
  });

  it("and no adoption caption, because there is nothing to explain", () => {
    expect(lane(run())).not.toContain("never torn down");
  });

  it("says which of the two silences it is when no session card is under it", () => {
    // Zero and unknown look identical on screen unless one of them is spelled
    // out. The wording is the server's own: an agent mid-turn, or a vendor
    // whose events this machine does not collect.
    expect(lane(run())).toContain("nothing recorded here yet");
  });

  it("draws the session Fleet would have drawn, rather than a second kind of row", () => {
    const html = lane(run(), [card()]);
    expect(html).toContain("reading the import fixtures");
  });
});

/* ── the leg the user started ─────────────────────────────────────────────── */

describe("the adopted leg is obviously not one of ours", () => {
  const mixed = run({ legs: [leg(), adoptedLeg()] });

  it("carries a shape no other row in this panel has", () => {
    const html = lane(mixed);
    expect(html).toContain("M6 1.6 10.4 6 6 10.4 1.6 6Z");
  });

  it("and is enclosed in a dotted border, which is a difference in form, not hue", () => {
    // The panel already proved colour alone cannot carry a distinction — every
    // status here has its own silhouette for that reason. This one is a shape
    // and an outline before it is a blue.
    expect(lane(mixed)).toContain("dashed");
    expect(lane(run())).not.toContain("dashed");
  });

  it("says the word on the row itself", () => {
    expect(noTooltips(lane(mixed))).toContain("adopted");
  });

  it("and answers 'what does that mean' where somebody who just asked is looking", () => {
    // Not in a `title`: the caption sits under the lane heading, above the leg
    // it describes, and only when the lane has one.
    const plain = noTooltips(lane(mixed));
    expect(plain).toContain("a pane you started yourself");
    expect(plain).toContain("this app never cut");
    expect(plain).toContain("never torn down");
    expect(noTooltips(lane(run()))).not.toContain("a pane you started yourself");
  });

  it("keeps its own branch name, detached or not", () => {
    expect(lane(mixed)).toContain("(detached)");
  });

  it("is counted in the run's heading as what it is", () => {
    expect(lane(mixed)).toContain("1 adopted");
    expect(lane(mixed)).toContain("2 legs");
  });

  it("prints 'unknown agent' rather than guessing when nothing could tell", () => {
    // An empty `agent` is honest and a guess would make the run claim a vendor
    // comparison it never made.
    expect(lane(run({ legs: [adoptedLeg({ agent: "" })] }))).toContain("unknown agent");
  });

  it("stays on the wall after somebody deletes the checkout by hand", async () => {
    answer = () => ({ ok: true, run: mixed, legs: [act(), act({ worktree: MINE, state: "gone" })] });
    await refreshActivity("8f2a1c");
    const html = lane(run({ legs: [leg(), adoptedLeg({ state: "gone" })] }));
    expect(html).toContain("gone");
    // Still two legs. A comparison that quietly loses one of the things being
    // compared is worse than useless.
    expect(html).toContain("2 legs");
  });
});

/* ── two vendors in one run ───────────────────────────────────────────────── */

describe("what a heterogeneous run cost", () => {
  const twoVendors = [
    act({ providers: [{ provider: "Anthropic", events: 42, costUsd: 0.31 }] }),
    act({ worktree: MINE, agent: "codex", origin: "adopted", costUsd: 1.4, events: 88,
      providers: [{ provider: "OpenAI", events: 88, costUsd: 1.4 }] }),
  ];

  it("folds the legs' bills the way the server's runSpend does — dearest first", () => {
    expect(laneSpend(twoVendors)).toEqual([
      { provider: "OpenAI", events: 88, costUsd: 1.4 },
      { provider: "Anthropic", events: 42, costUsd: 0.31 },
    ]);
  });

  it("adds a vendor's rows together across legs, and breaks ties on the event count", () => {
    const split = [
      act({ providers: [{ provider: "OpenAI", events: 1, costUsd: 0.5 }, { provider: "Anthropic", events: 9, costUsd: 0.5 }] }),
      act({ worktree: MINE, providers: [{ provider: "OpenAI", events: 2, costUsd: 0 }] }),
    ];
    expect(laneSpend(split)).toEqual([
      { provider: "Anthropic", events: 9, costUsd: 0.5 },
      { provider: "OpenAI", events: 3, costUsd: 0.5 },
    ]);
  });

  it("keeps the unresolved model as a line rather than dropping it", () => {
    // A bill whose vendor rows add up to less than the total is a
    // reconciliation failure. "Unknown" is a value here, not a gap.
    const rows = laneSpend([act({ providers: [{ provider: "unknown", events: 3, costUsd: 0.02 }] })]);
    expect(rows).toEqual([{ provider: "unknown", events: 3, costUsd: 0.02 }]);
  });

  it("puts both vendors on the lane, with the money beside each", async () => {
    answer = () => ({ ok: true, run: run({ legs: [leg(), adoptedLeg()] }), legs: twoVendors });
    await refreshActivity("8f2a1c");
    const html = lane(run({ legs: [leg(), adoptedLeg()] }));
    expect(html).toContain("OpenAI");
    expect(html).toContain("Anthropic");
    expect(html).toContain("$1.40");
    expect(html).toContain("$0.31");
    // And the run's own total is the same rows added one level higher.
    expect(html).toContain("$1.71");
  });

  it("says nothing about vendors when there is only one", async () => {
    // One line saying Anthropic spent everything is the fact the total already
    // carries, and a run with one vendor is not a vendor comparison.
    answer = () => ({ ok: true, run: run(), legs: [act()] });
    await refreshActivity("8f2a1c");
    expect(lane(run())).not.toContain("Anthropic");
  });
});

/* ── nobody has ever started one ──────────────────────────────────────────── */

describe("day one", () => {
  it("draws nothing at all rather than an empty box with a heading", () => {
    // The third option — a sentence saying what a run is and how to start one —
    // is the one worth having and cannot be written honestly yet: nothing in
    // this app starts a run. It belongs beside the control that does.
    expect(draw(React.createElement(RunLanes, { runs: [], cards: [], renderCard: () => null }))).toBe("");
  });

  it("leaves Fleet exactly as it was, waiting for agents", () => {
    const html = draw(React.createElement(Fleet, { agents: [] }));
    expect(html).toContain("Waiting for agents…");
    expect(html).not.toContain("Run");
  });
});

/* ── the lane and the project groups are one list ─────────────────────────── */

describe("a lane takes rows out of the projects below it", () => {
  it("draws a leg's session once, in the run, and not again under its project", async () => {
    answer = () => ({ runs: [run({ legs: [leg(), adoptedLeg()] })] });
    await refreshRuns("");
    const html = draw(React.createElement(Fleet, { agents: [card()] }));
    // One agent, one row. Two would be one session that looks like two, moving
    // in step, and a person counting the wall would count it twice. Counted
    // with the tooltips stripped, because a session card carries its own title
    // twice on purpose — once to read, once to hover.
    expect(count(noTooltips(html), "reading the import fixtures")).toBe(1);
    expect(html).toContain("teach the importer to read CRLF files");
    // And the summary says why the project count dropped.
    expect(html).toContain("1 run");
  });

  it("leaves a session that is not a leg where it was", async () => {
    answer = () => ({ runs: [run()] });
    await refreshRuns("");
    const html = draw(React.createElement(Fleet, { agents: [card({ key: "free", cwd: "/home/dev/orbit", title: "unrelated session" })] }));
    expect(html).toContain("unrelated session");
    expect(html).toContain("orbit");
  });

  it("does not claim a session whose directory is not known", async () => {
    // `cwd` is null for a session that never reported one. Treating null as a
    // match would empty the wall the moment any run existed.
    answer = () => ({ runs: [run()] });
    await refreshRuns("");
    const html = draw(React.createElement(Fleet, { agents: [card({ cwd: null, title: "no cwd at all" })] }));
    expect(html).toContain("no cwd at all");
  });
});

/*
 * The client half of a run, against fixture answers from the server.
 *
 * A run is one prompt tried in several checkouts, and the reason this exists at
 * all is the ADOPTED leg — a pane the user opened themselves, in a worktree
 * this app never cut, tracked in the same run as the ones it did. Everything
 * below is written so that leg cannot quietly disappear: `origin` travels with
 * every leg, a leg going `gone` counts as a change worth redrawing, and a run
 * that was finished from another window is told apart from a server that is not
 * answering, because those are two different things to put on a screen.
 *
 * Everything is exercised through a stubbed `fetch` rather than a stubbed
 * `api`, so the fixtures here are the bodies the routes in server/src/index.ts
 * actually return — including the failure bodies, which is where the shapes
 * differ and where a client that assumed the happy one falls over.
 */
import { describe, expect, it, beforeEach, afterAll } from "bun:test";

/* A module-level store in a one-process suite: a watcher the previous FILE
   forgot to stop is still subscribed when this one starts, and its reads land
   in these counters. See __resetRunStore. */
beforeEach(() => { __resetRunStore(); });


const { api } = await import("../src/lib/api.ts");
const { gitChanged } = await import("../src/lib/gitBus.ts");
const {
  runsDiffer, activityDiffers, runsOf, runOf, activityOf,
  refreshRuns, refreshActivity, watchRuns, forgetRuns, __resetRunStore,
} = await import("../src/lib/runStore.ts");
import type { Run, RunLeg, LegActivity } from "../src/lib/api.ts";

/* ── the fixtures ─────────────────────────────────────────────────────────── */

const leg = (over: Partial<RunLeg> = {}): RunLeg => ({
  worktree: "/home/dev/orbit-run-8f2a1c-claude",
  branch: "run-8f2a1c-claude",
  agent: "claude",
  paneId: "%41",
  state: "running",
  origin: "spawned",
  startedAt: 1_700_000_000_000,
  ...over,
});

/** The pane the user started by hand. Note what is different about it and what
 *  is not: same shape, same run, `origin: "adopted"` — and a branch git calls
 *  `(detached)`, because nobody promised it would be on one. */
const adopted = (over: Partial<RunLeg> = {}): RunLeg =>
  leg({ worktree: "/home/dev/orbit-scratch", branch: "(detached)", agent: "codex", paneId: "%7", origin: "adopted", ...over });

const run = (over: Partial<Run> = {}): Run => ({
  id: "8f2a1c",
  root: "/home/dev/orbit",
  prompt: "make the checkout rail keyboard reachable",
  legs: [leg(), adopted()],
  startedAt: 1_700_000_000_000,
  ...over,
});

const activityRow = (over: Partial<LegActivity> = {}): LegActivity => ({
  worktree: "/home/dev/orbit-run-8f2a1c-claude",
  branch: "run-8f2a1c-claude",
  agent: "claude",
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

/* ── the stub ─────────────────────────────────────────────────────────────── */

type Answer = { status: number; body: unknown; text?: string };
const seen: { url: string; method: string; body: unknown }[] = [];
let answer: (url: string) => Answer = () => ({ status: 200, body: { runs: [] } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  /*
   * ONLY THIS FILE'S OWN READS.
   *
   * It counted every request the process made, which is fine until something
   * else in the suite is still polling — and something is: a `gateStore` tick
   * that another test file starts and nothing stops outlives it, and its
   * /gate/pending lands here. The count then said "it kept listening after the
   * last watcher let go" about a read that belonged to a different module
   * entirely. Measured with a stack on every read, after two wrong guesses.
   *
   * A test that counts other people's work is not measuring what it claims to.
   */
  if (url.includes("/runs") || url.includes("/run/")) {
    seen.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
  }
  const a = answer(url);
  // `text` is the escape hatch for the answer that is not JSON at all — a proxy
  // or an older build serving an HTML 404 to a route it has never heard of.
  const payload = a.text ?? JSON.stringify(a.body);
  return new Response(payload, { status: a.status, headers: { "content-type": a.text ? "text/html" : "application/json" } });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

const pathOf = (url: string) => url.slice(url.indexOf("/", url.indexOf("//") + 2));
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
/** Wait for something to become true, up to a deadline — for the assertions
 *  that are about WHAT happened rather than when. */
const until = async (done: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await settle(25);
};

beforeEach(() => { seen.length = 0; forgetRuns(); answer = () => ({ status: 200, body: { runs: [] } }); });

/* ── the list ─────────────────────────────────────────────────────────────── */

describe("asking for the runs", () => {
  it("answers with an empty list on day one, which is what everybody sees first", async () => {
    answer = () => ({ status: 200, body: { runs: [] } });
    expect((await api.runs("/home/dev/orbit")).runs).toEqual([]);
  });

  it("names the repository, encoded, the way every other route on this client does", async () => {
    await api.runs("/home/dev/my repo");
    expect(pathOf(seen[0]!.url)).toBe("/runs?root=%2Fhome%2Fdev%2Fmy%20repo");
  });

  it("brings the adopted leg back marked as one", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    const r = await api.runs("/home/dev/orbit");
    expect(r.runs[0]!.legs.map((l) => l.origin)).toEqual(["spawned", "adopted"]);
  });

  it("throws on a server that has never heard of the route", async () => {
    /* An older build answers a JSON 404 from its catch-all — `{error:"not
       found"}`, with no `runs` in it. Reaching into that for `.runs` would hand
       the panel `undefined` and it would fail somewhere else entirely, so `get`
       refuses at the status, as it does for every other read here. */
    answer = () => ({ status: 404, body: { error: "not found" } });
    await expect(api.runs("/home/dev/orbit")).rejects.toThrow("404");
  });
});

/* ── what a leg produced ──────────────────────────────────────────────────── */

describe("asking what each leg produced", () => {
  it("returns the run and its legs", async () => {
    answer = () => ({ status: 200, body: { ok: true, run: run(), legs: [activityRow()] } });
    const r = await api.runActivity("8f2a1c");
    expect(r.ok).toBe(true);
    expect(r.legs[0]!.costUsd).toBe(0.31);
    expect(r.run!.id).toBe("8f2a1c");
  });

  it("keeps a leg's two vendors apart instead of totalling them", async () => {
    /* The reason the bill is asked for per event rather than per session: a
       session that ran one model and then another would otherwise file all of
       its money under whichever was seen first, and a run exists precisely to
       compare vendors. */
    answer = () => ({
      status: 200,
      body: { ok: true, run: run(), legs: [activityRow({
        providers: [{ provider: "Anthropic", events: 30, costUsd: 0.20 }, { provider: "OpenAI", events: 12, costUsd: 0.11 }],
      })] },
    });
    const r = await api.runActivity("8f2a1c");
    expect(r.legs[0]!.providers.map((p) => p.provider)).toEqual(["Anthropic", "OpenAI"]);
  });

  it("reports a run that no longer exists in the server's own words", async () => {
    /* The route answers 404 with a body, and the body is the useful half: a run
       finished from another window is over, which is a different sentence to
       put on screen than "the server is not answering". */
    answer = () => ({ status: 404, body: { ok: false, error: "no such run" } });
    const r = await api.runActivity("deadbe");
    expect(r).toEqual({ ok: false, legs: [], error: "no such run" });
  });

  it("falls back to the status when the 404 carries no body it can read", async () => {
    answer = () => ({ status: 404, body: null, text: "<html>not found</html>" });
    const r = await api.runActivity("8f2a1c");
    expect(r.ok).toBe(false);
    expect(r.legs).toEqual([]);
    expect(r.error).toContain("404");
  });

  it("does not throw when the server is not there at all", async () => {
    answer = () => { throw new Error("connection refused"); };
    const r = await api.runActivity("8f2a1c");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("connection refused");
  });

  it("always hands back a list, so nothing has to null-check it", async () => {
    answer = () => ({ status: 200, body: { ok: true, run: run() } });
    expect((await api.runActivity("8f2a1c")).legs).toEqual([]);
  });
});

/* ── the writes ───────────────────────────────────────────────────────────── */

describe("starting, adopting, calling it", () => {
  it("sends the prompt and the legs the server expects", async () => {
    answer = () => ({ status: 200, body: { ok: true, run: run() } });
    await api.runStart("/home/dev/orbit", "try this two ways", [{ agent: "claude" }, { agent: "codex", from: "main" }]);
    expect(seen[0]!.method).toBe("POST");
    expect(pathOf(seen[0]!.url)).toBe("/run/start");
    expect(seen[0]!.body).toEqual({
      root: "/home/dev/orbit",
      prompt: "try this two ways",
      legs: [{ agent: "claude" }, { agent: "codex", from: "main" }],
    });
  });

  it("passes a refusal through as a reason rather than an exception", async () => {
    // The route answers 400 with the shape the caller wanted, so `post` reads
    // the body instead of the status — the same way every other write here does.
    answer = () => ({ status: 400, body: { ok: false, error: "a run needs something to ask" } });
    const r = await api.runStart("/home/dev/orbit", "", [{ agent: "claude" }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("a run needs something to ask");
  });

  it("survives the terminal being switched off", async () => {
    answer = () => ({ status: 403, body: { ok: false, error: "the terminal is disabled here" } });
    expect((await api.runStart("/home/dev/orbit", "go", [{ agent: "claude" }])).error).toBe("the terminal is disabled here");
  });

  it("hands back the leg it just adopted", async () => {
    answer = () => ({ status: 200, body: { ok: true, run: run(), leg: adopted() } });
    const r = await api.runAdopt("8f2a1c", "%7", "codex");
    expect(seen[0]!.body).toEqual({ id: "8f2a1c", pane: "%7", agent: "codex" });
    expect(r.leg!.origin).toBe("adopted");
  });

  it("treats a second press on the same pane as the reassurance it is", async () => {
    answer = () => ({ status: 200, body: { ok: true, run: run(), leg: adopted(), detail: "that pane is already in this run" } });
    const r = await api.runAdopt("8f2a1c", "%7", "");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("already in this run");
  });

  it("carries the dirty checkouts a teardown refused over", async () => {
    answer = () => ({ status: 400, body: { ok: false, error: "uncommitted work", dirty: ["orbit-run-8f2a1c-codex (3)"] } });
    const r = await api.runFinish("8f2a1c", "/home/dev/orbit-run-8f2a1c-claude");
    expect(seen[0]!.body).toEqual({ id: "8f2a1c", winner: "/home/dev/orbit-run-8f2a1c-claude", force: false });
    expect(r.dirty).toEqual(["orbit-run-8f2a1c-codex (3)"]);
  });
});

/* ── noticing that something moved ────────────────────────────────────────── */

describe("deciding a redraw is worth it", () => {
  it("says nothing changed when nothing did, so an open lane stays still", () => {
    expect(runsDiffer([run()], [run()])).toBe(false);
  });

  it("sees a leg whose worktree somebody deleted by hand", () => {
    // The change no event on the socket announces, and the one the list must
    // still notice: the run keeps the same id and the same number of legs.
    const before = [run()];
    const after = [run({ legs: [leg({ state: "gone" }), adopted()] })];
    expect(runsDiffer(before, after)).toBe(true);
  });

  it("sees a pane being adopted into a run", () => {
    const before = [run({ legs: [leg()] })];
    const after = [run({ legs: [leg(), adopted()] })];
    expect(runsDiffer(before, after)).toBe(true);
  });

  it("sees one more turn out of a leg even when the money rounds the same", () => {
    const before = [activityRow({ events: 42, lastSeen: 1_700_000_100_000 })];
    const after = [activityRow({ events: 43, lastSeen: 1_700_000_200_000 })];
    expect(activityDiffers(before, after)).toBe(true);
  });

  it("sees a leg change vendor mid-run", () => {
    const before = [activityRow({ providers: [{ provider: "Anthropic", events: 42, costUsd: 0.31 }] })];
    const after = [activityRow({ providers: [{ provider: "OpenAI", events: 42, costUsd: 0.31 }] })];
    expect(activityDiffers(before, after)).toBe(true);
  });
});

/* ── staying current ──────────────────────────────────────────────────────── */

describe("keeping the list current", () => {
  it("has an empty list and no error before anything has been asked", () => {
    expect(runsOf("/home/dev/orbit")).toEqual({ runs: [], loading: true, error: null });
  });

  it("re-reads when the server says a repository mutated", async () => {
    /* The whole of (b): starting or finishing a run cuts or removes worktrees,
       every one of those goes through the server's git layer, and that layer
       already broadcasts on the socket this client is holding. No interval of
       our own is what keeps the list fresh — this is. */
    answer = () => ({ status: 200, body: { runs: [run()] } });
    const stop = watchRuns("/home/dev/orbit");

    /* Waits for the FACT, not for a length of time. The subscribe read and the
       debounced one are both real timers; asserting on whatever has happened
       after a fixed sleep passes on an idle machine and fails inside the full
       suite, which teaches nobody anything. */
    const waitFor = async (n: number, what: string) => {
      const deadline = Date.now() + 5000;
      while (seen.length < n && Date.now() < deadline) await settle(25);
      expect(seen.length, what).toBe(n);
    };
    await waitFor(1, "the subscribe read never happened");

    gitChanged();
    await waitFor(2, "a git broadcast did not re-read the list");
    stop();
  });

  it("coalesces the eight mutations that cutting an eight-leg run fires", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    const stop = watchRuns("/home/dev/orbit");

    /*
     * Wait for the SUBSCRIBE read to land before zeroing the counter.
     *
     * watchRuns reads once on subscribe. Clearing `seen` after a fixed sleep
     * assumes that read has already finished, which is true on an idle machine
     * and false inside the full suite — the read then lands after the reset and
     * is counted alongside the debounced one, so eight events appear to have
     * caused two reads. The count was right; the starting line was wrong.
     */
    const subscribed = Date.now() + 5000;
    while (seen.length === 0 && Date.now() < subscribed) await settle(25);
    expect(seen.length, "the subscribe read never happened").toBe(1);
    seen.length = 0;

    for (let i = 0; i < 8; i++) gitChanged();

    /*
     * Wait for the FACT, not for a length of time.
     *
     * This slept 400ms and asserted on whatever had happened by then, which
     * held on an idle machine and went red inside the full suite: the debounce
     * is a real 250ms timer, and under load it can land past an arbitrary
     * deadline. A test that fails because the machine was busy teaches nobody
     * anything, and this repository has already retired two suites for it.
     *
     * So: wait until the read has happened, then keep waiting to prove no
     * SECOND one follows. The second half is the actual claim — one read out of
     * eight events — and it is the half a sleep can only ever guess at.
     */
    const deadline = Date.now() + 5000;
    while (seen.length === 0 && Date.now() < deadline) await settle(25);
    expect(seen.length, "the debounced read never happened").toBeGreaterThan(0);
    await settle(400);

    /*
     * Eight events, at most two reads — and two is a legitimate answer, which
     * an earlier version of this test denied.
     *
     * The settle timer collapses a burst into one read. A second can still be
     * honest: refreshRuns also refuses to start while one is in flight, and
     * whether that guard catches the trailing read depends on whether the first
     * request finished between two of the eight events. On an idle machine it
     * has not, and the count is one; inside the full suite it often has, and the
     * count is two. Both are the debounce working.
     *
     * So the claim is the one that is actually true and actually matters: a
     * burst of events does not become a burst of requests. Pinning the literal 1
     * pinned the speed of the machine, which is why it went red under load and
     * green alone.
     */
    expect(seen.length, "eight events were not coalesced — this is one read per event").toBeLessThanOrEqual(2);
    stop();
  });

  it("asks once however many places are watching the same repository", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    const a = watchRuns("/home/dev/orbit");
    const b = watchRuns("/home/dev/orbit");
    await settle();
    expect(seen.length).toBe(1);
    a(); b();
  });

  it("stops listening once the last watcher lets go", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    const a = watchRuns("/home/dev/orbit");
    const b = watchRuns("/home/dev/orbit");
    await settle();
    a();
    gitChanged();
    /*
     * Wait for the read to HAPPEN, not for a stopwatch. The refresh is on a
     * 250ms settle and this waited 400ms flat, which is 150ms of headroom —
     * and in the full suite this file shares an event loop that other files
     * block for as long as 3.3 SECONDS. The read then landed during the next
     * phase and was counted there, so the failure read as "it kept listening
     * after the last watcher let go" when nothing of the sort had happened.
     * It only ever failed in the full run, which is the worst place to debug
     * it and the only place it was visible.
     */
    await until(() => seen.length === 2);
    expect(seen.length).toBe(2); // still watched by `b`

    b();
    gitChanged();
    /* Here the stopwatch IS the test: nothing should arrive, and the only way
       to find that out is to give it time and look. Generous, because a false
       pass costs nothing and a false failure costs an afternoon. */
    await settle(800);
    expect(seen.length).toBe(2); // nobody is looking any more
  });

  it("keeps what is on screen when a read fails, and says why beside it", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    await refreshRuns("/home/dev/orbit");
    expect(runsOf("/home/dev/orbit").runs).toHaveLength(1);

    answer = () => { throw new Error("connection refused"); };
    await refreshRuns("/home/dev/orbit");
    const st = runsOf("/home/dev/orbit");
    // Blanking a list somebody is reading in order to say "loading" is worse
    // than a second of staleness — so the runs stay and the error joins them.
    expect(st.runs).toHaveLength(1);
    expect(st.error).toContain("connection refused");
    expect(st.loading).toBe(false);
  });

  it("hands back the same array when nothing moved, so nothing re-renders", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    await refreshRuns("/home/dev/orbit");
    const first = runsOf("/home/dev/orbit").runs;
    await refreshRuns("/home/dev/orbit");
    expect(runsOf("/home/dev/orbit").runs).toBe(first);
  });

  it("finds one run out of the list by id, and nothing for an id that is gone", async () => {
    answer = () => ({ status: 200, body: { runs: [run()] } });
    await refreshRuns("/home/dev/orbit");
    expect(runOf("/home/dev/orbit", "8f2a1c")!.legs).toHaveLength(2);
    expect(runOf("/home/dev/orbit", "deadbe")).toBeNull();
  });
});

describe("keeping one run's activity current", () => {
  it("records what came back", async () => {
    answer = () => ({ status: 200, body: { ok: true, run: run(), legs: [activityRow()] } });
    await refreshActivity("8f2a1c");
    expect(activityOf("8f2a1c").legs).toHaveLength(1);
    expect(activityOf("8f2a1c").error).toBeNull();
  });

  it("shows the reason when the run was finished from another window", async () => {
    answer = () => ({ status: 404, body: { ok: false, error: "no such run" } });
    await refreshActivity("8f2a1c");
    expect(activityOf("8f2a1c")).toEqual({ legs: [], loading: false, error: "no such run" });
  });
});

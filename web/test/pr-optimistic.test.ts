/*
 * The cheap writes on a pull request are drawn on the press, not after GitHub.
 *
 * The emoji, the ticked box in the description, a resolved thread and a label
 * each waited for the write AND a re-read of the whole list before the screen
 * moved, so the button sat unpressed behind "Loading pull requests…". What is
 * pinned here: the change shows before the write answers, a refusal takes it
 * back and says so, and a read that was already in flight — which answers with
 * the pull request as it was — does not flip it back. A read that began after
 * the write finished is GitHub's word and is believed.
 *
 * No network: every `send` is a promise the test resolves by hand.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { PrDetail } from "../../shared/types.ts";
import { Optimistic, reactionPatch, bodyPatch, resolvedPatch, labelsPatch, type Sent } from "../src/lib/prOptimistic.ts";

/** A write whose answer the test gives. */
function deferred() {
  let resolve!: (r: Sent) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Sent>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function host() {
  const fails: string[] = [];
  let changes = 0;
  return { fails, get changes() { return changes; }, h: { onChange: () => { changes++; }, onFail: (t: string) => { fails.push(t); } } };
}

/** A pull request the shape the server returns, cut to what these writes touch. */
function pr(over: Partial<PrDetail> = {}): PrDetail {
  return {
    number: 1042,
    nodeId: "PR_body",
    body: "- [ ] tests\n- [ ] docs",
    checklist: [{ checked: false, text: "tests" }, { checked: false, text: "docs" }],
    bodyReactions: [],
    labels: [{ name: "backend", color: "0e8a16" }],
    comments: [{ id: 1, nodeId: "IC_1", author: "ada", isBot: false, body: "lgtm", createdAt: "2026-01-01T00:00:00Z",
      reactions: [{ content: "THUMBS_UP", count: 2, viewerHasReacted: false }] }],
    reviews: [{ author: "lin", isBot: false, state: "COMMENTED", body: "", submittedAt: "2026-01-01T00:00:00Z", nodeId: "PRR_1" }],
    threads: [{ id: "PRRT_1", path: "src/app.ts", line: 3, isResolved: false, isOutdated: false,
      comments: [{ id: "PRRC_1", author: "lin", isBot: false, body: "nit", createdAt: "2026-01-01T00:00:00Z" }] }],
    ...over,
  } as unknown as PrDetail;
}

describe("the layer", () => {
  it("draws the change before the write answers", () => {
    const o = new Optimistic<number>(host().h);
    const w = deferred();
    void o.run({ patch: (n) => n + 1, send: () => w.promise, failText: "no" });
    expect(o.view(10)).toBe(11);
  });

  it("keeps it when the write lands", async () => {
    const o = new Optimistic<number>(host().h);
    const w = deferred();
    const done = o.run({ patch: (n) => n + 1, send: () => w.promise, failText: "no" });
    w.resolve({ ok: true });
    expect(await done).toBe(true);
    expect(o.view(10)).toBe(11);
  });

  it("takes it back and says so when the write is refused", async () => {
    const x = host();
    const o = new Optimistic<number>(x.h);
    const w = deferred();
    const done = o.run({ patch: (n) => n + 1, send: () => w.promise, failText: "Reaction failed" });
    w.resolve({ ok: false, error: "rate limited" });
    expect(await done).toBe(false);
    expect(o.view(10)).toBe(10);
    expect(x.fails).toEqual(["Reaction failed: rate limited"]);
  });

  it("takes it back when the write throws", async () => {
    const x = host();
    const o = new Optimistic<number>(x.h);
    const w = deferred();
    const done = o.run({ patch: (n) => n + 1, send: () => w.promise, failText: "Resolve failed" });
    w.reject(new Error("socket hang up"));
    expect(await done).toBe(false);
    expect(o.size).toBe(0);
    expect(x.fails).toHaveLength(1);
    expect(x.fails[0]).toContain("Resolve failed");
  });

  it("is not undone by a read that was already in flight", async () => {
    // The race the whole file is for: the poll went out, the press happened,
    // the write landed, THEN the poll answered — with the old value.
    const o = new Optimistic<number>(host().h);
    const ticket = o.readStarted();
    const w = deferred();
    const done = o.run({ patch: () => 1, send: () => w.promise, failText: "no" });
    w.resolve({ ok: true });
    await done;
    o.readLanded(ticket);
    expect(o.view(0)).toBe(1);
  });

  it("is not undone by a read that lands while the write is still out", () => {
    const o = new Optimistic<number>(host().h);
    void o.run({ patch: () => 1, send: () => deferred().promise, failText: "no" });
    o.readLanded(o.readStarted());
    expect(o.view(0)).toBe(1);
  });

  it("gives way to a read that began after the write landed", async () => {
    const o = new Optimistic<number>(host().h);
    const w = deferred();
    const done = o.run({ patch: () => 1, send: () => w.promise, failText: "no" });
    w.resolve({ ok: true });
    await done;
    o.readLanded(o.readStarted());
    expect(o.size).toBe(0);
    // Whatever GitHub now says is what shows, even if it is not our value.
    expect(o.view(7)).toBe(7);
  });

  it("does not give way to a later read the server answered from cache", async () => {
    const o = new Optimistic<number>(host().h);
    const w = deferred();
    const done = o.run({ patch: () => 1, send: () => w.promise, failText: "no" });
    w.resolve({ ok: true });
    await done;
    o.readLanded(o.readStarted(), { stale: true });
    expect(o.view(0)).toBe(1);
  });

  it("sends writes that share a lane in order", async () => {
    const o = new Optimistic<string>(host().h);
    const order: string[] = [];
    const a = deferred();
    const first = o.run({ patch: (s) => s + "a", send: () => { order.push("a"); return a.promise; }, failText: "no", lane: "body" });
    const second = o.run({ patch: (s) => s + "b", send: () => { order.push("b"); return Promise.resolve({ ok: true }); }, failText: "no", lane: "body" });
    await tick();
    expect(order).toEqual(["a"]);
    expect(o.view("")).toBe("ab");
    a.resolve({ ok: true });
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("each write's patch", () => {
  it("presses an emoji on a comment, and lets it go", () => {
    const on = reactionPatch("IC_1", "THUMBS_UP", true)(pr());
    expect(on.comments[0]!.reactions).toEqual([{ content: "THUMBS_UP", count: 3, viewerHasReacted: true }]);
    const off = reactionPatch("IC_1", "THUMBS_UP", false)(on);
    expect(off.comments[0]!.reactions).toEqual([{ content: "THUMBS_UP", count: 2, viewerHasReacted: false }]);
  });

  it("sets rather than flips, so drawing it over GitHub's own answer changes nothing", () => {
    const once = reactionPatch("IC_1", "THUMBS_UP", true)(pr());
    expect(reactionPatch("IC_1", "THUMBS_UP", true)(once)).toEqual(once);
  });

  it("adds a new emoji to the body, a review and a line comment by their node ids", () => {
    const d = [
      reactionPatch("PR_body", "ROCKET", true),
      reactionPatch("PRR_1", "EYES", true),
      reactionPatch("PRRC_1", "HEART", true),
    ].reduce((t, p) => p(t), pr());
    expect(d.bodyReactions).toEqual([{ content: "ROCKET", count: 1, viewerHasReacted: true }]);
    expect(d.reviews[0]!.reactions).toEqual([{ content: "EYES", count: 1, viewerHasReacted: true }]);
    expect(d.threads[0]!.comments[0]!.reactions).toEqual([{ content: "HEART", count: 1, viewerHasReacted: true }]);
    // And taking your only one off drops the tally, as GitHub does.
    expect(reactionPatch("PR_body", "ROCKET", false)(d).bodyReactions).toEqual([]);
  });

  it("ticks the description and moves the checklist with it", () => {
    const d = bodyPatch(1042, "- [x] tests\n- [ ] docs", [{ checked: true, text: "tests" }, { checked: false, text: "docs" }])(pr());
    expect(d.body).toBe("- [x] tests\n- [ ] docs");
    expect(d.checklist[0]!.checked).toBe(true);
    // Never onto a different pull request that happens to be open by then.
    expect(bodyPatch(7, "x", [])(pr()).body).toBe(pr().body);
  });

  it("resolves and unresolves a thread", () => {
    const r = resolvedPatch("PRRT_1", true)(pr());
    expect(r.threads[0]!.isResolved).toBe(true);
    expect(resolvedPatch("PRRT_1", false)(r).threads[0]!.isResolved).toBe(false);
  });

  it("puts labels on and takes them off, keeping the picker's colour", () => {
    const d = labelsPatch(1042, ["urgent"], ["backend"], { urgent: "d93f0b" })(pr());
    expect(d.labels).toEqual([{ name: "urgent", color: "d93f0b" }]);
    expect(labelsPatch(1042, ["urgent"], [])(d).labels).toHaveLength(1);
    expect(labelsPatch(7, ["urgent"], [])(pr()).labels).toEqual(pr().labels);
  });
});

describe("wired end to end with a stubbed write", () => {
  it("a refused reaction comes back off the comment", async () => {
    const x = host();
    const o = new Optimistic<PrDetail>(x.h);
    const w = deferred();
    const done = o.run({ patch: reactionPatch("IC_1", "THUMBS_UP", true), send: () => w.promise, failText: "Reaction failed" });
    expect(o.view(pr()).comments[0]!.reactions![0]!.viewerHasReacted).toBe(true);
    w.resolve({ ok: false });
    await done;
    expect(o.view(pr()).comments[0]!.reactions![0]!.viewerHasReacted).toBe(false);
    expect(x.fails).toEqual(["Reaction failed"]);
  });

  it("a ticked box survives the poll that was out when it was ticked", async () => {
    const o = new Optimistic<PrDetail>(host().h);
    const poll = o.readStarted();
    const w = deferred();
    const done = o.run({ patch: bodyPatch(1042, "- [x] tests\n- [ ] docs", []), send: () => w.promise, failText: "no" });
    w.resolve({ ok: true });
    await done;
    o.readLanded(poll);
    expect(o.view(pr()).body).toBe("- [x] tests\n- [ ] docs");
  });
});

/* The panel's own wiring, asserted against source: there is no renderer here.
   Each of these used to go through `act`, which greys every button and waits
   for the write and two reads; none may again. */
const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
function body(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThanOrEqual(0);
  let depth = 0;
  // From the arrow, not the first brace: a default like `= {}` in the
  // parameters would otherwise be taken for the body.
  for (let i = src.indexOf("=> {", at) + 3; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  return "";
}
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the panel sends these through the layer", () => {
  for (const [head, patch] of [
    ["const doReact = (", "reactionPatch("],
    ["const doToggleTask = (", "bodyPatch("],
    ["const doResolve = (", "resolvedPatch("],
    ["const setLabels = (", "labelsPatch("],
  ] as const) {
    it(`${head.slice(6, -4)} is drawn on the press`, () => {
      const fn = code(body(panel, head));
      expect(fn).toContain(patch);
      expect(fn).toContain("cheap(");
      expect(fn).not.toContain("act(");
    });
  }

  it("the reads tell the layer when they began and when they landed", () => {
    const fn = code(body(panel, "const loadDetail = useCallback("));
    expect(fn).toContain("layers.readStarted()");
    expect(fn).toMatch(/layers\.readLanded\(ticket, \{ stale: !!r\.stale \}\)/);
  });

  it("the resolve buttons and the description's boxes are wired to them", () => {
    expect(panel.match(/onResolve=\{doResolve\}/g)?.length).toBe(2);
    expect(panel).toContain("onToggleTask={doToggleTask}");
    expect(panel).not.toMatch(/act\([^)]*prSetThreadResolved/);
    expect(panel).not.toMatch(/act\([^)]*prReactTo/);
  });
});

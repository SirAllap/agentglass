/*
 * One path for a mutation, from either view.
 *
 * A pull request mutated from its detail (close, reopen, arm or cancel
 * auto-merge) used to wait for a GitHub re-read before anything changed: the
 * detail kept saying Open and the board card kept sitting in its lane. These
 * outcomes are decided by the request itself, so they are drawn on the press as
 * a layer over the last server reading, the lists take the new state from the
 * same detail in the same tick, and neither a list read nor a detail read that
 * began before the mutation gets to undo it. A refusal takes the layer away.
 * No network: rows, details and the write are fed by hand.
 */
import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary } from "../../shared/types.ts";
import { dropLanded, holdEdits, overlayDetail, rowPatch, type EditLog } from "../src/lib/prRefresh.ts";
import { Optimistic, autoMergePatch, statePatch } from "../src/lib/prOptimistic.ts";

const row = (n: number, over: Partial<PrSummary> = {}): PrSummary => ({
  number: n, title: `ORBIT-1042 thing ${n}`, author: "ana", state: "OPEN", isDraft: false,
  headRefName: "ORBIT-1042-thing", baseRefName: "main", url: "", updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: "APPROVED", additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  reviewers: [], checksLoaded: true, mergeable: "MERGEABLE", ...over,
} as unknown as PrSummary);
const detail = (n: number, over: Partial<PrDetail> = {}) => ({ ...row(n), commits: [], ...over }) as unknown as PrDetail;
const host = { onChange: () => {}, onFail: () => {} };

describe("close and reopen", () => {
  it("the detail says Closed on the press, and the open board loses the card in the same tick", () => {
    const closed = statePatch(412, "CLOSED", "2026-01-02T10:00:00Z")(detail(412, { autoMerge: { enabledBy: "bo", method: "squash" } }));
    expect(closed.state).toBe("CLOSED");
    expect(closed.closedAt).toBe("2026-01-02T10:00:00Z");
    expect(closed.autoMerge).toBeNull();
    const rows = dropLanded(overlayDetail([row(412), row(413)], closed), new Map());
    expect(rows.map((r) => r.number)).toEqual([413]);
  });

  it("a list read that began before the close and still lists it as open does not bring it back", () => {
    const closed = statePatch(412, "CLOSED", "t")(detail(412));
    const log: EditLog = new Map([[412, { at: 1_000, patch: rowPatch(closed) }]]);
    const older = dropLanded(holdEdits([row(412), row(413)], log, 500, 1_200), new Map(), 1_200);
    expect(older.map((r) => r.number)).toEqual([413]);
  });

  it("a detail read that began before the close does not revert it; one after it wins", async () => {
    const layers = new Optimistic<PrDetail>(host);
    let release!: () => void;
    const sent = layers.run({ patch: statePatch(412, "CLOSED", "t"), send: () => new Promise((r) => { release = () => r({ ok: true }); }), failText: "x" });
    const readBefore = layers.readStarted();
    release();
    await sent;
    layers.readLanded(readBefore);
    expect(layers.view(detail(412)).state).toBe("CLOSED");
    layers.readLanded(layers.readStarted());
    expect(layers.size).toBe(0);
    expect(layers.view(detail(412, { state: "CLOSED" })).state).toBe("CLOSED");
  });

  it("a refusal takes it back and says so", async () => {
    const said: string[] = [];
    const layers = new Optimistic<PrDetail>({ onChange: () => {}, onFail: (t) => said.push(t) });
    await layers.run({ patch: statePatch(412, "CLOSED", "t"), send: async () => ({ ok: false, error: "no permission" }), failText: "Close failed" });
    expect(layers.view(detail(412)).state).toBe("OPEN");
    expect(said).toEqual(["Close failed: no permission"]);
  });

  it("reopening sets OPEN and clears the closed stamp", () => {
    const d = statePatch(412, "OPEN", "t")(detail(412, { state: "CLOSED", closedAt: "2026-01-02T10:00:00Z" }));
    expect(d.state).toBe("OPEN");
    expect(d.closedAt).toBeNull();
  });

  it("a patch for another pull request changes nothing", () => {
    const d = detail(413);
    expect(statePatch(412, "CLOSED", "t")(d)).toBe(d);
    expect(autoMergePatch(412, null)(d)).toBe(d);
  });
});

describe("auto-merge", () => {
  it("armed and cancelled are drawn on the press", () => {
    const armed = autoMergePatch(412, { enabledBy: "you", method: "merge" })(detail(412));
    expect(armed.autoMerge?.method).toBe("merge");
    expect(autoMergePatch(412, null)(armed).autoMerge).toBeNull();
  });
});

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the panel routes them through the one path", () => {
  it("close, reopen and both auto-merge writes go through field, not through a wait-and-refetch act", () => {
    expect(code).toMatch(/field\(statePatch\(detail\.number, reopen \? "OPEN" : "CLOSED"/);
    expect(code).toMatch(/field\(autoMergePatch\(detail\.number, \{ enabledBy/);
    expect(code).toMatch(/field\(autoMergePatch\(d\.number, null\)/);
    expect(code).not.toMatch(/act\("Auto-merge/);
    expect(code).not.toMatch(/act\(reopen \? "Reopen" : "Close"/);
  });
  it("the detail reaches the lists through the open filter, so a closed one leaves the board", () => {
    expect((code.match(/openLists\(overlayDetail\(cur, detail\)\)/g) ?? []).length).toBe(3);
  });
});

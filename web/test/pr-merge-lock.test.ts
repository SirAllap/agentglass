/*
 * A merge, once, and told to both views at once.
 *
 * Two things were measured on the detail: after the merge dialog was confirmed
 * nothing was locked (a second press could send a second request), and once the
 * merge landed the screen still read "Open / Ready to merge" until the
 * re-read came back, while the board kept the card in "ready to land" until its
 * own poll, about a minute. The state rules are pure and asserted directly; the
 * panel has no renderer here, so what it must do with them is asserted against
 * its source (comments stripped, each function sliced to its own closing brace).
 */
import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary } from "../../shared/types.ts";
import { once, dropLanded, holdEdits, landedDetail, LANDED_HOLD_MS, overlayDetail, rowPatch, staleOpen, type EditLog, type Landed } from "../src/lib/prRefresh.ts";

const row = (n: number, over: Partial<PrSummary> = {}): PrSummary => ({
  number: n, title: `ORBIT-1042 thing ${n}`, author: "ana", state: "OPEN", isDraft: false,
  headRefName: "ORBIT-1042-thing", baseRefName: "main", url: "", updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: "APPROVED", additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  reviewers: [], checksLoaded: true, mergeable: "MERGEABLE", ...over,
} as unknown as PrSummary);
const detail = (n: number, over: Partial<PrDetail> = {}) => ({ ...row(n), commits: [], ...over }) as unknown as PrDetail;

describe("success flips the state at once", () => {
  it("the detail becomes Merged with who and when, without a read", () => {
    const d = landedDetail(detail(412, { autoMerge: { enabledBy: "bo", method: "squash" } }), "2026-01-02T10:00:00Z", "ana");
    expect(d.state).toBe("MERGED");
    expect(d.mergedBy).toBe("ana");
    expect(d.mergedAt).toBe("2026-01-02T10:00:00Z");
    expect(d.autoMerge).toBeNull();
  });

  it("the board drops the card the moment the merge answers, and keeps the others", () => {
    const landed: Landed = new Map([[412, 1_000]]);
    const rows = dropLanded([row(412), row(413)], landed, 1_500);
    expect(rows.map((r) => r.number)).toEqual([413]);
  });

  it("a list read that began before the merge and still lists it does not bring it back", () => {
    const landed: Landed = new Map([[412, 1_000]]);
    const log: EditLog = new Map();
    const stale = dropLanded(holdEdits([row(412), row(413)], log, 500, 1_200), landed, 1_200);
    expect(stale.map((r) => r.number)).toEqual([413]);
  });

  it("a stale OPEN detail read is refused, a MERGED one is not", () => {
    const landed: Landed = new Map([[412, 1_000]]);
    expect(staleOpen(detail(412), landed, 2_000)).toBe(true);
    expect(staleOpen(detail(412, { state: "MERGED" }), landed, 2_000)).toBe(false);
    expect(staleOpen(detail(413), landed, 2_000)).toBe(false);
  });

  it("after the hold, GitHub's own answer is believed again", () => {
    const landed: Landed = new Map([[412, 1_000]]);
    expect(staleOpen(detail(412), landed, 1_000 + LANDED_HOLD_MS + 1)).toBe(false);
    expect(dropLanded([row(412)], landed, 1_000 + LANDED_HOLD_MS + 1).length).toBe(1);
    expect(landed.size).toBe(0);
  });

  it("with nothing landed the same array comes back, so nothing re-renders", () => {
    const rows = [row(412)];
    expect(dropLanded(rows, new Map())).toBe(rows);
    expect(dropLanded(rows, new Map([[9, Date.now()]]))).toBe(rows);
  });

  it("a merged detail written over a list that keeps the row (all/closed) shows it as Merged", () => {
    const d = landedDetail(detail(412), "2026-01-02T10:00:00Z");
    expect(overlayDetail([row(412)], d)[0].state).toBe("MERGED");
    expect(rowPatch(d).state).toBe("MERGED");
  });
});

describe("double submit sends exactly one request", () => {
  it("two presses in the same tick, one request", async () => {
    const lock = { current: false };
    let sent = 0;
    const press = () => once(lock, async () => { sent++; await new Promise((r) => setTimeout(r, 5)); return "ok"; });
    const [a, b] = await Promise.all([press(), press()]);
    expect(sent).toBe(1);
    expect([a, b]).toEqual(["ok", undefined]);
  });
  it("a failure unlocks, and the next press goes out", async () => {
    const lock = { current: false };
    let sent = 0;
    await once(lock, async () => { sent++; throw new Error("refused"); }).catch(() => {});
    expect(lock.current).toBe(false);
    await once(lock, async () => { sent++; });
    expect(sent).toBe(2);
  });
  it("the lock is held for the whole run", async () => {
    const lock = { current: false };
    const p = once(lock, async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(lock.current).toBe(true);
    await p;
    expect(lock.current).toBe(false);
  });
});

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The body of `sig` up to its own closing brace. */
function fnBody(sig: string): string {
  const start = code.indexOf(sig);
  expect(start).toBeGreaterThan(-1);
  /* The first `) {` or `=> {`: a parameter's own type braces come before it. */
  let depth = 0, i = code.indexOf("{", start + code.slice(start).search(/(\)|=>)\s*\{/));
  const from = i;
  for (; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) break;
  }
  return code.slice(from, i + 1);
}

describe("the handler is the guard, the DOM only shows it", () => {
  const doMerge = code.slice(code.indexOf("const doMerge = "), code.indexOf("const runMerge = "));
  it("the merge runs under the lock, which the dialog is inside of", () => {
    expect(doMerge).toContain("once(merging, () => runMerge(method, prefill))");
  });
  it("act is locked by a ref, not only by the state a same-tick second press cannot see", () => {
    const act = fnBody("const act = useCallback(async (label: string");
    expect(act).toMatch(/if \(busy \|\| actLock\.current\) return false;\s*actLock\.current = true;/);
    expect(act).toMatch(/finally \{ actLock\.current = false;/);
  });
  it("a merge that answered ok is written to both views before the re-read", () => {
    const run = fnBody("const runMerge = async (method: MergeMethod, prefill?: { by: string; subject?: string; body?: string }) =>");
    expect(run).toMatch(/if \(res\.ok\) markLanded\(detail\.number, res\.mergedBy\)/);
    expect(fnBody("const markLanded = (n: number, by?: string) =>")).toMatch(/setDetail[\s\S]*setPrs\(gone\); setBoardMine\(gone\); setBoardReview\(gone\)/);
  });
  it("the board's own merge does the same", () => {
    expect(code).toMatch(/const res = await api\.prMerge\(root, p\.number, mergeMethod, \{ headSha: p\.headSha \}\);\s*if \(res\.ok\) markLanded\(p\.number, res\.mergedBy\)/);
  });
  it("every list read passes through the tombstone, and a stale OPEN detail is refused", () => {
    expect((code.match(/openLists\(holdEdits\(/g) ?? []).length).toBe(3);
    expect(fnBody("const loadDetail = useCallback((n: number, force = false) =>")).toContain("if (staleOpen(r.detail, landedRef.current)) return;");
  });
});

describe("everything on the merge row is locked while it runs", () => {
  const overview = fnBody("function Overview(");
  it("Merge, the method menu, update branch, close, draft and merge-when-green all read the lock", () => {
    expect(overview).toMatch(/disabled=\{busy \|\| !!mergeWork \|\| !!refusal/);
    expect(overview).toMatch(/title="Merge method"\s*disabled=\{busy \|\| !!mergeWork\}/);
    for (const label of ["Merge when green", "Close", "To draft"]) expect(overview).toContain(label);
    expect(code).toMatch(/<Overview\s+d=\{d\} root=\{root\} busy=\{busy \|\| !!mergeWork\}/);
  });
  it("the button says Merging… while it runs", () => {
    expect(code).toContain('setMergeWork("Merging…")');
  });
});

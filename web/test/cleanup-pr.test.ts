// Cleaning up one PR from the PR view: the decisions (ticks, blocks, labels,
// outcome) and the wiring that must stay where the mockup puts it. Names are invented.
import { describe, expect, test } from "bun:test";
import {
  BIG_BYTES, PAGE, headline, actionView, defaultOff, failedFirst, isBig, isLong, largestFirst, matches, mergeReports, needsAttention, setTicks, shareOf, splitTail, subOf, blockViews, canConfirm, confirmLabel, excludeOf, groupOf, groupsOf, kindWord, groupTick, offersAtMerge, outcome, rowState,
  repoLabel, showsAction, subLine, ticked, toggleGroup, toggleItem, type Plan, type Report,
} from "../src/lib/cleanupPr.ts";

const item = (id: string, kind: string, bytes = 0) => ({ id, kind, target: `${kind}-${id}`, detail: "", bytes });
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p1", repo: "acme/orbit", pr: 322, title: "Retry queue", url: "", state: "MERGED", mergedAt: 1, notMerged: false,
  branch: "feat/ORBIT-1042-retry", slug: "ORBIT-1042", blocks: [], notes: [],
  items: [item("a", "tab"), item("b", "docker-image", 4_100_000_000), item("c", "docker-container", 41_000_000), item("d", "worktree", 1_600_000_000), item("e", "branch"), item("f", "own-state")],
  ...over,
});

describe("what is listed", () => {
  test("bookkeeping rows have no group and are never listed or counted", () => {
    expect(groupOf("other-folder")).toBe("worktree");
    expect(kindWord("other-folder")).toBe("other folder");
    expect(groupOf("own-state")).toBeNull();
    expect(groupOf("worklog")).toBeNull();
    expect(ticked(plan(), []).of).toBe(5);
  });
  test("groups come in the inventory's order, Docker first and Tab last, each once", () => {
    expect(groupsOf(plan()).map((g) => g.group)).toEqual(["docker", "worktree", "branch", "tab"]);
    expect(groupsOf(plan())[0]!.bytes).toBe(4_141_000_000);
  });
});

describe("the dialog's sub line", () => {
  test("names the repository like the PR view, owner/repo, never a folder path", () => {
    const p = plan({ url: "https://github.com/acme/orbit/pull/322", repo: "/home/a/code/orbit" });
    expect(repoLabel(p)).toBe("acme/orbit");
    expect(subLine(p, 5).endsWith("acme/orbit")).toBe(true);
    expect(repoLabel(plan({ url: "", repo: "/home/a/code/orbit" }))).toBe("orbit");
  });
});

describe("ticks", () => {
  test("unticking an item drops it from the total and sends it as exclude", () => {
    const off = toggleItem([], "b");
    expect(ticked(plan(), off)).toMatchObject({ count: 4, bytes: 1_641_000_000 });
    expect(excludeOf(plan(), off)).toEqual(["b"]);
    expect(toggleItem(off, "b")).toEqual([]);
  });
  test("a group box unticks its whole group, and a half-ticked group ticks fully", () => {
    const docker = groupsOf(plan())[0]!;
    const off = toggleGroup([], docker);
    expect(off.sort()).toEqual(["b", "c"]);
    expect(groupTick(off, docker)).toBe("none");
    expect(groupTick(["b"], docker)).toBe("some");
    expect(toggleGroup(["b"], docker)).toEqual([]);
  });
  test("an id that is not in the plan, or a bookkeeping row, is never sent", () => {
    expect(excludeOf(plan(), ["zzz", "f"])).toEqual([]);
  });
});

describe("the confirm button", () => {
  const t = (p: Plan, off: string[] = []) => ticked(p, off);
  test("on only when nothing blocks and something is ticked", () => {
    expect(canConfirm(plan(), t(plan()), false)).toBe(true);
    expect(canConfirm(plan({ blocks: [{ kind: "dirty", why: "2 files changed" }] }), t(plan()), false)).toBe(false);
    expect(canConfirm(plan(), t(plan(), ["a", "b", "c", "d", "e"]), false)).toBe(false);
  });
  test("a PR closed without merge also needs its box", () => {
    const p = plan({ notMerged: true, state: "CLOSED" });
    expect(canConfirm(p, t(p), false)).toBe(false);
    expect(canConfirm(p, t(p), true)).toBe(true);
  });
  test("the label says Clean up, or Nothing ticked, and \"anyway\" for a PR that was not merged", () => {
    expect(confirmLabel(plan(), t(plan()))).toBe("Clean up");
    expect(confirmLabel(plan(), t(plan(), ["a"]))).toBe("Clean up");
    expect(confirmLabel(plan(), t(plan(), ["a", "b", "c", "d", "e"]))).toBe("Nothing ticked");
    expect(confirmLabel(plan({ notMerged: true }), t(plan()))).toBe("Clean up anyway");
  });
});

describe("blocks", () => {
  test("each block keeps the server's reason and its files, under a title", () => {
    const v = blockViews(plan({ blocks: [{ kind: "dirty", why: "2 files changed since the last commit.", files: ["server/src/retryQueue.ts"] }, { kind: "never-heard-of", why: "x" }] }));
    expect(v[0]).toMatchObject({ title: "Uncommitted changes in the worktree", why: "2 files changed since the last commit.", files: ["server/src/retryQueue.ts"] });
    expect(v[1]!.title).toBe("Something is in the way");
  });
});

describe("the button and badge on the PR", () => {
  test("no offer in Off mode or on an open PR", () => {
    expect(showsAction("off", "MERGED")).toBe(false);
    expect(showsAction("ask", "OPEN")).toBe(false);
    expect(showsAction("ask", undefined)).toBe(false);
    for (const m of ["ask", "atMerge", "auto"] as const) { expect(showsAction(m, "MERGED")).toBe(true); expect(showsAction(m, "CLOSED")).toBe(true); }
  });
  test("badge says the size, or that there is nothing, and a block turns it into the reason", () => {
    expect(actionView(null).badge).toBeNull();
    expect(actionView(plan())).toMatchObject({ badge: "Leftovers 5.7 GB", tone: "lo", blocked: "" });
    expect(actionView(plan({ items: [item("e", "branch")] })).badge).toBe("Leftovers: 1 item");
    expect(actionView(plan({ items: [item("f", "own-state")] }))).toMatchObject({ badge: "No leftovers", tone: "none" });
    expect(actionView(plan({ blocks: [{ kind: "live-session", why: "x" }] }))).toMatchObject({ tone: "warn", blocked: "A live session is working in this worktree" });
    expect(actionView(plan({ notMerged: true })).strong).toBe(true);
  });
  test("the merge dialog's tick exists only in Offer at merge time", () => {
    expect(offersAtMerge("atMerge")).toBe(true);
    for (const m of ["off", "ask", "auto"] as const) expect(offersAtMerge(m)).toBe(false);
  });
});

describe("running and done", () => {
  const rep = (items: Report["items"]): Report => ({ ok: true, planId: "p1", items, freedBytes: 5_000_000_000, failed: 0, summary: "" });
  const r = (id: string, kind: string, status: Report["items"][number]["status"]) => ({ id, kind, target: id, status, detail: "x" });
  test("while running every row works; after, a row without a result waits", () => {
    expect(rowState(undefined, "running")).toBe("running");
    expect(rowState(undefined, "finished")).toBe("waiting");
    expect(rowState(r("a", "tab", "failed"), "finished")).toBe("failed");
  });
  test("a clean finish says what was removed and skipped; stashes count as patches", () => {
    const o = outcome(plan(), rep([r("a", "tab", "skipped"), r("b", "docker-image", "done"), r("s", "stash", "done")]));
    expect(o).toMatchObject({ title: "ORBIT-1042 cleaned", sub: "2 items removed · 1 left as is", tone: "ok", retry: false, patches: 1, freed: "5.0 GB" });
  });
  test("the app's own bookkeeping rows are not counted as leftovers removed", () => {
    expect(outcome(plan(), rep([r("b", "docker-image", "done"), r("o", "own-state", "done"), r("w", "worklog", "done")])).sub).toBe("1 item removed");
  });
  test("a warning (the fetch that could not reach GitHub) is a note, not a removal", () => {
    expect(outcome(plan(), rep([r("b", "docker-image", "done"), r("x", "fetch-prune", "warn")])).sub).toBe("1 item removed \u00b7 1 note");
  });
  test("a partial failure is named and offers Retry", () => {
    const o = outcome(plan(), rep([r("b", "docker-image", "done"), r("d", "worktree", "failed")]));
    expect(o).toMatchObject({ title: "ORBIT-1042 cleaned with 1 problem", tone: "warn", retry: true, failed: 1 });
  });
});

describe("wiring that must stay", () => {
  const dialog = Bun.file(new URL("../src/components/CleanupDialog.tsx", import.meta.url)).text();
  const action = Bun.file(new URL("../src/components/CleanupPrAction.tsx", import.meta.url)).text();
  const panel = Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  const merge = Bun.file(new URL("../src/components/MergeDialog.tsx", import.meta.url)).text();

  test("the run sends the plan id the person read and only what was unticked", async () => {
    const d = await dialog;
    expect(d).toContain("api.cleanupRun(repo, pr, p.id, exclude, p.notMerged && gate)");
    expect(d).toContain("await exec(plan, excludeOf(plan, off))");
  });
  test("nothing runs on its own: the only cleanupRun call is behind the confirm handler", async () => {
    const a = await action, d = await dialog;
    expect(a).not.toContain("cleanupRun");
    expect((d.match(/cleanupRun\(/g) ?? []).length).toBe(1);
    expect(d.slice(d.indexOf("const run = async"), d.indexOf("/** Only the failed rows again")).includes("canConfirm(plan, t, gate)")).toBe(true);
  });
  test("hook points: the merge dock mounts the action for a merged or closed PR, the merge dialog carries the tick", async () => {
    const p = await panel, m = await merge;
    const dock = p.slice(p.indexOf("function PrDock("), p.indexOf("function MergeScope("));
    expect(dock).toContain("{!open && <CleanupPrAction root={props.root} pr={d.number} state={d.state} />}");
    expect((p.match(/<CleanupPrAction /g) ?? []).length).toBe(1);
    expect(p).toContain("offerCleanup:");
    expect(p).toContain("choice.cleanup");
    expect(m).toContain("pending.offerCleanup && (");
  });
});

describe("nothing to clean is not a call to action", () => {
  test("the button exists only when the one shared rule offers it", async () => {
    const src = await Bun.file(new URL("../src/components/CleanupPrAction.tsx", import.meta.url).pathname).text();
    expect(src).toContain('offerFor(stateOfPlan(plan, failed), "panel")');
    expect(src).toContain("{offer.button && <button");
  });
});

describe("long lists and long names", () => {
  test("a name is shortened in the middle with its tail kept, and only when it is long", () => {
    const long = `registry.acme.example/orbit/${"x".repeat(80)}:orbit-1042-linux-amd64-build-20261028`;
    const [head, tail] = splitTail(long);
    expect(head + tail).toBe(long);
    expect(tail).toBe(long.slice(-26));
    expect(splitTail("orbit-1042-db-1")).toEqual(["orbit-1042-db-1", ""]);
    expect(isLong(long)).toBe(true);
    expect(isLong("orbit-1042-db-1")).toBe(false);
  });
  test("the filter needs every word, in the name, the kind or the reason", () => {
    const i = { target: "orbit-1042_pgdata", kind: "docker-volume", detail: "only this worktree uses it" };
    expect(matches(i, "")).toBe(true);
    expect(matches(i, "PGDATA volume")).toBe(true);
    expect(matches(i, "worktree uses")).toBe(true);
    expect(matches(i, "pgdata image")).toBe(false);
  });
  test("All / None on a filtered set leave every other tick alone", () => {
    expect(setTicks(["x"], ["a", "b"], false)).toEqual(["x", "a", "b"]);
    expect(setTicks(["x", "a"], ["a", "b"], false)).toEqual(["x", "a", "b"]);
    expect(setTicks(["x", "a", "b"], ["a", "b"], true)).toEqual(["x"]);
  });
  test("largest first; items without a size go last, in their order", () => {
    expect(largestFirst([{ id: "a" }, { id: "b", bytes: 5 }, { id: "c", bytes: 9 }, { id: "d" }]).map((x) => x.id)).toEqual(["c", "b", "a", "d"]);
  });
  test("a size is red above 10 GB or at half of the total (and at least 1 GB), never for a lone small item", () => {
    expect(isBig(BIG_BYTES, 60 * 1e9)).toBe(true);
    expect(isBig(3e9, 6e9)).toBe(true);
    expect(isBig(2e9, 6.2e9)).toBe(false);
    expect(isBig(4_000, 4_000)).toBe(false);
    expect(shareOf(50e9, 52e9)).toBe(96);
    expect(shareOf(1, 0)).toBe(0);
  });
  test("a PR that was not merged opens with branches and stashes unticked", () => {
    const p = plan({ notMerged: true, items: [item("a", "docker-image", 10), item("b", "branch"), item("s", "stash", 5), item("w", "worktree", 1)] });
    expect(defaultOff(p)).toEqual(["b", "s"]);
    expect(defaultOff(plan())).toEqual([]);
  });
  test("Needs attention: a flagged size, a worktree or branch of a never-merged PR, or a result that is not clean", () => {
    const big = item("v", "docker-volume", 50e9), small = item("c", "docker-container", 1000), br = item("b", "branch");
    expect(needsAttention(plan(), big, 52e9)).toBe(true);
    expect(needsAttention(plan(), small, 52e9)).toBe(false);
    expect(needsAttention(plan({ notMerged: true }), br, 0)).toBe(true);
    expect(needsAttention(plan(), br, 0)).toBe(false);
    expect(needsAttention(plan(), small, 0, { status: "failed" })).toBe(true);
    expect(needsAttention(plan(), big, 52e9, { status: "done" })).toBe(false);
  });
  test("a row's sub line names its kind, then the server's detail", () => {
    expect(subOf({ kind: "docker-volume", detail: "only this worktree uses it" })).toBe("volume \u00b7 only this worktree uses it");
    expect(subOf({ kind: "tab", detail: "" })).toBe("tab");
  });
  test("a page is fifty rows", () => { expect(PAGE).toBe(50); });
});

describe("the header", () => {
  test("the card names the dialog; a PR title of more than 80 characters is the title, to be clamped", () => {
    expect(headline(plan())).toBe("Clean up ORBIT-1042's local leftovers");
    expect(headline(plan({ slug: null }))).toBe("Clean up #322's local leftovers");
    const long = "ORBIT-1042 Fix invoice rounding so that half-even is used for multi-currency ledgers with tax-inclusive pricing";
    expect(headline(plan({ title: long }))).toBe(`Clean up ${long}`);
  });
});

describe("retrying only the failed rows", () => {
  const r = (id: string, kind: string, status: Report["items"][number]["status"], bytes = 0) => ({ id, kind, target: id, status, detail: "x", bytes });
  const first: Report = { ok: false, planId: "p1", items: [r("a", "docker-image", "failed", 10), r("b", "docker-volume", "failed", 20), r("c", "worktree", "done", 30)], freedBytes: 30, failed: 2, summary: "" };
  test("a retried row takes its new result, done rows stay, freed bytes add up", () => {
    const next: Report = { ok: true, planId: "p2", items: [r("a", "docker-image", "done", 10), r("b", "docker-volume", "failed", 0)], freedBytes: 10, failed: 1, summary: "" };
    const m = mergeReports(first, next, ["a", "b"]);
    expect(m.items.map((i) => `${i.id}:${i.status}`)).toEqual(["a:done", "b:failed", "c:done"]);
    expect(m).toMatchObject({ freedBytes: 40, failed: 1, ok: false });
  });
  test("a retried row the fresh plan no longer lists is gone already, not a failure", () => {
    const m = mergeReports(first, { ok: true, planId: "p2", items: [r("a", "docker-image", "done", 10)], freedBytes: 10, failed: 0, summary: "" }, ["a", "b"]);
    expect(m.items.find((i) => i.id === "b")).toMatchObject({ status: "skipped", detail: "already gone" });
    expect(m.ok).toBe(true);
  });
  test("failed rows are listed first, the rest keep their order", () => {
    const by = new Map(first.items.map((i) => [i.id, i]));
    expect(failedFirst([{ id: "c" }, { id: "a" }, { id: "z" }, { id: "b" }], by).map((x) => x.id)).toEqual(["a", "b", "c", "z"]);
  });
});

describe("the wide dialog keeps its promises", () => {
  const dialog = Bun.file(new URL("../src/components/CleanupDialog.tsx", import.meta.url)).text();
  const css = Bun.file(new URL("../src/components/cleanupPr.css", import.meta.url)).text();
  test("a reason is never clamped, and only the title and the middle of a name are shortened", async () => {
    const c = await css;
    const block = (sel: string): string => { const i = c.indexOf(`${sel} {`); return c.slice(i, c.indexOf("}", i)); };
    for (const sel of [".agx-cln-sub", ".agx-cln-why", ".agx-cln-card span"]) {
      expect(block(sel)).not.toMatch(/line-clamp|text-overflow|white-space: nowrap/);
      expect(block(sel)).toContain("overflow-wrap: anywhere");
    }
    expect(block(".agx-cln-ttl b[data-clamp]")).toContain("-webkit-line-clamp: 3");
  });
  test("the list is paged, so four hundred items never mean four hundred rows", async () => {
    const d = await dialog;
    expect(d).toContain("ordered.slice(0, upto)");
    expect(d).toContain("Show next");
  });
  test("the primary button is violet, not the app blue; the fall-back under 1400 px is one column", async () => {
    const c = await css;
    expect(c).toMatch(/\.agx-cln \{ --cd-accent: var\(--merged\)/);
    expect(c).toMatch(/\.agx-cln-btn\.primary \{[^}]*background: color-mix\(in srgb, var\(--cd-accent\)/);
    expect(c).toMatch(/@media \(max-width: 1399px\)[\s\S]*\.agx-cln-body \{ grid-template-columns: minmax\(0, 1fr\)/);
  });
  test("a run answers once, so no row claims to be the current one and no percentage is drawn", async () => {
    const d = await dialog;
    expect(d).toContain('const shownSt = st === "running" && !retrying.length ? "waiting" : st');
    expect(d).not.toMatch(/\d+ % /);
  });
});

describe("the button while the plan is read", () => {
  const action = Bun.file(new URL("../src/components/CleanupPrAction.tsx", import.meta.url)).text();
  const css = Bun.file(new URL("../src/components/cleanupPr.css", import.meta.url)).text();
  const dialog = Bun.file(new URL("../src/components/CleanupDialog.tsx", import.meta.url)).text();
  test("reading draws a skeleton and a failed read a muted chip, never an enabled button", async () => {
    const a = await action;
    expect(a).toContain("{offer.skeleton && <i");
    expect(a).toContain("{offer.muted && offer.chip && <span");
    expect(a).toContain("disabled={busy || !!v.blocked}");
  });
  test("a failed plan call is an error state, not an empty badge", async () => {
    const a = await action;
    expect(a).toContain("if (r.ok && r.plan) setPlan(r.plan); else fail();");
    expect(a).toContain(".catch(fail)");
  });
  test("the button keeps one width in every state, and the dialog shows a skeleton before the plan", async () => {
    expect(await css).toMatch(/\.agx-cp-btn \{[^}]*min-width: 224px/);
    expect(await dialog).toContain('className="agx-cln-skel"');
  });
  test("no class is defined in both the cleanup stylesheet and index.css", async () => {
    /* `.agx-cd` was the PR card's class in index.css AND the dialog's in cleanupPr.css: the dialog's height 780 and overflow hidden made every board card 592px tall. */
    const names = (t: string) => new Set([...t.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.(agx-[A-Za-z0-9_-]+)/g)].map((m) => m[1]!));
    const index = names(await Bun.file(new URL("../src/index.css", import.meta.url)).text());
    const both = [...names(await css)].filter((n) => index.has(n));
    expect(both).toEqual([]);
  });
  test("the dock button defines the accent its primary style reads, because the dialog root was the only place that did and the button drew with no background", async () => {
    const text = await css;
    expect(text).toMatch(/\.agx-cp \{ --cd-accent: var\(--merged\);/);
    expect(text).toContain(".agx-cln-btn.primary { background: color-mix(in srgb, var(--cd-accent)");
  });
  test("the button draws its glyph at the size of the dock's other controls (12), not a rung of its own", async () => {
    const src = await Bun.file(new URL("../src/components/CleanupPrAction.tsx", import.meta.url)).text();
    expect(src).toContain("<SparkleIcon size={ICON.xs} />{busy");
  });
  test("the button is as tall as every other control in the dock: the HIT rung, not a number of its own", async () => {
    const { HIT } = await import("../src/lib/iconSize.ts");
    expect(await css).toContain(`.agx-cp-btn { height: ${HIT}px;`);
  });
});

describe("the cleanup's styles and the card D's share no class or custom property", () => {
  const sheets = ["index.css", "components/cleanupPr.css"];
  const classes = async (re: RegExp) => {
    const all = await Promise.all(sheets.map((s) => Bun.file(new URL(`../src/${s}`, import.meta.url)).text()));
    return new Set(all.join("\n").match(re) ?? []);
  };
  test("`.agx-cd*` (card D) and `.agx-cln*` / `.agx-cp*` (cleanup) never name the same class", async () => {
    const cd = await classes(/\.agx-cd[\w-]*/g);
    const cln = await classes(/\.agx-(?:cln|cp)[\w-]*/g);
    expect(cd.size).toBeGreaterThan(20);
    expect(cln.size).toBeGreaterThan(20);
    expect([...cd].filter((c) => cln.has(c))).toEqual([]);
  });
  test("`--cd-accent` is the cleanup's own and is set on its roots, never read from card D's", async () => {
    const index = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(index).not.toContain("--cd-accent");
  });
});

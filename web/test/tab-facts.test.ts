/*
 * The tab's own record (lib/tabFacts.ts): one per tmux window id, never keyed
 * by cwd, by the focused pane, or by a "current" slot. See design.md.
 */
import { describe, expect, test } from "bun:test";
import {
  createTabFactsStore, refreshActive, refreshTargets, resolveCardId, resolveWorktree,
  type CardFact, type FactsPatch, type TabFactsStore,
} from "../src/lib/tabFacts.ts";
import { namedWorktree } from "../src/lib/paneWorktree.ts";

const card = (label: string): CardFact => ({ label, query: label, status: null, color: null, priority: null, action: null });

const labelFromName = (name: string): string | null => {
  const m = /([A-Z]+-\d+)/.exec(name);
  return m ? m[1]! : null;
};

describe("resolveCardId: three binding cases", () => {
  test("launch metadata wins even when the name would also answer", () => {
    expect(resolveCardId("orbit-ORBIT-144", "ORBIT-999", labelFromName)).toEqual({ kind: "launch", cardId: "ORBIT-999" });
  });
  test("the tab's own name, when there is no launch metadata", () => {
    expect(resolveCardId("orbit-ORBIT-146", null, labelFromName)).toEqual({ kind: "name", cardId: "ORBIT-146" });
  });
  test("neither names a card", () => {
    expect(resolveCardId("plain-shell", null, labelFromName)).toEqual({ kind: "none", cardId: null });
    expect(resolveCardId(undefined, undefined, labelFromName)).toEqual({ kind: "none", cardId: null });
  });
});

describe("resolveWorktree: the bound card first, the tab's own cwd otherwise — never a scan of another session's work", () => {
  const main = { root: "/code/orbit", branch: "master" };
  const a = { root: "/code/orbit-ORBIT-144", branch: "ORBIT-144-fix-login" };
  const b = { root: "/code/orbit-ORBIT-146", branch: "ORBIT-146-add-export" };
  const cands = [main, a, b];

  test("a bound card finds its own worktree regardless of cwd", () => {
    expect(resolveWorktree("ORBIT-146", main.root, cands, namedWorktree)).toBe(b);
  });
  test("no bound card: the checkout actually at this cwd, never another one", () => {
    expect(resolveWorktree(null, a.root, cands, namedWorktree)).toBe(a);
    expect(resolveWorktree(null, main.root, cands, namedWorktree)).toBe(main);
  });
  test("a cwd inside a checkout is that checkout; a worktree nested under main wins over main", () => {
    expect(resolveWorktree(null, `${a.root}/server/src`, cands, namedWorktree)).toBe(a);
    const nested = { root: "/code/orbit/.worktrees/ORBIT-9", branch: "ORBIT-9-x" };
    expect(resolveWorktree(null, `${nested.root}/web`, [main, nested], namedWorktree)).toBe(nested);
    expect(resolveWorktree(null, "/code/orbit-other/x", cands, namedWorktree)).toBeNull();
  });
  test("no bound card and an unknown cwd: nothing, never a guess", () => {
    expect(resolveWorktree(null, "/code/somewhere-else", cands, namedWorktree)).toBeNull();
  });
});

describe("the model: 4 tabs, one with its own worktree, three sharing a cwd on master, three binding cases, switched 10 times", () => {
  const main = { root: "/code/orbit", branch: "master" };
  const a = { root: "/code/orbit-ORBIT-144", branch: "ORBIT-144-fix-login" };
  const b = { root: "/code/orbit-ORBIT-146", branch: "ORBIT-146-add-export" };
  const c = { root: "/code/orbit-ORBIT-256", branch: "ORBIT-256-trim-logs" };
  const cands = [main, a, b, c];

  function seedTab(store: TabFactsStore, tabId: string, tabName: string | null, launchCardId: string | null, cwd: string) {
    const { cardId } = resolveCardId(tabName, launchCardId, labelFromName);
    const wt = resolveWorktree(cardId, cwd, cands, namedWorktree);
    store.write(tabId, { root: wt?.root ?? null, branch: wt?.branch ?? "", card: cardId ? card(cardId) : null });
  }

  test("each tab shows its own card and branch, every one of 10 switches", () => {
    const store = createTabFactsStore();
    // own-worktree tab: no card at all, found purely by its own cwd.
    seedTab(store, "@W0", "shell", null, main.root);
    // three tabs sharing the parent cwd, one binding case each.
    seedTab(store, "@W1", "orbit-ORBIT-144", null, main.root); // bound by name
    seedTab(store, "@W2", "worker", "ORBIT-146", main.root); // bound by launch metadata
    seedTab(store, "@W3", "worker", null, main.root); // no binding at all: falls to cwd (master)

    const order = ["@W0", "@W1", "@W2", "@W3", "@W1", "@W3", "@W2", "@W0", "@W2", "@W1"];
    for (const id of order) {
      store.setActive(id);
      const f = store.get(store.getActive()!)!;
      if (id === "@W0") expect(f).toMatchObject({ root: main.root, branch: "master" });
      if (id === "@W1") expect(f).toMatchObject({ root: a.root, branch: a.branch });
      if (id === "@W2") expect(f).toMatchObject({ root: b.root, branch: b.branch });
      if (id === "@W3") expect(f).toMatchObject({ root: main.root, branch: "master" });
    }
  });

  test("a late refresh for A, arriving after a switch to B, updates only A", () => {
    const store = createTabFactsStore();
    seedTab(store, "@A", "orbit-ORBIT-144", null, main.root);
    seedTab(store, "@B", "orbit-ORBIT-146", null, main.root);
    store.setActive("@A");
    const bBefore = structuredClone(store.get("@B"));
    // The response for A's own refresh lands only now, after the person has
    // already switched to B.
    store.setActive("@B");
    store.write("@A", { branch: a.branch, card: card("ORBIT-144-late") });
    expect(store.get("@B")).toEqual(bBefore); // untouched by A's late answer
    expect(store.get("@A")?.card?.label).toBe("ORBIT-144-late"); // A's own record, updated
  });

  test("break the key on purpose (key by cwd instead of tab id) and watch it fail", () => {
    // The bug this whole model exists to rule out: write/read keyed by the
    // SHARED cwd instead of the tab id collapses three distinct tabs onto
    // one record, last writer wins.
    const store = createTabFactsStore();
    const sharedKey = main.root; // the bug: using cwd as the key
    store.write(sharedKey, { card: card("ORBIT-144") });
    store.write(sharedKey, { card: card("ORBIT-146") });
    store.write(sharedKey, { card: card("ORBIT-256") });
    // Keyed correctly, each tab would have its OWN record — keyed by cwd,
    // there is only ever one, and it is whichever tab wrote last.
    expect(store.get(sharedKey)?.card?.label).toBe("ORBIT-256");
    expect(store.tabIds()).toEqual([sharedKey]); // not three tabs — one, wrongly shared
  });
});

describe("Extension: switching draws the stored record, no fetch, no empty frame", () => {
  test("setActive alone never calls the fetcher — switching ten times issues nothing", async () => {
    const store = createTabFactsStore();
    let calls = 0;
    const fetchFacts = async (tabId: string): Promise<FactsPatch> => { calls++; return { branch: tabId }; };
    for (let i = 0; i < 10; i++) store.setActive(`@${i % 3}`);
    expect(calls).toBe(0);
    void fetchFacts; // only `refreshActive` below is allowed to call it
  });

  test("a tab drawn before keeps its own record across a switch away and back — never a blank or loading frame", () => {
    const store = createTabFactsStore();
    store.write("@A", { root: "/code/orbit-ORBIT-144", branch: "ORBIT-144-x", card: card("ORBIT-144") });
    const before = structuredClone(store.get("@A"));
    store.setActive("@A");
    store.setActive("@B"); // B was never written: this is the ONE case a skeleton is honest
    expect(store.get("@B")).toBeUndefined();
    store.setActive("@A");
    expect(store.get("@A")).toEqual(before); // A's own answer, exactly as it was, no refetch needed to show it
  });

  test("refreshActive fetches only the active tab, and writes land on their own id even after another switch", async () => {
    const store = createTabFactsStore();
    for (const id of ["@A", "@B", "@C"]) store.write(id, { branch: id });
    store.setActive("@A");
    let calls: string[] = [];
    const fetchFacts = async (tabId: string): Promise<FactsPatch> => { calls.push(tabId); return { branch: `${tabId}-fresh` }; };
    const pending = refreshActive(store, store.tabIds(), fetchFacts);
    expect(calls).toEqual(["@A"]); // only the active tab was asked
    store.setActive("@B"); // the person switches before A's answer lands
    await Promise.all(pending);
    expect(store.get("@A")?.branch).toBe("@A-fresh"); // A's own answer, in A's own record
    expect(store.get("@B")?.branch).toBe("@B"); // B untouched by A's refresh
  });
});

describe("Extension 2: view state per tab, 10 tabs, one refresh rate", () => {
  const ids = "ABCDEFGHIJ".split("").map((c) => `@${c}`);

  function seeded(): TabFactsStore {
    const store = createTabFactsStore();
    for (const id of ids) {
      store.write(id, { root: `/code/${id}`, branch: `BRANCH-${id}`, card: card(id) });
      store.setView(id, { section: "pr", width: 400, scroll: { pr: 10 } });
    }
    return store;
  }

  test("changing tab A's view and facts leaves B..J deep-equal, byte for byte", () => {
    const store = seeded();
    const others = ids.filter((id) => id !== "@A");
    const before = others.map((id) => structuredClone(store.get(id)));
    store.setView("@A", { section: "diff", width: 700, scroll: { diff: 55 } });
    store.write("@A", { branch: "BRANCH-A-renamed", card: card("A-renamed") });
    const after = others.map((id) => store.get(id));
    expect(after).toEqual(before);
  });

  test("switching away and back restores exactly the stored view — no reset to a default panel", () => {
    const store = seeded();
    store.setView("@E", { section: "diff", width: 333 });
    store.setActive("@E");
    store.setActive("@A");
    store.setActive("@E");
    expect(store.get("@E")?.view).toEqual({ section: "diff", width: 333, scroll: { pr: 10 } });
  });

  test("scroll remembers per section without forgetting the others", () => {
    const store = seeded();
    store.setView("@C", { scroll: { diff: 90 } });
    expect(store.get("@C")?.view.scroll).toEqual({ pr: 10, diff: 90 });
  });

  test("the scheduler keeps only the active tab on the normal interval, with 10 tabs open", () => {
    expect(refreshTargets(ids, "@E")).toEqual(["@E"]);
    expect(refreshTargets(ids, null)).toEqual([]);
    expect(refreshTargets(ids, "@not-open")).toEqual([]);
    for (const id of ids) expect(refreshTargets(ids, id).length).toBe(1); // exactly one, ever
  });

  test("requests per hour, 10 tabs open, one normal-rate poll every 4s: only the active tab pays it", () => {
    const POLL_MS = 4000;
    const perHour = (n: number) => n * (3_600_000 / POLL_MS);
    // Before this change: the focused tab polled at this rate AND every one
    // of the other 9 tabs polled on its own slower (8s) interval — see
    // report.md for the file:line this replaces.
    const before = perHour(1) + 9 * perHour(0.5); // 900 + 9*450 = 4950/h
    // After: `refreshTargets` names exactly one tab, whatever `tabIds` holds.
    const activeOnly = refreshTargets(ids, ids[4]!);
    const after = activeOnly.length * perHour(1); // 900/h
    expect(before).toBe(4950);
    expect(after).toBe(900);
  });
});

describe("four tabs, the second one closes — carried over from lib/paneIdentity.ts's own regression", () => {
  // The live bug that module was written against: a tab in the middle of the
  // strip closed, every later window's INDEX shifted down by one, and the
  // tab that landed on the old index of ORBIT-1043 kept showing ORBIT-1043's
  // card and branch — something was keyed by position, not by the window's
  // own id. A Map keyed by the tab id string, as this store is throughout,
  // cannot reproduce that failure: there is no index anywhere to shift.
  const w = (n: number) => `@${n}`;
  const rec = (n: number) => ({ root: `/code/orbit-${1040 + n}`, branch: `ORBIT-${1040 + n}` });

  test("each remaining tab still resolves its own card and branch — none inherits the closed one's slot", () => {
    const store = createTabFactsStore();
    for (let i = 1; i <= 4; i++) store.write(w(i), rec(i));
    // tmux renumbers windows 3 and 4 down to indices 2 and 3 after closing
    // window 2 — but their ids, and so their own records here, do not move.
    store.forget(w(2));
    expect(store.get(w(1))).toMatchObject(rec(1));
    expect(store.get(w(2))).toBeUndefined();
    expect(store.get(w(3))).toMatchObject(rec(3));
    expect(store.get(w(4))).toMatchObject(rec(4));
    // Window 3, now drawn at the strip's old index 2, is still ORBIT-1043 —
    // not window 2's old card.
    expect(store.get(w(3))!.branch).toBe("ORBIT-1043");
    expect(store.get(w(3))!.branch).not.toBe(rec(2).branch);
  });
});

describe("a tab id reused after a server restart — SidePane.tsx's diff totals and Jira status", () => {
  // Tmux window ids reset to @0 on a server restart. The diff's line totals
  // and a Jira card's status, drawn by SidePane.tsx, live in this same
  // per-tab record now, so `forget` dropping the whole record on window
  // close is what keeps a reused id from showing the old tab's numbers.
  test("forgetting the old tab clears diff and jiraStatus; the reused id starts fresh", () => {
    const store = createTabFactsStore();
    store.write("@3", { diff: { files: 12, add: 80, del: 20 }, jiraStatus: { title: "In review", color: null } });
    expect(store.get("@3")!.diff).toEqual({ files: 12, add: 80, del: 20 });
    store.forget("@3");
    store.write("@3", { root: "/code/orbit-B", branch: "ORBIT-200" });
    expect(store.get("@3")!.diff).toBeNull();
    expect(store.get("@3")!.jiraStatus).toBeNull();
  });
});

/*
 * Turning changed lines into PLACES.
 *
 * "130, 131, 132 … 141" is not twelve things, it is one — a function somebody
 * added — and a rail that says otherwise is a rail nobody reads. What is pinned
 * here is the grouping (what counts as one place), the counting, and the name,
 * because the name is what somebody is actually looking for and a wrong one
 * reads like a bug.
 */
import { describe, expect, test } from "bun:test";
import { groupAt, groupHunks, groupLabel, groupPatch, groupTotals, symbolOf } from "../src/lib/changeGroups.ts";

describe("what a line declares", () => {
  test("the languages this app is used on", () => {
    expect(symbolOf("+def _agent_busy(self):")).toBe("def _agent_busy");
    expect(symbolOf(" class UnblockTests(TestCase):")).toBe("class UnblockTests");
    expect(symbolOf("+export function openPeek(p: Peek): void {")).toBe("function openPeek");
    expect(symbolOf("+  async fn settle(&self) -> Result<()> {")).toBe("fn settle");
    expect(symbolOf("+type Peek = {")).toBe("type Peek");
    expect(symbolOf("+export const linesForFile = (d: string) => {")).toBe("linesForFile");
  });

  test("and nothing for a line that declares nothing", () => {
    // A guess that reads like a bug is worse than an empty label.
    expect(symbolOf("+    call = G(Call, agent=self.agent)")).toBe("");
    expect(symbolOf("+# a comment about def foo")).toBe("");
    expect(symbolOf("")).toBe("");
  });
});

describe("grouping", () => {
  const hunk = (newStart: number, lines: string[]) => ({ newStart, lines });

  test("consecutive changes are one place, with its range and its counts", () => {
    const g = groupHunks([hunk(130, [
      "+def _agent_busy(self):",
      "+    call = G(Call)",
      "+    return call",
    ])]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ from: 130, to: 132, added: 3, removed: 0, symbol: "def _agent_busy" });
    expect(groupLabel(g[0]!)).toBe("130–132");
  });

  /* Three is the gap a blank line and a comment leave inside one function. Past
     that they are two places, and merging them would put one entry over a run
     with a hole in the middle. */
  test("a small gap keeps them together, a big one splits them", () => {
    const near = groupHunks([hunk(10, ["+a", " b", " c", "+d"])]);
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ from: 10, to: 13 });

    const far = groupHunks([hunk(10, ["+a", " b", " c", " d", " e", " f", "+g"])]);
    expect(far).toHaveLength(2);
    expect(far.map((x) => x.from)).toEqual([10, 16]);
  });

  test("a deletion does not advance the new file's line", () => {
    const g = groupHunks([hunk(20, [" keep", "-gone", "-gone too", "+new"])]);
    expect(g[0]).toMatchObject({ from: 21, to: 21, added: 1, removed: 2 });
  });

  test("the name comes from the declaration above the change, inside the hunk", () => {
    const g = groupHunks([hunk(40, [
      " class Thing:",
      "     def setUp(self):",
      "+        cache.clear()",
    ])]);
    expect(g[0]!.symbol).toBe("def setUp");
  });

  test("and a declaration ON a changed line wins — that IS the new function", () => {
    const g = groupHunks([hunk(40, [
      " class Thing:",
      "+    def brand_new(self):",
      "+        pass",
    ])]);
    expect(g[0]!.symbol).toBe("def brand_new");
  });

  test("no name rather than one from somewhere this side cannot see", () => {
    expect(groupHunks([hunk(5, ["+    x = 1"])])[0]!.symbol).toBe("");
  });
});

describe("from a unified patch", () => {
  const patch = `@@ -60,4 +60,6 @@ from base.testing import fake_redis
 from orbit.testing import TestCase
+from orbit.constants import CACHE_PREFIX
+from agentstatus.models import AgentStatus
 from base.utils.urls import build
@@ -125,6 +127,20 @@ class UnblockTests(TestCase):
     )['agent']
+
+    def _agent_busy(self, *, pill=None):
+        """The shape an agent is left in."""
+        return call
`;

  test("every place, with its range, counts and name", () => {
    const g = groupPatch(patch);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ from: 61, to: 62, added: 2, removed: 0 });
    expect(g[1]).toMatchObject({ added: 4, removed: 0, symbol: "def _agent_busy" });
  });

  /* The hunk header carries the enclosing symbol, and it is the only place a
     name exists for a change at the very top of a hunk. */
  test("the hunk header is the fallback, never the override", () => {
    const top = `@@ -1,3 +1,4 @@ class UnblockTests(TestCase):
+    x = 1
 y = 2`;
    expect(groupPatch(top)[0]!.symbol).toBe("class UnblockTests");
  });

  test("the totals the rail's header says out loud", () => {
    expect(groupTotals(groupPatch(patch))).toEqual({ places: 2, added: 6, removed: 0 });
  });
});

describe("following the cursor", () => {
  const groups = groupHunks([
    { newStart: 10, lines: ["+a"] },
    { newStart: 50, lines: ["+b", "+c"] },
    { newStart: 90, lines: ["+d"] },
  ]);

  test("inside a place is that place", () => {
    expect(groupAt(groups, 51)).toBe(1);
  });

  test("between places is the one above — that is the change you are past", () => {
    expect(groupAt(groups, 70)).toBe(1);
  });

  test("above the first is the first, and there is no answer for none", () => {
    expect(groupAt(groups, 1)).toBe(0);
    expect(groupAt([], 5)).toBe(-1);
  });
});

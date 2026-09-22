/*
 * What the Lantern view sets each row aside as.
 *
 * The decision pulled out of the screen: a row the server marked GONE — no
 * pane on this machine and quiet for hours — is not an idle agent. The view
 * drew every one of them as one, and on a real board that was twenty-five
 * cards with five agents alive behind them. A wait is never collapsed,
 * whatever else the row says.
 */
import { describe, expect, test } from "bun:test";
import { groupLantern } from "../src/lib/lanternStore.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const row = (name: string, extra: Partial<LanternRow> = {}): LanternRow =>
  ({ name, from: "said", state: "idle", ...extra } as LanternRow);

describe("the field, grouped", () => {
  test("gone is its own fold, and idle holds only agents", () => {
    const g = groupLantern([
      row("orbit-1042", { state: "working" }),
      row("orbit-2001", { state: "idle" }),
      row("orbit-3001-cleanup", { state: "idle", gone: true }),
      row("orbit-3002-plugin", { state: "idle", gone: true }),
    ]);
    expect(g.working.map((r) => r.name)).toEqual(["orbit-1042"]);
    expect(g.idle.map((r) => r.name)).toEqual(["orbit-2001"]);
    expect(g.gone.map((r) => r.name)).toEqual(["orbit-3001-cleanup", "orbit-3002-plugin"]);
  });

  test("a wait outranks everything, gone included", () => {
    const g = groupLantern([
      row("stuck", { gone: true, needsYou: { kind: "permission", why: "rm -rf", since: 1 } }),
      row("done", { gone: true, needsYou: { kind: "input", why: "turn ended", since: 1 } }),
    ]);
    expect(g.need.map((r) => r.name)).toEqual(["stuck"]);
    expect(g.finished.map((r) => r.name)).toEqual(["done"]);
    expect(g.gone).toEqual([]);
  });

  test("an empty field is empty everywhere, not a crash", () => {
    expect(groupLantern([])).toEqual({ need: [], finished: [], working: [], idle: [], gone: [] });
  });
});

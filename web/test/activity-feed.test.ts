/*
 * Each decision the Activity screen makes, run without the screen: the words of a
 * row, its category, what a filter / person / search keeps, and the relative time.
 * Invented names only (orbit, rail2). Sizes 0 and 40 are covered on purpose.
 */
import { describe, expect, test } from "bun:test";
import type { ActionRecord, GateRecord } from "../../shared/types.ts";
import type { ActivityRow } from "../src/lib/activity.ts";
import { categoryOf, filterCounts, lineOf, narrow, relativeTime, verbOf, whoOf, whoOptions } from "../src/lib/activityFeed.ts";

let n = 0;
const act = (o: Partial<ActionRecord> = {}): ActivityRow => {
  const row: ActionRecord = { id: ++n, at: 1_000, actor: "local", action: "/git/push", target: "orbit main", ok: true, detail: null, ...o };
  return { kind: "action", at: row.at, key: `a${row.id}`, row };
};
const gate = (o: Partial<GateRecord> = {}): ActivityRow => {
  const row = { id: ++n, tool_name: "Bash", summary: "make test", decision: "allow", resolution: "human", decided_by: "local", decided_at: 1_000, reason: null, ...o } as unknown as GateRecord;
  return { kind: "gate", at: 1_000, key: `g${row.id}`, row };
};

describe("sentences", () => {
  test("a git push by this machine reads as 'You pushed orbit main'", () => {
    const l = lineOf(act());
    expect(`${l.who} ${l.what}`).toBe("You pushed orbit main");
  });
  test("an unknown route still reads as words, never a path", () => {
    expect(verbOf("/git/stash-drop")).toBe("stash drop");
    expect(verbOf("/docker/prune")).toBe("prune container");
  });
  test("an agent settings change names the setting and not its value", () => {
    const row = act({ actor: "seat:rail2", action: "/control/setting.set", target: "as rail2 · plugins.sessionReads.repos · queued" });
    expect(categoryOf(row)).toBe("settings");
    const l = lineOf(row);
    expect(l.who).toBe("Orchestrator rail2");
    expect(l.what).not.toContain("plugins.sessionReads");
    expect(l.what).toMatch(/^changed the setting “[^.]+”$/);
  });
  test("a setting id no Settings row carries still reads as words", () => {
    const l = lineOf(act({ actor: "seat:rail2", action: "/control/setting.set", target: "as rail2 · orbit.someFlag" }));
    expect(l.what).toBe("changed the setting “some flag”");
  });
  test("a door without a setting id drops the 'as <seat>' prefix and the dotted route", () => {
    const l = lineOf(act({ actor: "seat:rail2", action: "/control/open.panel", target: "as rail2 · git" }));
    expect(l.what).toBe("open panel git");
    expect(`${l.what} ${l.sub}`).not.toMatch(/as rail2|\.|\//);
  });
  test("a panel an agent opened is orchestration, not a setting", () => {
    expect(categoryOf(act({ actor: "seat:rail2", action: "/control/open.git", target: "as rail2" }))).toBe("orchestration");
  });
  test("a policy rule going off is said in words with its reason", () => {
    const l = lineOf(act({ actor: "policy", action: "policy/off", target: "spend-guard", detail: "weekly 94%" }));
    expect(l).toMatchObject({ who: "The policy", what: "turned a rule off", sub: "spend-guard · weekly 94%" });
  });
  test("a failure carries its reason and is flagged", () => {
    const l = lineOf(act({ ok: false, detail: "409 checks pending" }));
    expect(l.ok).toBe(false);
    expect(l.failure).toBe("409 checks pending");
  });
  test("a gate nobody answered names what settled it, not you and not nobody", () => {
    const row = gate({ resolution: "timeout", decided_by: null });
    expect(whoOf(row)).toBe("The timeout");
    expect(lineOf(row).sub).toContain("timeout");
    const ruled = gate({ resolution: "rule", decided_by: null });
    expect(`${lineOf(ruled).who} ${lineOf(ruled).what}`).toBe("A gate rule allowed Bash · make test");
    expect(whoOf(gate({ resolution: "restart", decided_by: null }))).toBe("The server restart");
  });
  test("plugin routes are the plugins category", () => {
    expect(categoryOf(act({ action: "/plugins/enable", target: "" }))).toBe("plugins");
    expect(lineOf(act({ action: "/plugins/enable", target: "" })).what).toBe("switched on plugin");
    expect(lineOf(act({ action: "/plugins/enable", target: "orbit-notes" })).what).toBe("switched on plugin orbit-notes");
  });
  test("a plugin route nobody named never prints a path", () => {
    const l = lineOf(act({ action: "/plugin/orbit-notes/rebuild-cache", target: "" }));
    expect(l.what).toBe("changed plugin (rebuild cache) orbit-notes");
    expect(l.what).not.toContain("/");
  });
});

describe("filters", () => {
  const rows = [act(), act({ action: "/plugins/disable" }), act({ ok: false, detail: "no" }), gate(), act({ actor: "seat:rail2", action: "/control/open.git" })];
  test("counts match what each chip keeps", () => {
    const c = filterCounts(rows);
    for (const f of ["settings", "plugins", "orchestration", "code", "gates", "failures"] as const)
      expect(narrow(rows, { filter: f, who: "", query: "" }).length).toBe(c[f]);
    expect(c.all).toBe(5);
    expect(c.failures).toBe(1);
  });
  test("chip counts follow the person and the search, as the page passes them", () => {
    const kept = narrow(rows, { filter: "all", who: "You", query: "" });
    const c = filterCounts(kept);
    for (const f of ["settings", "plugins", "orchestration", "code", "gates", "failures"] as const)
      expect(narrow(rows, { filter: f, who: "You", query: "" }).length).toBe(c[f]);
    expect(c.orchestration).toBe(0);
  });
  test("the Activity page counts chips over the narrowed rows", async () => {
    const src = await Bun.file(new URL("../src/components/settings/pages/ActivityPage.tsx", import.meta.url)).text();
    expect(src).toContain('filterCounts(narrow(rows ?? [], { filter: "all", who, query }))');
  });
  test("person narrows to their rows only", () => {
    expect(narrow(rows, { filter: "all", who: "Orchestrator rail2", query: "" }).length).toBe(1);
  });
  test("search looks in the sentence and the detail line, any case", () => {
    expect(narrow(rows, { filter: "all", who: "", query: "  PLUGIN " }).length).toBe(1);
    expect(narrow(rows, { filter: "all", who: "", query: "zzz" }).length).toBe(0);
  });
  test("0 rows and 40 people do not break", () => {
    expect(filterCounts([]).all).toBe(0);
    expect(whoOptions([])).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => act({ actor: `device-${i}` }));
    expect(whoOptions(many).length).toBe(40);
  });
  test("people are listed most active first", () => {
    const r = [act({ actor: "b" }), act({ actor: "a" }), act({ actor: "a" })];
    expect(whoOptions(r).map((p) => p.who)).toEqual(["a", "b"]);
  });
});

describe("relative time", () => {
  const now = 10 * 86_400_000;
  test.each([
    [now - 10_000, "just now"], [now - 5 * 60_000, "5 min ago"], [now - 3 * 3_600_000, "3 h ago"], [now - 2 * 86_400_000, "2 d ago"],
  ])("%p", (at, want) => expect(relativeTime(at, now)).toBe(want));
  test("a future timestamp is just now, never negative", () => expect(relativeTime(now + 5_000, now)).toBe("just now"));
});

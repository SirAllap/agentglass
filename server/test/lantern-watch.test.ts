/*
 * The Lantern's watch, as a pure question: given the field as the board sees
 * it, what needs a person — and what does the one notification say.
 */
import { describe, expect, test } from "bun:test";
import { findings, notice, FORGOTTEN_AFTER_MS } from "../src/lanternwatch.ts";
import type { BoardRow } from "../src/agentboard.ts";
import type { NamedAgent } from "../src/agentops.ts";

const NOW = 1_800_000_000_000;
const row = (p: Partial<BoardRow> & { name: string }): BoardRow => ({ from: "seen", state: "idle", ...p });
const named = (name: string, startedAt = NOW - 30 * 60_000): NamedAgent =>
  ({ name, kind: "claude", cwd: `/repo/wt/${name}`, paneId: "%1", windowId: "@1", startedAt, endedAt: null });

describe("what a look at the field flags", () => {
  test("nothing, on a quiet field: working agents and idle shells are not findings", () => {
    const rows = [
      row({ name: "worker", state: "working", doing: "the migration", saidAt: NOW - 60_000 }),
      row({ name: "%5", state: "idle", saidAt: NOW - 5 * 60 * 60_000 }),
    ];
    expect(findings({ rows, namedNow: [], namedBefore: [], now: NOW })).toEqual([]);
    expect(notice([])).toBeNull();
  });

  test("an agent stopped on a person is 'still waiting', with how long and why, and its pane", () => {
    const rows = [row({ name: "PR #12 review", state: "waiting", paneId: "%7", needsYou: { kind: "permission", why: "Claude needs your permission to run Bash", since: NOW - 23 * 60_000 } })];
    const f = findings({ rows, namedNow: [], namedBefore: null, now: NOW });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "waiting", name: "PR #12 review", pane: "%7" });
    expect(f[0]!.line).toContain("needs your permission");
    expect(f[0]!.line).toContain("23m");
    expect(f[0]!.line).toContain("to run Bash");
  });

  test("claimed work gone quiet for an hour is 'forgotten'; quiet for less is not; idle with no claim is not", () => {
    const quietLong = row({ name: "card-4411", state: "idle", doing: "fixing the export", saidAt: NOW - FORGOTTEN_AFTER_MS - 1 });
    const quietShort = row({ name: "card-4412", state: "idle", doing: "fixing the import", saidAt: NOW - 20 * 60_000 });
    const noClaim = row({ name: "%9", state: "idle", saidAt: NOW - 3 * 60 * 60_000 });
    const f = findings({ rows: [quietLong, quietShort, noClaim], namedNow: [], namedBefore: null, now: NOW });
    expect(f.map((x) => [x.kind, x.name])).toEqual([["forgotten", "card-4411"]]);
    expect(f[0]!.line).toContain("fixing the export");
    expect(f[0]!.line).toContain("1h");
  });

  test("a named agent that vanished since the last look is 'gone' — once, and never on the first look", () => {
    const first = findings({ rows: [], namedNow: [named("proj1")], namedBefore: null, now: NOW });
    expect(first).toEqual([]);
    const second = findings({ rows: [], namedNow: [], namedBefore: [named("proj1")], now: NOW });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ kind: "gone", name: "proj1" });
    expect(second[0]!.line).toContain("window is gone");
    // The next look has nothing before it that is not also alive now.
    expect(findings({ rows: [], namedNow: [], namedBefore: [], now: NOW })).toEqual([]);
  });

  test("waiting outranks gone outranks forgotten, and the oldest wait comes first", () => {
    const rows = [
      row({ name: "late", state: "idle", doing: "x", saidAt: NOW - 2 * FORGOTTEN_AFTER_MS }),
      row({ name: "newer-wait", state: "waiting", needsYou: { kind: "permission", why: "", since: NOW - 60_000 } }),
      row({ name: "older-wait", state: "waiting", needsYou: { kind: "gate", why: "held", since: NOW - 10 * 60_000 } }),
    ];
    const f = findings({ rows, namedNow: [], namedBefore: [named("dead")], now: NOW });
    expect(f.map((x) => x.name)).toEqual(["older-wait", "newer-wait", "dead", "late"]);
  });

  test("a turn that merely ended is not a finding until an hour has passed — a permission is one at once", () => {
    const fresh = row({ name: "answered", state: "waiting", needsYou: { kind: "input", why: "Claude is waiting for your input", since: NOW - 20 * 60_000 } });
    const stale = row({ name: "left-hanging", state: "waiting", needsYou: { kind: "input", why: "Claude is waiting for your input", since: NOW - FORGOTTEN_AFTER_MS - 1 } });
    const perm = row({ name: "blocked", state: "waiting", needsYou: { kind: "permission", why: "rm", since: NOW - 10_000 } });
    const f = findings({ rows: [fresh, stale, perm], namedNow: [], namedBefore: null, now: NOW });
    expect(f.map((x) => x.name)).toEqual(["left-hanging", "blocked"]);
  });
});

describe("the one notification a look sends", () => {
  test("a title that counts and a body that names, the first waiting pane riding along", () => {
    const rows = [
      row({ name: "a", state: "waiting", paneId: "%3", needsYou: { kind: "permission", why: "rm", since: NOW - 60_000 } }),
      row({ name: "b", state: "waiting", needsYou: { kind: "gate", why: "", since: NOW - 30_000 } }),
      row({ name: "c", state: "idle", doing: "thing", saidAt: NOW - 2 * FORGOTTEN_AFTER_MS }),
    ];
    const n = notice(findings({ rows, namedNow: [], namedBefore: [named("z")], now: NOW }))!;
    expect(n.title).toBe("🔦 Lantern: 2 need you · 1 gone · 1 looks forgotten");
    expect(n.body.split("\n")).toHaveLength(4);
    expect(n.body).toContain("• a needs your permission");
    expect(n.pane).toBe("%3");
  });
  test("more than four are counted, not listed", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ name: `w${i}`, state: "waiting", needsYou: { kind: "permission", why: "", since: NOW - i * 1000 } }));
    const n = notice(findings({ rows, namedNow: [], namedBefore: null, now: NOW }))!;
    expect(n.title).toBe("🔦 Lantern: 6 need you");
    expect(n.body.split("\n")).toHaveLength(5);
    expect(n.body).toContain("and 2 more on the Lantern");
  });
});

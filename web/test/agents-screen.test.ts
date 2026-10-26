/*
 * THE AGENTS SCREEN, AS DECISIONS.
 *
 * Real shapes (a board row, a held gate, a settings request) with invented
 * names: acme/orbit, ORBIT-1042. Every number on the three cards and every
 * sentence on a waiting card is one of these.
 */
import { describe, expect, test } from "bun:test";
import {
  ageWord, ageShort, agePct, projectLabel, doingVerb, askLine, matchFor, ruleTitleOf, parseRuleDiff,
  sortField, squares, spendPct, dollars, waitingItems, waitingMini, type RowLike, type GateLike,
} from "../src/lib/agentsScreen.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const row = (name: string, over: Partial<RowLike> = {}): RowLike => ({ name, state: "idle", paneId: "%1", saidAt: NOW - 5 * MIN, ...over });

describe("how long, in the card's words", () => {
  test("minutes, hours, days, floored", () => {
    expect(ageWord(3 * MIN + 59_000)).toBe("3 min");
    expect(ageWord(2 * HOUR + 59 * MIN)).toBe("2 h");
    expect(ageWord(42 * 86_400_000)).toBe("42 d");
    expect(ageWord(20_000)).toBe("now");
    expect(ageShort(2 * HOUR)).toBe("2h");
    expect(ageShort(3 * MIN)).toBe("3m");
  });
  test("the bar fills over four hours and is never empty", () => {
    expect(agePct(2 * HOUR)).toBe(50);
    expect(agePct(MIN)).toBe(2);
    expect(agePct(30 * HOUR)).toBe(100);
    expect(agePct(-5)).toBe(2);
  });
  test("a project is the last two folders", () => {
    expect(projectLabel("/home/a/code/acme/orbit/")).toBe("acme/orbit");
    expect(projectLabel("/orbit")).toBe("orbit");
  });
});

describe("what an agent is doing, and what a held call asks", () => {
  test("the verb comes from the tool, mcp prefixes cut", () => {
    expect(doingVerb("Read")).toEqual({ word: "Reading", icon: "file-text" });
    expect(doingVerb("Bash")).toEqual({ word: "Running", icon: "play" });
    expect(doingVerb("Edit")!.word).toBe("Writing");
    expect(doingVerb("mcp__plugin_x__Grep")!.word).toBe("Searching");
    expect(doingVerb("mcp__orbit__deploy")).toEqual({ word: "Using", icon: "play" });
    expect(doingVerb(undefined)).toBeNull();
  });
  test("a command is 'Run', a file edit is 'Write', anything else names the tool", () => {
    expect(askLine("Bash", "make check")).toEqual({ verb: "Run", target: "make check" });
    expect(askLine("Edit", "docs/guide.md")).toEqual({ verb: "Write", target: "docs/guide.md" });
    expect(askLine("mcp__orbit__deploy", "staging")).toEqual({ verb: "Use", target: "deploy staging" });
  });
  test("'Always allow here' becomes the habit, not the one-off", () => {
    expect(matchFor("Bash", "make check")).toBe("Bash(make check:*)");
    expect(matchFor("Bash", "npm test -- --watch")).toBe("Bash(npm test:*)");
    expect(matchFor("Edit", "docs/upload/guide.md")).toBe("Edit(docs/upload/**)");
    expect(matchFor("Edit", "guide.md")).toBe("Edit");
    expect(matchFor("mcp__orbit__deploy", "")).toBe("mcp__orbit__deploy");
  });
  test("a rule asked to loosen reads in plain words, and as Run-command when nobody named it", () => {
    expect(ruleTitleOf("Bash(git push:*)")).toBe("Push code");
    expect(ruleTitleOf("Bash(make deploy-staging:*)")).toBe("Run make deploy-staging");
    expect(parseRuleDiff("Bash(git push:*): never -> allow")).toEqual({ match: "Bash(git push:*)", from: "never", to: "allow" });
    expect(parseRuleDiff("Bash(gh pr create:*): no rule -> allow")!.from).toBe("no rule");
    expect(parseRuleDiff("something else")).toBeNull();
  });
});

describe("the field, sorted the way the three cards count", () => {
  const rows: RowLike[] = [
    row("scout-2", { state: "working" }), row("migrate-5", { state: "working" }), row("docs-4", { state: "working" }),
    row("builder-1", { state: "waiting", needsYou: { kind: "permission", why: "make check", since: NOW - 3 * MIN } }),
    row("reviewer-3", { state: "idle", saidAt: NOW - 40 * MIN }),
    row("tester-6", { state: "waiting", needsYou: { kind: "input", why: "", since: NOW - 2 * HOUR } }),
    row("ghost-1", { state: "idle", paneId: undefined, saidAt: NOW - 3 * HOUR }),
    row("orbit-lead", { role: "orchestrator", state: "working" }),
    row("lantern", { role: "lantern" }),
  ];
  const s = sortField(rows, NOW);
  test("working, blocked, idle; a turn that ended is idle, not an interruption", () => {
    expect(s.working.map((r) => r.name)).toEqual(["scout-2", "migrate-5", "docs-4"]);
    expect(s.blocked.map((r) => r.name)).toEqual(["builder-1"]);
    expect(s.idle.map((r) => r.name)).toEqual(["reviewer-3", "tester-6"]);
  });
  test("a name with no pane and hours of silence is folded away, and the readers of the board are not on it", () => {
    expect(s.gone.map((r) => r.name)).toEqual(["ghost-1"]);
    const all = [...s.working, ...s.blocked, ...s.idle, ...s.gone].map((r) => r.name);
    expect(all).not.toContain("orbit-lead");
    expect(all).not.toContain("lantern");
  });
  test("the squares: green, red, grey; at least four; capped with a count of the rest", () => {
    expect(squares({ working: 3, blocked: 1, idle: 2 })).toEqual({ kinds: ["g", "g", "g", "r", "i", "i"], more: 0 });
    expect(squares({ working: 0, blocked: 0, idle: 0 }).kinds).toEqual(["i", "i", "i", "i"]);
    expect(squares({ working: 14, blocked: 0, idle: 0 })).toMatchObject({ more: 4 });
    expect(squares({ working: 14, blocked: 0, idle: 0 }).kinds).toHaveLength(10);
  });
  test("spend bars are a share of $1, or of the busiest agent when that is more", () => {
    expect(spendPct(0.57, [0.02, 0.57, 0.31])).toBe(57);
    expect(spendPct(0.02, [0.02, 0.57])).toBe(2);
    expect(spendPct(5, [5, 10])).toBe(50);
    expect(dollars(0.5712)).toBe("$0.57");
    expect(dollars(143.4)).toBe("$143");
  });
});

describe("what waits on a person", () => {
  const blocked = [row("builder-1", { session: "sess-b1", branch: "fix/upload-retry", needsYou: { kind: "permission", why: "wants to run make check", since: NOW - 3 * MIN } })];
  const gate: GateLike = { id: "g1", session_id: "sess-b1", tool_name: "Bash", summary: "make check", created: NOW - 3 * MIN, pane: "%1" };
  const need = { id: "n1", text: "Two upload branches overlap. One PR, or two?", cost: "", recommend: "keep two", proof: "", created: NOW - 2 * HOUR };
  const request = { id: "rq1", setting: "agent.rules", label: "Agent rules", who: "docs-4", diff: ["Bash(git push:*): never -> allow", "project /home/a/code/acme/orbit"], at: NOW - MIN };
  const none = { blocked: [], gates: [], needs: [], asked: [], orphaned: [], beaten: [], requests: [] };

  test("a blocked agent with a held call carries the gate to answer; without one it can only be gone to", () => {
    const [a] = waitingItems({ ...none, blocked, gates: [gate] });
    expect(a).toMatchObject({ kind: "permission", name: "builder-1", branch: "fix/upload-retry", gate: { id: "g1", tool: "Bash", summary: "make check" } });
    const [b] = waitingItems({ ...none, blocked });
    expect(b).toMatchObject({ kind: "permission", name: "builder-1" });
    expect((b as { gate?: unknown }).gate).toBeUndefined();
  });
  test("a held call whose agent is not on the board is still drawn: somebody is held on it", () => {
    const [a] = waitingItems({ ...none, gates: [{ ...gate, session_id: "other", where: "orbit · scratch:1" }] });
    expect(a).toMatchObject({ kind: "permission", name: "orbit · scratch:1", gate: { id: "g1" } });
  });
  test("two blocked agents each take THEIR held call, and the longest-waiting comes first", () => {
    const rows = [
      row("builder-1", { session: "sess-b1", needsYou: { kind: "permission", why: "", since: NOW - 3 * MIN } }),
      row("docs-4", { session: "sess-d4", needsYou: { kind: "gate", why: "", since: NOW - MIN } }),
    ];
    const gates = [{ ...gate, id: "g-d4", session_id: "sess-d4", summary: "git push", created: NOW - MIN }, gate];
    const items = waitingItems({ ...none, blocked: rows, gates });
    expect(items.map((i) => i.kind === "permission" ? [i.name, i.gate?.id] : null)).toEqual([["builder-1", "g1"], ["docs-4", "g-d4"]]);
  });
  test("blocked agents are listed longest-waiting first, whatever order the board came in", () => {
    const rows = [
      row("docs-4", { needsYou: { kind: "gate", why: "", since: NOW - MIN } }),
      row("builder-1", { needsYou: { kind: "permission", why: "", since: NOW - 3 * MIN } }),
    ];
    expect(waitingItems({ ...none, blocked: rows }).map((i) => (i as { name: string }).name)).toEqual(["builder-1", "docs-4"]);
  });
  test("the blocked agent leads, then the oldest ask first: coordinator, then the rule request", () => {
    const items = waitingItems({ ...none, blocked, gates: [gate], needs: [need], requests: [request] });
    expect(items.map((i) => i.kind)).toEqual(["permission", "coordinator", "rule"]);
  });
  test("a rule request parses its diff; a request for something else does not pretend to", () => {
    const [r] = waitingItems({ ...none, requests: [request] });
    expect(r).toMatchObject({ kind: "rule", name: "docs-4", diff: { match: "Bash(git push:*)", from: "never", to: "allow" } });
    const [o] = waitingItems({ ...none, requests: [{ ...request, setting: "lantern.watch", diff: ["off -> on"] }] });
    expect((o as { diff: unknown }).diff).toBeNull();
  });
  test("an agent's own report, an orphan's, and a task that beat two agents each get a card", () => {
    const items = waitingItems({
      ...none,
      asked: [{ id: 1, agent: "docs-4", blocked: "", need: "a go on the push", at: NOW - HOUR }],
      orphaned: [{ id: 2, agent: "builder-9", blocked: "needs a review", need: "", at: NOW - 2 * HOUR }],
      beaten: [{ id: "t1", title: "Retry uploads on flaky network", attempts: 2, created: NOW - 3 * HOUR }],
    });
    expect(items.map((i) => i.kind)).toEqual(["task", "report", "report"]);
    expect((items[1] as { text: string }).text).toContain("no longer here");
  });
  test("the card's thin rows: the oldest three, the coordinator by that name, blocked red and the rest amber", () => {
    const items = waitingItems({ ...none, blocked, gates: [gate], needs: [need], requests: [request] });
    expect(waitingMini(items, NOW)).toEqual([
      { name: "builder-1", age: "3m", pct: 2, tone: "err" },
      { name: "coordinator", age: "2h", pct: 50, tone: "warn" },
      { name: "docs-4", age: "1m", pct: 2, tone: "warn" },
    ]);
  });
});

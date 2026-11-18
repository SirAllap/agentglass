/* Watching: sessions card, header chips and Lantern card preview, from the Lantern board's rows. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { liveSessions, stateOf, sessionLabel, idleSessions, previewRows, needCount } from "../src/lib/watchingSessions.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const src = readFileSync(new URL("../src/components/settings/pages/WatchingPage.tsx", import.meta.url), "utf8");
const row = (name: string, o: Partial<LanternRow> = {}): LanternRow => ({ name, state: "idle", ...o } as LanternRow);
const long = "orbit-api-ORBIT-1042-add-retry-budget-to-the-webhook-dispatcher-with-a-very-long-tail";

describe("session rows", () => {
  const rows = [
    row("a", { state: "working" }), row("b", { needsYou: { kind: "permission", why: "git push", since: 1 } }),
    row("c"), row("d", { gone: true } as Partial<LanternRow>), row("lantern", { role: "lantern" }), row(long, { state: "working", project: "orbit-api" }),
  ];
  test("live drops the Lantern's line and gone names", () => expect(liveSessions(rows).map((r) => r.name)).toEqual(["a", "b", "c", long]));
  test("state: needs you outranks working; the rest is idle", () => {
    expect(liveSessions(rows).map(stateOf)).toEqual(["working", "needs you", "idle", "working"]);
  });
  test("close idle targets only idle ones; need count", () => {
    expect(idleSessions(liveSessions(rows)).map((r) => r.name)).toEqual(["c"]);
    expect(needCount(liveSessions(rows))).toBe(1);
  });
  test("close idle never takes an orchestrator seat or a waiting row", () => {
    const r = [row("seat", { role: "orchestrator" }), row("wait", { state: "waiting" }), row("rest")];
    expect(idleSessions(r).map((x) => x.name)).toEqual(["rest"]);
  });
  test("close idle re-reads the board at click time and stops only what is still idle", () => {
    expect(src).toContain("await refreshLantern()");
    expect(src.indexOf("await refreshLantern()")).toBeLessThan(src.indexOf("idleSessions(liveSessions(lanternRows()))"));
    expect(idleSessions([row("went-back", { state: "working" }), row("still")]).map((x) => x.name)).toEqual(["still"]);
  });
  test("12 sessions with long names: the label keeps every character", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => row(`${long}-${i}`));
    for (const r of twelve) expect(sessionLabel(r)).toBe(r.name);
    expect(sessionLabel(row("x", { project: "orbit" }))).toBe("orbit / x");
  });
  test("preview: three cards, what needs you first", () => {
    const p = previewRows(liveSessions(rows));
    expect(p).toHaveLength(3);
    expect(p[0]!.name).toBe("b");
  });
});

describe("the page", () => {
  test("keeps its old rows and adds the sessions section", () => {
    for (const id of ["lantern.watch", "lantern.watchMinutes", "lantern.cacheTtlMinutes", "lantern.nudge", "lantern.nudgeMinutes"]) expect(src).toContain(`"${id}"`);
    expect(src).toContain('id: "sessions"');
    expect(src).toContain("The long names wrap; nothing is cut.");
  });
  test("header chips: hooks, Watching N, N need you", () => {
    expect(src).toContain('useReportHead("hooks"');
    expect(src).toContain("`Watching ${live.length}`");
    expect(src).toContain("`${need} need you`");
  });
  test("the card preview is the Lantern's own AgentCard; Close idle is the app's stop", () => {
    expect(src).toContain('import { AgentCard } from "../../LanternView.tsx"');
    expect(src).toContain("<AgentCard");
    expect(src).toContain("api.agentStop(");
    expect(src).not.toContain("truncate");
  });
});

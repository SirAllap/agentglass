// The dashboard's one-line verdict: what is running, what is stuck, what
// needs a person — read off the Lantern's board and nothing else.
//
// Every "counts" case is paired with the row it could be confused with,
// because a verdict that says "stuck" over a session that merely finished is
// the end of anybody reading the line:
//
//   needs you  vs  a turn that ended and waits for a prompt   (kind input)
//   stuck      vs  claimed work quiet under the hour           (not yet)
//   stuck      vs  a dead session with an old claim            (gone)
//   running    vs  the Lantern's own chat                      (role)
//   stuck      vs  a turn that ended minutes ago               (not yet)
import { test, expect } from "bun:test";
import { fleetVerdict } from "../src/lib/fleetVerdict.ts";
import { attention } from "../../shared/fieldRules.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const now = 1_800_000_000_000;
const min = 60_000;
const row = (name: string, over: Partial<LanternRow> = {}): LanternRow => ({ name, from: "seen", state: "idle", paneId: `%${name.length}`, ...over });
const working = (name: string, over: Partial<LanternRow> = {}) => row(name, { state: "working", ...over });
const blocked = (name: string, kind: "permission" | "gate" = "permission", over: Partial<LanternRow> = {}) =>
  row(name, { state: "waiting", needsYou: { kind, why: kind === "gate" ? "held at the gate: Bash — rm -rf dist" : "Claude needs your permission to use Bash", since: now - 4 * min }, ...over });
const quiet = (name: string, over: Partial<LanternRow> = {}) =>
  row(name, { from: "said", doing: "migrate the billing tables", saidAt: now - 90 * min, ...over });

test("nothing read yet is not 'all nominal'", () => {
  expect(fleetVerdict(null, now)).toBeNull();
});

test("an empty field is one calm line", () => {
  const v = fleetVerdict([], now)!;
  expect(v.tone).toBe("calm");
  expect(v.clauses.map((c) => c.text)).toEqual(["nothing running"]);
});

test("only working agents collapse to one calm line with the count", () => {
  const v = fleetVerdict([working("orbit-api"), working("orbit-web"), row("shell")], now)!;
  expect(v.tone).toBe("calm");
  expect(v.clauses).toHaveLength(1);
  expect(v.clauses[0]).toMatchObject({ kind: "running", count: 2, text: "2 running · all nominal" });
});

test("the Lantern's own chat is never counted as work", () => {
  const v = fleetVerdict([working("lantern", { role: "lantern" }), blocked("lantern2", "permission", { role: "lantern" })], now)!;
  expect(v.tone).toBe("calm");
  expect(v.clauses[0].text).toBe("nothing running");
});

test("a permission or a held gate needs you, and is the loud tone", () => {
  const v = fleetVerdict([working("orbit-api"), blocked("orbit-web", "permission"), blocked("acme-docs", "gate")], now)!;
  expect(v.tone).toBe("critical");
  const need = v.clauses.find((c) => c.kind === "need")!;
  expect(need).toMatchObject({ count: 2, tone: "critical", text: "2 need you" });
  expect(need.paneId).toBeUndefined();
});

test("one blocked agent is named, with why, and links to its pane", () => {
  const v = fleetVerdict([blocked("orbit-web", "permission", { paneId: "%7" })], now)!;
  expect(v.clauses.find((c) => c.kind === "need")).toMatchObject({
    count: 1, paneId: "%7", text: "orbit-web: Claude needs your permission to use Bash",
  });
});

test("a turn that ended is waiting, not blocked, and not a verdict", () => {
  const v = fleetVerdict([row("orbit-api", { state: "waiting", needsYou: { kind: "input", why: "", since: now - 3 * min } })], now)!;
  expect(v.tone).toBe("calm");
  expect(v.clauses.some((c) => c.kind === "need")).toBe(false);
});

test("claimed work quiet for over an hour is stuck — the watch's own rule", () => {
  const v = fleetVerdict([quiet("orbit-migrate", { paneId: "%3" })], now)!;
  expect(v.tone).toBe("warn");
  expect(v.clauses.find((c) => c.kind === "stuck")).toMatchObject({
    count: 1, paneId: "%3", tone: "warn", text: "orbit-migrate quiet for 2h on \"migrate the billing tables\"",
  });
});

test("claimed work quiet under the hour is not stuck yet", () => {
  const v = fleetVerdict([quiet("orbit-migrate", { saidAt: now - 40 * min })], now)!;
  expect(v.clauses.some((c) => c.kind === "stuck")).toBe(false);
});

test("a dead session with an old claim is gone, not stuck", () => {
  const v = fleetVerdict([quiet("orbit-old", { paneId: undefined, saidAt: now - 3 * 24 * 60 * min })], now)!;
  expect(v.clauses.some((c) => c.kind === "stuck")).toBe(false);
  expect(v.tone).toBe("calm");
});

test("the three answers come in the issue's order: running, stuck, needs you", () => {
  const v = fleetVerdict([blocked("a-web"), quiet("b-migrate"), quiet("c-docs"), working("d-api")], now)!;
  expect(v.clauses.map((c) => c.kind)).toEqual(["running", "stuck", "need"]);
  expect(v.clauses.map((c) => c.text)).toEqual(["1 running", "2 stuck", "a-web: Claude needs your permission to use Bash"]);
  expect(v.tone).toBe("critical");
});

test("the wait's own sentence stands alone — never 'needs your permission (… needs your permission …)'", () => {
  const v = fleetVerdict([blocked("orbit-web", "gate")], now)!;
  expect(v.clauses.find((c) => c.kind === "need")!.text).toBe("orbit-web: held at the gate: Bash — rm -rf dist");
});

test("a wait that came without a sentence is named by its kind", () => {
  const v = fleetVerdict([blocked("orbit-web", "gate", { needsYou: { kind: "gate", why: "", since: now } })], now)!;
  expect(v.clauses.find((c) => c.kind === "need")!.text).toBe("orbit-web: held at the gate");
});

test("a working seat counts as running, as the Lantern view counts it", () => {
  // The server marks the project's seat `role: "orchestrator"` (BoardRow.role).
  const v = fleetVerdict([working("orbit-seat", { role: "orchestrator" })], now)!;
  expect(v.clauses[0].text).toBe("1 running · all nominal");
});

test("a board that could not be read is unknown, not 'nothing running'", () => {
  // The store answers [] when its first read fails, so the rows alone would
  // draw a calm green line over a field nobody could see.
  expect(fleetVerdict([], now, true)).toBeNull();
  expect(fleetVerdict([working("orbit-api")], now, true)).toBeNull();
});

/*
 * THE STRIP AND THE WATCH'S NOTIFICATION ARE ONE RULE.
 *
 * They were two: the watch pushed "orbit-api is waiting for your next prompt —
 * 3h" while the strip, which left every ended turn out, read "nothing
 * running" in the calm colour. Both now sort a row by `attention` in
 * shared/fieldRules.ts, and the watch's side of this is asserted against the
 * same rule in server/test/lantern-watch.test.ts.
 */
const waitedFor = (name: string, ms: number) =>
  row(name, { state: "waiting", needsYou: { kind: "input", why: "Claude is waiting for your input", since: now - ms } });

test("a turn nobody came back to for three hours is stuck, as the watch notifies it", () => {
  const v = fleetVerdict([waitedFor("orbit-api", 3 * 60 * min)], now)!;
  expect(v.tone).toBe("warn");
  expect(v.clauses.find((c) => c.kind === "stuck")).toMatchObject({
    count: 1, tone: "warn", text: "orbit-api waiting for your next prompt for 3h",
  });
  expect(v.clauses.some((c) => c.kind === "need")).toBe(false);
});

test("the same turn three minutes old is neither stuck nor a need", () => {
  const v = fleetVerdict([waitedFor("orbit-api", 3 * min)], now)!;
  expect(v.tone).toBe("calm");
  expect(v.clauses).toHaveLength(1);
});

test("every row the rule flags is on the line, and no other", () => {
  const rows: LanternRow[] = [
    working("a-api"), row("b-shell"), blocked("c-web"), blocked("d-docs", "gate"),
    waitedFor("e-fresh", 20 * min), waitedFor("f-stale", 61 * min),
    quiet("g-migrate"), quiet("h-soon", { saidAt: now - 30 * min }),
    quiet("i-dead", { paneId: undefined, saidAt: now - 3 * 24 * 60 * min }),
    working("j-lantern", { role: "lantern" }), blocked("k-lantern", "permission", { role: "lantern" }),
  ];
  const by = (k: string) => rows.filter((r) => attention(r, now) === k).length;
  const v = fleetVerdict(rows, now)!;
  const count = (k: string) => v.clauses.find((c) => c.kind === k)?.count ?? 0;
  expect(count("need")).toBe(by("blocked"));
  expect(count("stuck")).toBe(by("left") + by("forgotten"));
  expect([count("need"), count("stuck")]).toEqual([2, 2]);
});

const verdictSrc = await Bun.file(new URL("../src/lib/fleetVerdict.ts", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the strip decides nothing about a wait or a silence by itself", () => {
  // A second copy of the rule is how the strip and the watch came apart.
  const src = code(verdictSrc);
  expect(src).toContain("attention(");
  expect(src).not.toContain("isForgotten(");
  expect(src).not.toContain("FORGOTTEN_AFTER_MS");
  expect(src).not.toMatch(/kind\s*[!=]==?\s*"input"/);
});

/*
 * ONE SCREEN, ONE COUNT.
 *
 * The strip counted the Lantern's board and the KPI tiles right under it
 * counted the hook-derived cards, so one screen read "1 running · 1 stuck ·
 * orbit-web needs your permission" in red over "WORKING 8 · WAITING 0". The
 * dashboard reads the verdict once and hands the same object to both.
 */
test("the verdict carries the three counts, including the ones with no clause", () => {
  expect(fleetVerdict([working("a-api"), working("b-web"), row("c-shell")], now)!.counts).toEqual({ running: 2, stuck: 0, need: 0 });
  expect(fleetVerdict([blocked("a-web"), quiet("b-migrate"), waitedFor("c-api", 2 * 60 * min), working("d-api")], now)!.counts)
    .toEqual({ running: 1, stuck: 2, need: 1 });
});

const src = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const kpisSrc = code(await src("../src/components/Kpis.tsx"));
const dashSrc = code(await src("../src/components/DashboardView.tsx"));
const stripSrc = code(await src("../src/components/FleetVerdictStrip.tsx"));

test("the KPI tiles count agents from the verdict, not from the cards", () => {
  expect(kpisSrc).not.toMatch(/status\s*===\s*"(working|waiting|stalled)"/);
  expect(kpisSrc).toContain("fleet?.counts.running");
  expect(kpisSrc).toContain("fleet?.counts.need");
});

test("the dashboard reads the verdict once and gives both the same one", () => {
  expect(dashSrc.match(/useFleetVerdict\(/g)).toHaveLength(1);
  const name = dashSrc.match(/const (\w+) = useFleetVerdict\(/)?.[1];
  expect(name).toBeTruthy();
  expect(dashSrc).toContain(`<FleetVerdictStrip verdict={${name}}`);
  expect(dashSrc).toMatch(new RegExp(`<Kpis [^>]*fleet=\\{${name}\\}`));
  // The strip draws what it is given; it does not read the board again.
  const body = stripSrc.slice(stripSrc.indexOf("export function FleetVerdictStrip("));
  expect(body).not.toContain("fleetVerdict(");
  expect(body).not.toContain("useSyncExternalStore(");
});

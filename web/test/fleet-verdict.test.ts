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
import { test, expect } from "bun:test";
import { fleetVerdict } from "../src/lib/fleetVerdict.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const now = 1_800_000_000_000;
const min = 60_000;
const row = (name: string, over: Partial<LanternRow> = {}): LanternRow => ({ name, from: "seen", state: "idle", paneId: `%${name.length}`, ...over });
const working = (name: string, over: Partial<LanternRow> = {}) => row(name, { state: "working", ...over });
const blocked = (name: string, kind: "permission" | "gate" = "permission", over: Partial<LanternRow> = {}) =>
  row(name, { state: "waiting", needsYou: { kind, why: "Bash", since: now - 4 * min }, ...over });
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
    count: 1, paneId: "%7", text: "orbit-web needs your permission (Bash)",
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
  expect(v.clauses.map((c) => c.text)).toEqual(["1 running", "2 stuck", "a-web needs your permission (Bash)"]);
  expect(v.tone).toBe("critical");
});

test("a held gate says so in its own words", () => {
  const v = fleetVerdict([blocked("orbit-web", "gate", { needsYou: { kind: "gate", why: "", since: now } })], now)!;
  expect(v.clauses.find((c) => c.kind === "need")!.text).toBe("orbit-web held at the gate");
});

test("a board that could not be read is unknown, not 'nothing running'", () => {
  // The store answers [] when its first read fails, so the rows alone would
  // draw a calm green line over a field nobody could see.
  expect(fleetVerdict([], now, true)).toBeNull();
  expect(fleetVerdict([working("orbit-api")], now, true)).toBeNull();
});

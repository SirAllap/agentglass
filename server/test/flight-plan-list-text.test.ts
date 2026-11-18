/*
 * `GET /flight-plan/plans` used to copy every plan's text (up to 200 plans of
 * up to 200 KB) on every call: 690k disk blocks, a 3.5 s stall. The list now
 * reads heads without the text, and a plan's size and sensitive-path hit are
 * read once per edit. Counted as text bytes pulled out of `plan_md`.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-fp-text-"));
process.env.XDG_CONFIG_HOME = HOME;
const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const root = join(HOME, "orbit");
const text = (i: number) => `# Plan ${i}\n` + "x".repeat(60_000);
const ids: string[] = [];
for (let i = 0; i < 500; i++) {
  const p = Plans.createPlan({ root, title: `p${i}`, request: "r", visual: false });
  Plans.patchPlan(p.id, { planMd: i === 0 ? text(i) + "\nchange migrations/0001.sql" : text(i) });
  ids.push(p.id);
}

/** One list call as the route does it: heads, then per plan its size and hit. Returns how many plan texts were read. */
function textReads(): { reads: number; rows: number } {
  const before = Flight.planFactsMisses();
  const heads = Plans.listPlanHeads({ root });
  for (const h of heads) { expect("planMd" in h).toBe(false); Flight.planFacts(h); }
  return { reads: Flight.planFactsMisses() - before, rows: heads.length };
}

test("a cold list of 500 plans reads no plan text; an edit costs none", () => {
  // The facts are stored when the text is written, so a fresh process (the module state is only a counter) reads none.
  expect(textReads()).toEqual({ reads: 0, rows: 200 });
  expect(textReads().reads).toBe(0);
  Plans.patchPlan(ids[499], { planMd: text(1) + "\nand a secrets rotation" });
  expect(textReads().reads).toBe(0);
});

test("plans written without facts are filled in by the backfill, not by the list", async () => {
  const { db } = await import("../src/db.ts");
  const old = ids.slice(0, 10);
  for (const id of old) db.query(`UPDATE flight_plan SET facts_at = NULL, text_bytes = NULL, text_hit = NULL WHERE id = ?`).run(id);
  const before = Flight.planFactsMisses();
  expect(await Flight.backfillPlanFacts(1)).toBeGreaterThanOrEqual(10);
  expect(Flight.planFactsMisses() - before).toBeGreaterThanOrEqual(10);
  expect(textReads().reads).toBe(0);
  expect(Flight.planFacts(Plans.planHeadOf(ids[0])!).hit).not.toBeNull(); // the migrations/ plan keeps its hit
});

test("the head query is answered from the covering index, not the table", async () => {
  const { db } = await import("../src/db.ts");
  const plan = db.query<{ detail: string }, [null, null, null, null]>(`EXPLAIN QUERY PLAN ${Plans.LIST_HEADS_SQL}`).all(null, null, null, null).map((r) => r.detail).join(" ");
  expect(plan).toContain("COVERING INDEX flight_plan_head");
});

test("the facts match the text: bytes, and the hit follows an edit", () => {
  const h = Plans.listPlanHeads({ root }).find((x) => x.id === ids[499])!;
  const f = Flight.planFacts(h);
  expect(f.bytes).toBe(Buffer.byteLength(Plans.getPlan(ids[499])!.planMd));
  expect(f.hit).not.toBeNull();
  Plans.patchPlan(ids[499], { planMd: "# clean plan" });
  const g = Flight.planFacts(Plans.planHeadOf(ids[499])!);
  expect(g.bytes).toBe(12);
  expect(g.hit).toBeNull();
});

test("a head answers stopReason and builderLaunch the same as the full plan", () => {
  const full = Plans.getPlan(ids[0])!;
  const { planMd: _t, ...head } = full;
  const role = { provider: "claude", model: "sonnet" };
  expect(Flight.builderLaunch(head, role, "auto", "opus")).toEqual(Flight.builderLaunch(full, role, "auto", "opus"));
  expect(Flight.stopReason(head)).toEqual(Flight.stopReason(full));
});

test("a write that only bumps updated_at keeps the facts: no text read after a worker change", () => {
  const id = ids[300];
  const before = Flight.planFactsMisses();
  Plans.setWorker(id, "w1");
  Plans.setWorker(id, null);
  expect(Flight.planFacts(Plans.planHeadOf(id)!).bytes).toBe(Buffer.byteLength(Plans.getPlan(id)!.planMd));
  expect(Flight.planFactsMisses() - before).toBe(0);
});

test("the backfill yields to the loop after every plan", async () => {
  const { db } = await import("../src/db.ts");
  for (const id of ids.slice(20, 25)) db.query(`UPDATE flight_plan SET facts_at = NULL WHERE id = ?`).run(id);
  let ticks = 0; const t = setInterval(() => ticks++, 0);
  const n = await Flight.backfillPlanFacts(2);
  clearInterval(t);
  expect(n).toBe(5);
  expect(ticks).toBeGreaterThanOrEqual(5);
});

test("storedFacts seeks by primary key, not the wide index", async () => {
  const { db } = await import("../src/db.ts");
  const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT text_bytes, text_hit, facts_at FROM flight_plan WHERE id = ?`).all().map((r) => r.detail).join(" ");
  expect(plan).toMatch(/SEARCH.*(PRIMARY KEY|id=)/);
  expect(plan).not.toContain("flight_plan_head");
  expect(Plans.storedFacts.toString()).not.toContain("INDEXED BY"); // the real function, not a copy of its SQL
});

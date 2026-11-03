import { test, expect, describe } from "bun:test";
import { crewState, QUIET_AFTER_MS, ageWord, baseName, orreryLayout, RINGS, compareCrew } from "../src/lib/starboardCrew.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const NOW = 1_000_000_000;
const row = (o: Partial<LanternRow> = {}): LanternRow => ({ name: "orbit-api", from: "said", state: "idle", saidAt: NOW - 600_000, ...o });

test("a permission or a gate waiting on you is waiting on you; a turn that ended is finished", () => {
  expect(crewState(row({ needsYou: { kind: "permission", why: "wants to run Bash", since: NOW - 5000 } }), NOW).state).toBe("ask");
  expect(crewState(row({ needsYou: { kind: "gate", why: "held", since: NOW - 5000 } }), NOW).state).toBe("ask");
  expect(crewState(row({ needsYou: { kind: "input", why: "", since: NOW - 5000 } }), NOW).state).toBe("done");
});

test("working, quiet and gone; nothing is ever called stuck", () => {
  expect(crewState(row({ state: "working" }), NOW).state).toBe("working");
  expect(crewState(row({ state: "idle", saidAt: NOW - 3 * 3600_000 }), NOW)).toEqual({ state: "quiet", since: NOW - 3 * 3600_000 });
  expect(crewState(row({ gone: true }), NOW).state).toBe("done");
});

test("an idle session with a live pane is still working", () => {
  expect(crewState(row({ state: "idle", alive: true }), NOW).state).toBe("working");
});

test("a stopped session is finished until it has been silent ten minutes, then quiet", () => {
  expect(crewState(row({ saidAt: NOW - QUIET_AFTER_MS + 1000 }), NOW).state).toBe("done");
  expect(crewState(row({ saidAt: NOW - QUIET_AFTER_MS }), NOW).state).toBe("quiet");
});

test("ages are coarse words", () => {
  expect(ageWord(NOW - 12_000, NOW)).toBe("12 s");
  expect(ageWord(NOW - 5 * 60_000, NOW)).toBe("5 min");
  expect(ageWord(NOW - 2 * 3600_000, NOW)).toBe("2 h");
});

test("the orrery gives each project a ring, largest first, and never more than RINGS", () => {
  const rows = [
    ...["a", "b", "c"].map((n) => row({ name: n, project: "acme/orbit" })),
    row({ name: "d", project: "acme/ledger" }),
    ...["e", "f", "g"].map((n, i) => row({ name: n, project: `acme/p${i}` })),
  ];
  const { placed, projects, projectCount } = orreryLayout(rows);
  expect(projectCount).toBe(5);
  expect(placed.length).toBe(rows.length);
  expect(projects[0]).toBe("acme/orbit");
  expect(projects.length).toBe(RINGS);
  expect(Math.max(...placed.map((p) => p.ring))).toBe(RINGS - 1);
  expect(placed.filter((p) => p.ring === 0).length).toBe(3);
});

// A project is a checkout path on the board; a card names the folder, not the home directory.
test("baseName keeps the folder name and ignores a trailing slash", () => {
  expect(baseName("/home/dev/code/acme-orbit")).toBe("acme-orbit");
  expect(baseName("/home/dev/code/acme-orbit/")).toBe("acme-orbit");
  expect(baseName("orbit")).toBe("orbit");
});

test("the orrery's type went up on rungs the app already sets", async () => {
  const { ORRERY_TYPE, orreryType } = await import("../src/lib/starboardCrew.ts");
  const used = new Set<number>();
  const src = `${import.meta.dir}/../src`;
  for (const f of new Bun.Glob("**/*.tsx").scanSync({ cwd: src })) {
    for (const m of (await Bun.file(`${src}/${f}`).text()).matchAll(/text-\[([\d.]+)px\]/g)) used.add(Number(m[1]));
  }
  expect(Object.values(ORRERY_TYPE).sort((a, b) => a - b)).toEqual([10.5, 11.5, 12, 14]);
  for (const px of Object.values(ORRERY_TYPE)) expect(used.has(px)).toBe(true);
  expect(ORRERY_TYPE.ring).toBeGreaterThan(11);
  expect(ORRERY_TYPE.name).toBeGreaterThan(13.5);
  expect(ORRERY_TYPE.sub).toBeGreaterThan(10.5);
  // The rung is a floor: the label is never drawn smaller than it, and grows
  // with the view above --sb-u 1.
  expect(orreryType(ORRERY_TYPE.name, 0.8)).toBe(14);
  expect(orreryType(ORRERY_TYPE.name, 1.18)).toBeCloseTo(16.52, 1);
});

describe("the Crew list's order", () => {
  const row = (state: "ask" | "working" | "quiet" | "done", since: number, cost: number) => ({ state, since, cost });
  test("a worker that ended a minute ago for six cents is above a dear session from yesterday", () => {
    const rows = [row("done", 1_000, 175), row("done", 90_000, 0.06), row("done", 50_000, 9)];
    expect(rows.sort(compareCrew).map((r) => r.cost)).toEqual([0.06, 9, 175]);
  });
  test("state still comes first, and an equal time falls back to the dearest", () => {
    expect([row("done", 5, 1), row("ask", 1, 1), row("working", 1, 1)].sort(compareCrew).map((r) => r.state)).toEqual(["ask", "working", "done"]);
    expect([row("done", 5, 1), row("done", 5, 3)].sort(compareCrew).map((r) => r.cost)).toEqual([3, 1]);
  });
});

import { test, expect } from "bun:test";
import { crewState, QUIET_AFTER_MS, ageWord, baseName, orreryLayout, RINGS } from "../src/lib/starboardCrew.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const NOW = 1_000_000_000;
const row = (o: Partial<LanternRow> = {}): LanternRow => ({ name: "orbit-api", from: "said", state: "idle", saidAt: NOW - 600_000, ...o });

test("a permission or a held gate is waiting on you; a turn that ended is finished", () => {
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

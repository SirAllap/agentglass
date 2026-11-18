/*
 * The stand-in Jira can look lived in for a screen: Orbit lists components, some cards carry one, and the active sprint ends
 * a few days ahead, so the sidebar draws rings and the top bar shows "S4 · 6 days left". Off by default, so no other test moves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const DAY = 86_400_000;
let fake: FakeJira | null = null;
afterEach(async () => { await fake?.stop(); fake = null; });

describe("the lively stand-in", () => {
  test("the active sprint of the Orbit board ends six calendar days from now and began before today", async () => {
    fake = startFakeJira({ lively: true });
    const s = fake.state.sprints[3]!.find((x) => x.state === "active")!;
    const end = Date.parse(s.endDate!);
    expect(Math.floor(end / DAY) - Math.floor(Date.now() / DAY)).toBe(6);
    expect(Date.parse(s.startDate!)).toBeLessThan(Date.now());
    expect(s.name).toBe("Sprint 4");
  });

  test("Orbit lists three components and a card that carries the sprint is still in it", async () => {
    fake = startFakeJira({ lively: true });
    expect(fake.state.projectComponents.ORBIT!.map((c) => c.name)).toEqual(["Sync", "Api", "Web"]);
    expect(fake.state.issues["ORBIT-1043"]!.components).toEqual(["Api"]);
    expect(fake.state.issues["ORBIT-1043"]!.sprints.map((x) => x.name)).toContain("Sprint 4");
  });

  test("a card that already had a component keeps it", async () => {
    const plain = startFakeJira();
    const had = Object.values(plain.state.issues).filter((i) => i.components?.length).map((i) => [i.key, i.components] as const);
    await plain.stop();
    fake = startFakeJira({ lively: true });
    for (const [key, comps] of had) expect(fake.state.issues[key]!.components).toEqual(comps);
  });

  test("reset keeps it lively, and the default seed is the plain one", async () => {
    fake = startFakeJira({ lively: true });
    fake.reset();
    expect(fake.state.projectComponents.ORBIT).toHaveLength(3);
    await fake.stop();
    fake = startFakeJira();
    expect(fake.state.projectComponents).toEqual({});
    expect(fake.state.sprints[3]!.find((x) => x.state === "active")!.endDate).toBe("2026-10-19T09:00:00.000Z");
  });
});

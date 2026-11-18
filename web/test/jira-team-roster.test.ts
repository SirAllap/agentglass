/*
 * The sidebar's Team row, built from the project's own roster (an invented ORBIT project, invented people) rather than
 * only the assignees of the loaded cards: a reporter with no card of their own still shows, with a count of 0.
 */
import { describe, expect, test } from "bun:test";
import { mergeTeam, teamOf } from "../src/lib/jiraTree.ts";

const ROSTER = [
  { key: "acc-ada", name: "Ada Example" },
  { key: "acc-grace", name: "Grace Sample" },
  { key: "acc-lin", name: "Lin Tester" },
];

describe("the project's roster, not just the loaded cards' assignees", () => {
  test("a roster member with no card still shows, at 0", () => {
    const cardTeam = teamOf([{ assignees: ["Ada Example"], people: [{ key: "acc-ada", name: "Ada Example" }] }]);
    const merged = mergeTeam(ROSTER, cardTeam);
    expect(merged.map((m) => [m.name, m.count])).toEqual([["Ada Example", 1], ["Grace Sample", 0], ["Lin Tester", 0]]);
    expect(merged.every((m) => m.key)).toBe(true);
  });

  test("most cards first, ties by name; nobody on any card is still the whole roster at 0", () => {
    const merged = mergeTeam(ROSTER, []);
    expect(merged.map((m) => m.name)).toEqual(["Ada Example", "Grace Sample", "Lin Tester"]);
    expect(merged.every((m) => m.count === 0)).toBe(true);
  });

  test("a card holder the roster left out still keeps their count, appended after it", () => {
    const cardTeam = teamOf([{ assignees: ["Margaret Offboard"], people: [{ key: "acc-margaret", name: "Margaret Offboard" }] }]);
    const merged = mergeTeam(ROSTER, cardTeam);
    expect(merged.find((m) => m.name === "Margaret Offboard")).toEqual({ name: "Margaret Offboard", count: 1, key: "acc-margaret" });
    expect(merged).toHaveLength(4);
  });

  test("two accounts sharing a display name keep separate counts, by account id", () => {
    const cardTeam = teamOf([
      { assignees: ["Jordan Acme"], people: [{ key: "acc-jordan-1", name: "Jordan Acme" }] },
      { assignees: ["Jordan Acme"], people: [{ key: "acc-jordan-2", name: "Jordan Acme" }] },
      { assignees: ["Jordan Acme"], people: [{ key: "acc-jordan-1", name: "Jordan Acme" }] },
    ]);
    const byId = new Map(cardTeam.map((m) => [m.key, m.count]));
    expect(byId.get("acc-jordan-1")).toBe(2);
    expect(byId.get("acc-jordan-2")).toBe(1);
    expect(cardTeam.filter((m) => m.name === "Jordan Acme")).toHaveLength(2);
  });
});

import { describe, expect, test } from "bun:test";
import { peopleMembers, priorityChoices, sprintChoices, sprintEmptyNote, statusOptions } from "../src/components/jira/list/bulkPickers.ts";

const day = Date.UTC(2026, 0, 5);
describe("bulk pickers", () => {
  test("sprints: active first, then future in order, next tagged", () => {
    const c = sprintChoices({ sprint: { id: "1", name: "Orbit 12", state: "active", start: day, end: day + 12096e5 }, futures: [{ id: "2", name: "Orbit 13", start: day + 12096e5, end: 0 }, { id: "3", name: "Orbit 14", start: 0, end: 0 }] } as never);
    expect(c.map((x) => [x.id, x.tag])).toEqual([["1", "Current"], ["2", "Next"], ["3", ""]]);
    expect(c[0]!.dates).not.toBe("");
  });
  test("sprints: none open says so only when the board was read", () => {
    expect(sprintEmptyNote({ ok: true }, [])).toBe("No open sprints on this board");
    expect(sprintEmptyNote(null, [])).toBeNull();
    expect(sprintEmptyNote({}, [{ id: "1", name: "a", dates: "", tag: "" }])).toBeNull();
  });
  test("sprints: only a next sprint still lists it", () => {
    expect(sprintChoices({ next: { id: "9", name: "Orbit 20", start: 0, end: 0 } } as never).map((x) => x.id)).toEqual(["9"]);
  });
  test("statuses: pill, board colour, done ones quiet", () => {
    const o = statusOptions(["To Do", "Done", "Odd"], [{ status: "To Do", type: "open", orderindex: 0, color: "#aabbcc" }, { status: "Done", type: "done", orderindex: 1, color: "#00ff00" }]);
    expect(o[0]).toMatchObject({ value: "To Do", pill: true, tint: "#aabbcc" });
    expect(o[1]).toMatchObject({ dim: true });
    expect(o[2]!.tint).toBeUndefined();
  });
  test("priorities keep the site order and get an ink each", () => {
    const p = priorityChoices([{ id: "1", name: "Highest" }, { id: "2", name: "Lowest" }]);
    expect(p.map((x) => x.label)).toEqual(["Highest", "Lowest"]);
    expect(p[0]!.c).not.toBe(p[1]!.c);
  });
  test("people keep their email and handle", () => {
    const m = peopleMembers([{ key: "k1", id: "k1", name: "Mira Orbit", email: "mira@example.com" }]);
    expect(m[0]).toMatchObject({ id: 0, name: "Mira Orbit", initials: "MO", email: "mira@example.com" });
  });
});

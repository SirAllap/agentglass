/*
 * The decisions behind the card's Assignees row, pulled out of the screen.
 *
 * What the row says, who may open the sheet, what is staged and what the
 * footer says about it, what a refused write means, and what "Undo" sends
 * back. There is no renderer here, so the screen only draws these answers.
 */
import { describe, expect, test } from "bun:test";
import {
  appliedDiff, applyLabel, peopleKey, assigneeAccess, assigneeConflict, assigneeLine, assigneeOptions, currentIds, isEmpty, nameIn, remaining,
  rowTag, stagedDiff, summaryParts, summaryText, undoDiff, type Person,
} from "../src/model/cardAssignees.ts";
import { toggled } from "../src/model/prFilters.ts";
import { READ_ONLY_PHONE, WRITES_OFF } from "../src/model/cardStatus.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const person = (id: number, name: string, over: Partial<Person> = {}): Person => ({ id, name, initials: name[0]!.toUpperCase(), ...over });
const ada = person(1, "ada", { me: true, email: "ada@acme.test" });
const bob = person(2, "bob", { email: "bob@acme.test" });
const cy = person(3, "cy", { email: "cy@acme.test" });
const dee = person(4, "dee");
const nameOf = (id: number): string => [ada, bob, cy, dee].find((p) => p.id === id)?.name ?? `#${id}`;

const task = (over: Partial<ProviderTask>): ProviderTask => ({
  id: "t1", title: "Add retry to sync", url: "", status: "In Review", statusKind: "open", priority: null,
  due: null, updated: 1_000_000, tags: [], list: "Orbit Sprint", assignees: [], ...over,
});

describe("who can edit assignees", () => {
  test("only a full phone, on a computer that lets ClickUp be written to, with a list to read members from", () => {
    expect(assigneeAccess("full", true, "L1")).toEqual({ can: true, why: null });
  });

  test("a phone paired for less is told what pairing again buys it, in these words", () => {
    for (const scope of ["read", "answer", null, undefined] as const) {
      const a = assigneeAccess(scope, true, "L1");
      expect(a.can).toBe(false);
      expect(a.why).toContain("Pair again with full access to edit assignees.");
      expect(a.why).not.toBe(READ_ONLY_PHONE);
    }
  });

  test("writes switched off is the computer's sentence, the same one the status row gives", () => {
    expect(assigneeAccess("full", false, "L1")).toEqual({ can: false, why: WRITES_OFF });
  });

  test("not yet known, or a card with no list, is neither allowed nor an accusation", () => {
    expect(assigneeAccess("full", null, "L1")).toEqual({ can: false, why: null });
    expect(assigneeAccess("full", true, null)).toEqual({ can: false, why: null });
    expect(assigneeAccess("full", true, "")).toEqual({ can: false, why: null });
  });
});

describe("the row", () => {
  test("names everybody, you first and marked", () => {
    const people = [{ ...bob, me: undefined }, { ...ada }];
    expect(assigneeLine({ people, assignees: ["bob", "ada"] })).toBe("ada (you), bob");
  });

  test("falls back to the board's own names when it gave no people, and says nobody when empty", () => {
    expect(assigneeLine({ assignees: ["bob", "cy"] })).toBe("bob, cy");
    expect(assigneeLine({ people: [], assignees: [] })).toBe("Nobody");
  });

  test("only people with an id can be staged", () => {
    expect(currentIds([{ id: 1, name: "ada", initials: "A" }, { name: "Guest", initials: "G" }])).toStrictEqual([1]);
    expect(currentIds(undefined)).toEqual([]);
  });
});

describe("who the sheet lists", () => {
  test("you first, the rest in the list's own order", () => {
    expect(assigneeOptions([bob, cy, ada, dee], undefined, "").map((p) => p.name)).toEqual(["ada", "bob", "cy", "dee"]);
  });

  test("somebody on the card the list did not name is still there, to be taken off", () => {
    const guest = { id: 9, name: "gus", initials: "G" };
    expect(assigneeOptions([ada, bob], [guest], "").map((p) => p.id)).toEqual([1, 2, 9]);
    expect(assigneeOptions([ada, bob], [{ id: 2, name: "bob", initials: "B" }], "")).toHaveLength(2);
  });

  test("search matches name or email, ignoring case and padding", () => {
    expect(assigneeOptions([ada, bob, cy], undefined, " CY ").map((p) => p.id)).toEqual([3]);
    expect(assigneeOptions([ada, bob, cy], undefined, "bob@acme").map((p) => p.id)).toEqual([2]);
    expect(assigneeOptions([ada, bob, cy], undefined, "zed")).toEqual([]);
  });
});

describe("what is staged", () => {
  test("a tap flips one person and leaves the rest", () => {
    expect(toggled([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggled([1, 2], 2)).toEqual([1]);
  });

  test("the diff is what differs from the card, by id", () => {
    expect(stagedDiff([1, 2], [1, 3])).toEqual({ add: [3], rem: [2] });
    expect(stagedDiff([1, 2], [1, 2])).toEqual({ add: [], rem: [] });
    expect(isEmpty(stagedDiff([1, 2], [2, 1]))).toBe(true);
  });

  test("tapping somebody twice stages nothing", () => {
    expect(isEmpty(stagedDiff([1], toggled(toggled([1], 3), 3)))).toBe(true);
  });

  test("a row says Add or Remove only when it differs", () => {
    expect(rowTag(3, [1, 2], [1, 3])).toBe("Add");
    expect(rowTag(2, [1, 2], [1, 3])).toBe("Remove");
    expect(rowTag(1, [1, 2], [1, 3])).toBeNull();
    expect(rowTag(4, [1, 2], [1, 3])).toBeNull();
  });
});

describe("the footer", () => {
  test("the button counts the changes and is off when there are none", () => {
    expect(applyLabel({ add: [3], rem: [2] })).toEqual({ label: "Apply 2 changes", enabled: true });
    expect(applyLabel({ add: [3], rem: [] })).toEqual({ label: "Apply 1 change", enabled: true });
    expect(applyLabel({ add: [], rem: [] })).toEqual({ label: "Nothing to apply", enabled: false });
  });

  test("the line says who is added and who is removed, and is empty when nothing is", () => {
    expect(summaryText({ add: [3], rem: [2] }, nameOf)).toBe("+ cy − bob");
    expect(summaryText({ add: [3, 4], rem: [] }, nameOf)).toBe("+ cy, dee");
    expect(summaryText({ add: [], rem: [2] }, nameOf)).toBe("− bob");
    expect(summaryText({ add: [], rem: [] }, nameOf)).toBe("");
  });

  test("the pieces are what the screen colours: one for who comes, one for who goes", () => {
    expect(summaryParts({ add: [3], rem: [2] }, nameOf)).toEqual(["+ cy", "− bob"]);
    expect(summaryParts({ add: [], rem: [2] }, nameOf)).toEqual(["− bob"]);
  });

  test("a name is found by id, and an id never reaches a sentence", () => {
    expect(nameIn([ada, bob], 2)).toBe("bob");
    expect(nameIn([ada, bob], 77)).toBe("someone");
  });
});

describe("a write that lost a race", () => {
  const diff = { add: [3], rem: [2] };
  const p = (id: number) => ({ id, name: nameOf(id), initials: "X" });

  test("says what applying now would still do to the card as it is", () => {
    const c = assigneeConflict({ theirs: task({ people: [p(1), p(2)] }), diff, nameOf, now: 1_000_000 + 120_000 });
    expect(c.text).toBe("Somebody changed this card 2 min ago. Applying now would add cy and remove bob.");
    expect(c).toMatchObject({ keep: "Keep theirs", overwrite: "Apply anyway" });
  });

  test("leaves out what the other person already did", () => {
    const c = assigneeConflict({ theirs: task({ people: [p(1), p(2), p(3)] }), diff, nameOf, now: 1_000_000 + 60_000 });
    expect(c.text).toBe("Somebody changed this card 1 min ago. Applying now would remove bob.");
  });

  test("offers no overwrite when the card is already as wanted", () => {
    const c = assigneeConflict({ theirs: task({ people: [p(1), p(3)] }), diff, nameOf, now: 1_000_000 });
    expect(c.overwrite).toBeNull();
    expect(c.text).toBe("Somebody already made this change just now.");
  });

  test("what is left is the change against their card, not against ours", () => {
    expect(remaining({ add: [3], rem: [2] }, [1, 3])).toEqual({ add: [], rem: [] });
    expect(remaining({ add: [3], rem: [2] }, [1, 2])).toEqual({ add: [3], rem: [2] });
  });
});

describe("undo", () => {
  test("puts back exactly what the write changed", () => {
    expect(undoDiff({ add: [3], rem: [2] }, [1, 3])).toEqual({ add: [2], rem: [3] });
  });

  test("leaves alone whoever somebody else has since changed", () => {
    // cy was taken off again by a colleague, and bob put back: nothing to undo.
    expect(undoDiff({ add: [3], rem: [2] }, [1, 2])).toBeNull();
    // bob is back already, cy still there: only cy is taken off.
    expect(undoDiff({ add: [3], rem: [2] }, [1, 2, 3])).toEqual({ add: [], rem: [3] });
  });

  test("nothing applied, nothing to undo", () => {
    expect(undoDiff(null, [1])).toBeNull();
  });
});

describe("what an applied-anyway write changed", () => {
  const cards = { people: [{ id: 1, name: "ada", initials: "X" }, { id: 3, name: "cy", initials: "X" }] };
  test("undo removes only who this write added, not whom a colleague added first", () => {
    // Staged +cy +dan; cy was added by a colleague before "Apply anyway".
    const did = appliedDiff({ add: [3, 4], rem: [] }, cards.people);
    expect(did).toEqual({ add: [4], rem: [] });
    expect(undoDiff(did, [1, 3, 4])).toEqual({ add: [], rem: [4] });
  });
  test("a write that was not re-read changed what it asked", () => {
    expect(appliedDiff({ add: [3], rem: [2] }, undefined)).toEqual({ add: [3], rem: [2] });
  });
});

describe("the sheet's draft and a background refresh", () => {
  test("the same people in a new card object are the same key, so the draft is kept", () => {
    expect(peopleKey([{ id: 1, name: "ada", initials: "X" }, { id: 3, name: "cy", initials: "X" }])).toBe(peopleKey([{ id: 1, name: "ada", initials: "X" }, { id: 3, name: "cy", initials: "X" }]));
    expect(peopleKey([{ id: 1, name: "ada", initials: "X" }])).not.toBe(peopleKey([{ id: 1, name: "ada", initials: "X" }, { id: 3, name: "cy", initials: "X" }]));
  });

  test("the sheet reseeds on opening or on who is on the card, never on the card object", async () => {
    const src = await Bun.file(new URL("../src/cards/AssigneeSheet.tsx", import.meta.url)).text();
    const effect = src.split("\n").find((l) => l.includes("setPicked(currentIds(current))")) ?? "";
    expect(effect).toContain("[open, onCard]");
    expect(effect).not.toContain("current]");
  });
});

import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { filterCards, NO_FILTERS } from "../src/components/jira/list/model.ts";
import { rosterOf, teamOf } from "../src/lib/jiraTree.ts";
import { tileAction, tileOwner } from "../src/lib/jiraTileModel.ts";

// The real shape of a card: people carry the account id as `key`, `me` marks the connected account, `mine` is resolved server-side.
const card = (id: string, key: string, name: string, me: boolean): ProviderTask => ({
  id, title: id, status: "In dev", statusKind: "open", assignees: [name], mine: me,
  people: [{ key, name, initials: name[0]!, ...(me ? { me: true } : {}) }],
} as unknown as ProviderTask);

const all = [card("ORB-1", "acc-me", "Ana", true), card("ORB-2", "acc-other", "Ben", false), card("ORB-3", "acc-cleo", "Cleo", false), card("ORB-4", "acc-dan", "Dan", false)];

describe("a card of another account offers no buttons, in any tab", () => {
  const base = { blockedBy: [] as string[], worker: false, header: "quiet" as const, nextStatus: "In review", writable: true };
  test("acc-other's card, me being acc-me: nothing rendered", () => {
    const other = all[1]!;
    expect(tileOwner(other)).toBe("other");
    expect(tileAction({ ...base, owner: tileOwner(other), done: false })).toEqual({ primary: null, secondary: null });
  });
  test("my own card keeps buttons by state", () => {
    const mine = all[0]!;
    expect(tileOwner(mine)).toBe("me");
    const a = tileAction({ ...base, owner: tileOwner(mine), done: false });
    expect(a.primary?.kind).toBe("move-next");
    expect(a.secondary?.label).toBe("Hand over");
    expect(tileAction({ ...base, owner: "me", done: true })).toEqual({ primary: null, secondary: null });
  });
});

describe("the People list is the whole team and takes several people at once", () => {
  test("two picked people show the cards of both", () => {
    const shown = filterCards(all, { ...NO_FILTERS, assigneePick: ["acc-other", "acc-cleo"] }).map((t) => t.id);
    expect(shown).toEqual(["ORB-2", "ORB-3"]);
  });
  test("with two picked, the list built from the narrowed cards still offers the unpicked teammates", () => {
    const narrowed = all.filter((t) => ["ORB-2", "ORB-3"].includes(t.id)); // what Jira returns when the search names two people
    const names = rosterOf(teamOf(all), teamOf(narrowed)).map((m) => m.name).sort();
    expect(names).toEqual(["Ana", "Ben", "Cleo", "Dan"]);
  });
  test("a person seen earlier and absent now is listed with no cards", () => {
    const r = rosterOf(teamOf(all), teamOf([all[1]!]));
    expect(r.find((m) => m.name === "Dan")?.count).toBe(0);
    expect(r.find((m) => m.name === "Ben")?.count).toBe(1);
  });
});

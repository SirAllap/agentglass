/*
 * Naming somebody in a comment.
 *
 * The menu is the easy half. The hard half is that `@Name` in a ClickUp comment
 * is plain text and notifies nobody — so what is pinned here is the part that
 * makes it arrive: who was named, in the order they were named, and which of
 * them the comment gets handed to.
 */
import { describe, expect, test } from "bun:test";
import { assigneeFor, insertMention, matchPeople, mentionQuery, mentioned } from "../src/lib/mentions.ts";

const people = [
  { id: 1, name: "Ana" },
  { id: 2, name: "Anabel" },
  { id: 3, name: "Bruno Costa" },
  { id: 4, name: "Tomas" },
];

describe("when the menu should be open", () => {
  test("an @ that starts a word, with or without anything after it", () => {
    expect(mentionQuery("@", 1)).toEqual({ at: 0, query: "" });
    expect(mentionQuery("hey @an", 7)).toEqual({ at: 4, query: "an" });
    expect(mentionQuery("(@br", 4)).toEqual({ at: 1, query: "br" });
  });

  test("a name being typed keeps it open across ONE space", () => {
    expect(mentionQuery("@Bruno C", 8)).toEqual({ at: 0, query: "Bruno C" });
    // Two means the sentence moved on, and a menu that stays open eats the
    // Enter you meant as a newline.
    expect(mentionQuery("@Bruno can you look", 19)).toBeNull();
  });

  test("an address is not somebody being called", () => {
    expect(mentionQuery("dev@example.test", 16)).toBeNull();
  });

  test("nor is a line that has moved on", () => {
    expect(mentionQuery("@ana\nnext line", 14)).toBeNull();
    expect(mentionQuery("no at sign here", 15)).toBeNull();
  });
});

describe("putting the name in", () => {
  test("replaces what was typed and leaves the caret past a space", () => {
    const text = "hey @an, look";
    const q = mentionQuery(text, 7)!;
    const out = insertMention(text, q, "Anabel");
    expect(out.text).toBe("hey @Anabel , look");
    expect(out.text.slice(0, out.caret)).toBe("hey @Anabel ");
  });

  test("from a bare @ it just inserts", () => {
    const out = insertMention("@", mentionQuery("@", 1)!, "Ana");
    expect(out.text).toBe("@Ana ");
  });
});

describe("who was named", () => {
  test("the longer name wins over the one inside it", () => {
    expect(mentioned("@Anabel please", people).map((p) => p.id)).toEqual([2]);
    expect(mentioned("@Ana please", people).map((p) => p.id)).toEqual([1]);
  });

  test("a name with a space in it survives", () => {
    expect(mentioned("thanks @Bruno Costa", people).map((p) => p.id)).toEqual([3]);
  });

  test("several, and the comment goes to the first one in the sentence", () => {
    const text = "@Tomas wrote it but @Ana can you look";
    expect(mentioned(text, people).map((p) => p.id).sort()).toEqual([1, 4]);
    expect(assigneeFor(text, people)!.id).toBe(4);
  });

  test("nobody named, nobody assigned", () => {
    expect(assigneeFor("just a note", people)).toBeNull();
    expect(mentioned("mail me at dev@example.test", people)).toEqual([]);
  });
});

describe("the list the menu shows", () => {
  test("everybody when nothing is typed", () => {
    expect(matchPeople(people, "").length).toBe(4);
  });

  test("starts-with before merely contains", () => {
    // "ma" is inside Tomas and at the start of nobody here, so both come back
    // with the containing one still present rather than dropped.
    expect(matchPeople(people, "an").map((p) => p.name)).toEqual(["Ana", "Anabel"]);
    expect(matchPeople(people, "os").map((p) => p.name)).toEqual(["Bruno Costa"]);
  });

  test("capped, because a real workspace has hundreds", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Person ${i}` }));
    expect(matchPeople(many, "person").length).toBe(8);
  });
});

/*
 * Where the menu goes when there is no room under the box.
 *
 * Reported from the card view, where the composer already sits at the bottom of
 * a modal: "the mention picker sort of drops off the bottom and I can't see the
 * list as I should" — the list hung under the box and ran off the end of it.
 *
 * Placed against the viewport now: below when it fits, above when there is more
 * room there, and never taller than the space it lands in. The numbers are
 * given rather than read, so the awkward cases are checkable without a browser.
 */
import { menuPlacement, MENU_MAX, MENU_MIN } from "../src/lib/mentions.ts";

describe("the mention menu's side of the box", () => {
  test("below, when the box is near the top of a tall window", () => {
    expect(menuPlacement({ top: 120, bottom: 200 }, 1000)).toEqual({ up: false, maxHeight: MENU_MAX });
  });

  test("above, when the box is at the bottom of a modal", () => {
    // The reported case: 60px under the composer, most of the window over it.
    const p = menuPlacement({ top: 820, bottom: 940 }, 1000);
    expect(p.up).toBe(true);
    expect(p.maxHeight).toBe(MENU_MAX);
  });

  test("it does not flip for a few pixels", () => {
    /* A menu that changes sides while somebody types is worse than one that is
       slightly short: below wins unless there is genuinely more room above. */
    expect(menuPlacement({ top: 300, bottom: 400 }, 620).up).toBe(false);
  });

  test("and never taller than the room it lands in", () => {
    // A short window: it fits what it can rather than running off the edge.
    const p = menuPlacement({ top: 40, bottom: 250 }, 400);
    expect(p.maxHeight).toBeLessThan(MENU_MAX);
    expect(p.maxHeight).toBeGreaterThanOrEqual(MENU_MIN);
  });

  test("a floor, because three rows is the least worth drawing", () => {
    // Nowhere to go: still drawn, still scrollable, rather than a 4px sliver.
    expect(menuPlacement({ top: 10, bottom: 300 }, 310).maxHeight).toBe(MENU_MIN);
  });
});

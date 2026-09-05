/*
 * ONE CHIP FOR THE TRACKER CARD, EVERYWHERE.
 *
 * `ORBIT-1042` with its priority flag in the priority's own colour — blue for
 * normal, amber for high, red for urgent, an outline flag for none. It appears
 * on the board's card, in the pull request's masthead and in the sidebar, and
 * it drifted into three different things: a chip with ClickUp's logo, a chip
 * with a flag, and a bare label with neither.
 *
 * It drifted DURING this work, which is the point. Moving the card's details
 * onto their own line took the flag off the board's chip, and the same id was
 * then drawn two ways on one screen. "CONSISTENCIA JODER" — and that is a lint,
 * not a note: one component, and nothing else allowed to draw this.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SURFACES = ["src/components/TriageBoard.tsx", "src/components/PrPanel.tsx"];

describe("the tracker card's chip", () => {
  test("has one definition, in the shared module", () => {
    const lib = read("src/lib/priority.tsx");
    expect(lib).toContain("export function CardChip(");
    expect(lib, "the flag is part of the chip, not a caller's decision").toContain("<PriorityFlag");
  });

  test("and every surface draws it through that one", () => {
    for (const f of SURFACES) {
      expect(read(f), `${f} does not use the shared chip`).toContain("<CardChip ");
    }
  });

  test("no surface draws a bare label where the chip belongs", () => {
    /* The regression this file exists for: the board's chip lost its flag when
       the card's details moved to their own line, and became a plain `Tag`. */
    const board = read("src/components/TriageBoard.tsx");
    expect(board, "a bare Tag for the card id is the drift").not.toContain('<Tag tint="var(--accent, var(--primary))"');
  });

  test("and the chevrons are gone for good", () => {
    // ClickUp's logo said which tracker the card lives in, in the one spot the
    // eye looks for how urgent it is.
    for (const f of SURFACES) expect(read(f)).not.toContain("<ClickUpMark");
  });

  test("the WHOLE chip takes the priority's colour, not only the flag", () => {
    /* The first version painted the chip in the app's accent with a coloured
       flag inside — one chip with a decoration. The tasks view has always done
       the other thing: the chip itself is blue on a normal card and amber on a
       high one, which is what makes urgency readable down a column without
       stopping on any single row. */
    const lib = read("src/lib/priority.tsx");
    const fn = lib.slice(lib.indexOf("export function CardChip("));
    expect(fn, "the chip's tint is derived from the priority").toContain("prioLook(priority)");
    expect(fn).toContain("priority ? look.c :");
  });

  test("but an unranked card keeps the accent", () => {
    // A card nobody has ranked is not "low", and painting it grey would say
    // something the card does not.
    const lib = read("src/lib/priority.tsx");
    const fn = lib.slice(lib.indexOf("export function CardChip("));
    expect(fn).toContain('"var(--accent, var(--primary))"');
  });

  test("and each priority has a colour of its own", () => {
    const lib = read("src/lib/priority.tsx");
    const prios = lib.slice(lib.indexOf("export const PRIOS"), lib.indexOf("export const prioLook"));
    for (const [id, token] of [["urgent", "--error"], ["high", "--warning"], ["normal", "--info"]] as const) {
      expect(prios, `${id} has no colour of its own`).toContain(token);
    }
  });
});

/*
 * THE TRACKER'S OWN PEOPLE, AND THE APP'S OWN STATUS CHIP.
 *
 * Two more spellings of one thing, both created by this work:
 *
 *   the face    drawn with `<Avatar login={name}>`, which asks GitHub for a
 *               portrait of "Antonio García" and returns a blank circle. A name
 *               on a tracker board is not a username on a forge.
 *   the status  drawn as coloured uppercase text here and as a bordered chip in
 *               the tasks view, from the same workspace colour.
 */
describe("the card's people and status", () => {
  const board = read("src/components/TriageBoard.tsx");

  test("the face comes from the tracker, not from GitHub", () => {
    expect(board, "the tracker hands over the photo, the initials and the colour")
      .toContain("<CardFace ");
    const line = board.slice(board.indexOf("const who = p.card.people"), board.indexOf("The sentence that put it"));
    expect(line, "a GitHub avatar cannot draw a ClickUp person").not.toContain("<Avatar login=");
  });

  test("and it is the shared one, so a third surface cannot invent a fourth", () => {
    expect(read("src/lib/priority.tsx")).toContain("export function CardFace(");
  });

  test("the status is the app's own chip", () => {
    /* `StatusPill` is where that shape already lives — the tasks view has used
       it all along. */
    expect(board, "the board draws the status through the app's own chip")
      .toMatch(/<StatusPill status=\{(shown|p\.card)\.status\}/);
  });

  test("and it dims rather than lying when the reading is old", () => {
    // The boards are refreshed when somebody opens the tasks view, not on a
    // timer, so a reading can be hours stale.
    expect(board).toContain("dim={stale}");
    expect(board, "the tooltip says WAS, never IS").toContain("The card was in");
  });
});

/*
 * THE CHIP IS THE SAME SIZE WHEREVER IT LANDS.
 *
 * Without a size of its own it inherits, and it went out in two places whose
 * text is bigger than a chip's: the masthead, where it towered over the pull
 * request number beside it, and the sidebar, where it came out half again the
 * size of the status pill directly underneath. "consistency, but also in size
 * with what is around it".
 */
describe("the chip's size", () => {
  test("is declared, not inherited", () => {
    const lib = read("src/lib/priority.tsx");
    const fn = lib.slice(lib.indexOf("export function CardChip("));
    expect(fn, "a chip that resizes with its container is a different chip in each one")
      .toContain("text-[11px]");
  });

  test("and no caller overrides it", () => {
    /* The whole point of one component is that a surface cannot make its own
       bigger. A `text-[...]` in a caller's className would do exactly that. */
    for (const f of SURFACES) {
      const src = read(f);
      for (const m of src.matchAll(/<CardChip[^>]*className="([^"]*)"/g)) {
        expect(m[1], `${f} resizes the shared chip`).not.toMatch(/text-\[/);
      }
    }
  });
});

/*
 * EVERY CHIP ON A ROW IS THE SAME HEIGHT.
 *
 * The card's id and its status sat side by side at 17px and 20px: one set
 * `leading-none`, the other let its line-height decide, and 11px text against
 * 9.5px text did the rest. Two chips on one line at two heights is the kind of
 * thing you see before you can say what is wrong with it — and it is exactly
 * what was reported.
 */
describe("chip height", () => {
  test("comes from one number, not from each chip's padding", () => {
    const lib = read("src/lib/priority.tsx");
    expect(lib).toContain("export const CHIP_H");
    expect(lib.slice(lib.indexOf("export function CardChip(")), "the id chip takes it")
      .toContain("height: CHIP_H");
  });

  test("and the status chip takes the same one", () => {
    const pill = read("src/components/StatusPill.tsx");
    expect(pill).toContain("height: CHIP_H");
    expect(pill, "without this its line-height sets the height again").toContain("leading-none");
  });

  test("neither pads its way to a different one", () => {
    /* `py-*` is how they diverged: two paddings, two line-heights, two boxes. */
    const lib = read("src/lib/priority.tsx");
    const chip = lib.slice(lib.indexOf("const cls = "), lib.indexOf("return onOpen"));
    expect(chip).not.toContain("py-");
    expect(read("src/components/StatusPill.tsx")).not.toContain("py-0.5");
  });
});

/*
 * NO SURFACE FORGETS THE PRIORITY.
 *
 * The chip takes its colour from the card's priority, which only works if the
 * caller hands it over — and the sidebar did not, so it sat purple with a
 * hollow flag beside a board and a masthead that were both showing the real
 * colour. One component is not consistency on its own; a component nobody
 * feeds is just a different way to get it wrong.
 */
describe("every caller passes the priority", () => {
  test("all three surfaces", () => {
    const panel = read("src/components/PrPanel.tsx");
    const board = read("src/components/TriageBoard.tsx");

    /* The masthead and the sidebar go through `CardPill`, which forwards it. */
    for (const m of panel.matchAll(/<CardPill\b[\s\S]{0,320}?\/>/g)) {
      expect(m[0], "a CardPill with no priority draws the accent, not the colour")
        .toMatch(/priority=\{/);
    }
    /* And the board's own two: the card's line, and the fallback in the tag row
       for a card the boards have never seen — that one has no priority to give
       and says so with an explicit null. */
    for (const m of board.matchAll(/<CardChip\b[\s\S]{0,320}?\/>/g)) {
      expect(m[0], "every CardChip states a priority, even when it is null")
        .toMatch(/priority=\{/);
    }
  });

  test("and CardPill forwards it rather than dropping it on the floor", () => {
    const panel = read("src/components/PrPanel.tsx");
    const fn = panel.slice(panel.indexOf("function CardPill("), panel.indexOf("function PrCardChip("));
    expect(fn).toContain("priority={priority ?? null}");
  });
});

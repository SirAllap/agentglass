/*
 * A LONG VALUE IS CUT, NEVER PAINTED OVER ITS NEIGHBOUR.
 *
 * A card's field band showed "Checkout, Dashboard, Notifications" on
 * top of the date beside it, both unreadable. The mechanism is worth writing
 * down because it is not obvious and it recurs:
 *
 *   `min-w-0` on a flex or grid cell removes the `min-width: auto` floor, which
 *   is what normally stops an item shrinking below its content. It is there on
 *   purpose — without it a long field pushes the whole row wider. But it only
 *   works if something downstream CLIPS: with no `truncate` and no
 *   `overflow-hidden`, the text simply paints outside the box it was given, on
 *   top of whatever is next to it.
 *
 * So every value that can be long needs both halves. `FieldValue` had them on
 * two of its three branches; the third — plain text, numbers, and joined
 * multi-value lists, which is the longest kind there is — had neither.
 *
 * Read from source: overlap is a paint-time fact and `renderToStaticMarkup` has
 * no layout, so there is nothing to measure. What can be checked is that the
 * pair is present wherever a value can outgrow its cell.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const tasks = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");

describe("values that can outgrow their cell", () => {
  test("every branch of FieldValue bounds its width", () => {
    const fn = tasks.slice(tasks.indexOf("function FieldValue("), tasks.indexOf("function FieldPick("));
    /* Whole opening tags, not className fragments: a `${cond ? "a" : ""}` inside
       a template literal reads as its own quoted string and my first version
       counted `"tabular-nums"` as a loose branch of its own. */
    const tags = [...fn.matchAll(/<span[\s\S]{0,400}?>/g)].map((m) => m[0]);
    const loose = tags.filter((t) => t.includes("text-[11.5px]") && !t.includes("max-w-full"));
    expect(loose, "a branch with no width bound paints over the field beside it").toEqual([]);
  });

  test("and the one that used to overlap truncates with its full value on hover", () => {
    /* Truncating hides something; the title is what makes that acceptable. */
    const fn = tasks.slice(tasks.indexOf("function FieldValue("), tasks.indexOf("function FieldPick("));
    expect(fn).toContain("truncate");
    expect(fn).toContain("title={text}");
  });

  test("the issue strip's cells can shrink AND clip", () => {
    /* The same shape, one panel over: a three-column grid holding
       `assignees.join(", ")`. It had neither half. */
    const fn = tasks.slice(tasks.indexOf("const Field = ({ k, children }"), tasks.indexOf("const Field = ({ k, children }") + 500);
    expect(fn, "a grid cell without min-w-0 pushes its neighbour instead of shrinking").toContain("min-w-0");
    expect(fn, "and without a wrap rule it paints over it").toMatch(/truncate|overflowWrap/);
  });

  test("the band's value wrapper stretches to its 210px cap instead of sizing to its own content", () => {
    /*
     * The bug that was actually hit: FieldValue's own branch WAS bounded, and
     * still overlapped. The wrapper one level up (`shape.band.map`) opted out
     * of stretch with `alignSelf: "flex-start"`, so the flex algorithm sized
     * it to its content's own max-content width — a `max-width: 100%`
     * descendant is ignored for that intrinsic pass — before the 210px cap
     * on the grandparent div ever applied. `max-w-full` inside FieldValue
     * then had no definite width to be 100% of, so it never actually
     * clipped: the whole point of stretch here is to hand FieldValue a real
     * number to clip against.
     */
    const start = tasks.indexOf("shape.band.map((c) =>");
    /* Code only — my own explaining comment quotes `alignSelf: "flex-start"`
       verbatim as the thing NOT to do, which would trip this same check. */
    const block = tasks.slice(start, start + 1400).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block, "maxWidth: 210 is the cap this wrapper must actually stretch to fill").toContain("maxWidth: 210");
    expect(block, 'alignSelf: "flex-start" opts the value out of stretch, so max-w-full clips against nothing')
      .not.toContain("flex-start");
  });
});

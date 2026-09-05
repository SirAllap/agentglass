/*
 * The fence over where the clone's work may come from looks like something you
 * can press.
 *
 * It is one chip on the "May work in" row, and it is the only control there
 * that changes what the clone may reach: on, task-tracker sources may offer it
 * cards; off, they are silent. It shipped drawn as a toggle — no body until it
 * is on, because for a toggle the tint IS the state — which is right in a row
 * of toggles and wrong for one sitting alone. Off, it was transparent grey text
 * beside the open-project chip's border: the control read as the caption for
 * the thing next to it, and the affordance was inverted exactly the way
 * `chipBody` in Chrome.tsx says it must never be again.
 *
 * Nothing failed. The chip was a real button the whole time, it carried
 * `aria-pressed`, and it flipped the scope on click. What was wrong was the
 * only thing a type checker has no opinion about, so this renders it — both
 * ways — and asserts what a person sees, next to the chip it sits beside.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackerFence } from "../src/components/understudy/Work.tsx";
import { Chip } from "../src/components/workspace/Chrome.tsx";

const draw = (scope: "open-only" | "everywhere") =>
  renderToStaticMarkup(React.createElement(TrackerFence, { scope, onFlip: () => {} }));

/** The `style="…"` React wrote, which is where the whole affordance lives. */
const styleOf = (html: string) => /style="([^"]*)"/.exec(html)?.[1] ?? "";

const silent = draw("open-only");
const open = draw("everywhere");

/*
 * The chip it sits beside — the open project, a plain button with no state.
 *
 * Rendered rather than described, because "the same border as the one next to
 * it" is a claim about the neighbour, and a border copied into a constant here
 * would keep passing after somebody restyled the row.
 */
const neighbour = renderToStaticMarkup(
  React.createElement(Chip, { onClick: () => {}, children: "acme-web" }));

describe("the tracker fence reads as a control", () => {
  test("it draws a body in both states, the one its neighbour draws", () => {
    // The regression, in one line: without `resting` the silent state renders
    // no border at all, and this is the assertion that goes red for it.
    const border = /border:([^;"]*)/.exec(styleOf(neighbour))?.[1];
    expect(border).toBeTruthy();
    expect(styleOf(silent)).toContain(`border:${border}`);
    expect(styleOf(open)).toMatch(/border:1px solid/);
  });

  test("which way it is set is legible without hovering it", () => {
    expect(silent).toContain("tracker: silent");
    expect(open).toContain("tracker: on");
    // And to a reader that never sees either: a toggle, and its position.
    expect(silent).toContain('aria-pressed="false"');
    expect(open).toContain('aria-pressed="true"');
  });

  test("the open state is still the one that stands out", () => {
    /*
     * Widening the fence is the deliberate act, so it keeps the error tint and
     * the label that says what it turned on. Giving the silent state a body
     * must not have given it the same emphasis — a row where both states shout
     * is a row where neither says anything.
     */
    expect(styleOf(open)).toContain("var(--error)");
    expect(open).toContain("agx-chip-danger");
    expect(styleOf(silent)).not.toContain("var(--error)");
    expect(silent).not.toContain("agx-chip-danger");
  });

  test("it is still the row's switch, wired to the scope the server keeps", () => {
    // The fence is only worth drawing if the row still draws it and the click
    // still reaches the route. Extracting it is what would quietly undo that.
    const work = readFileSync(
      join(import.meta.dir, "..", "src", "components", "understudy", "Work.tsx"), "utf8");
    expect(work).toContain("<TrackerFence");
    expect(work).toContain('"/understudy/propose-scope"');
  });
});

/**
 * Emptying the search box is one click.
 *
 * Reported: "having to clear the input by hand is very annoying". Selecting a
 * card id by hand to type over it is a small tax paid twenty times a day, and
 * every other search box in this app already offers the way out.
 *
 * Read from the source rather than rendered, because what has to hold is that
 * the control EXISTS beside the input and is drawn only when there is
 * something to clear — an empty box with a clear button in it is a control
 * that does nothing, which is the pattern this repo spent a week removing.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");

/** The board's search box, from its input to the end of the row. */
function searchRow(): string {
  /* Delimited by the two comments that bracket the field in the top bar. It
     used to be anchored on a class name, and moving the box out of the chips
     row and into the centre of the bar broke the slice rather than the box. */
  const from = SRC.indexOf("{/* THE SEARCH, IN THE MIDDLE OF THE BAR.");
  expect(from, "the board's search box is gone").toBeGreaterThan(-1);
  const to = SRC.indexOf("{/* Only when writes are OFF", from);
  expect(SRC.slice(from, to)).toContain("Filter this board · Enter searches the workspace");
  return SRC.slice(from, to);
}

test("the search box has a way to empty it", () => {
  const row = searchRow();
  expect(row).toContain('aria-label="Clear the search"');
  expect(row, "clearing has to actually clear").toContain('setQ("")');
});

test("and it is only there when there is something to do with it", () => {
  const row = searchRow();
  /*
   * `{q && (` until a search became cancellable, and the widening is the
   * point rather than a relaxation.
   *
   * The rule was "no button over an empty box", and it still holds — an idle
   * empty box draws nothing. What changed is that an empty box is no longer
   * proof there is nothing to do: the first press of this very button empties
   * it while a sweep of the workspace is still running, and if the control
   * vanished at that moment the only thing left on screen would be a spinner
   * with no way to stop it.
   */
  expect(row).toMatch(/\{\(q \|\| searching\) && \(/);
});

test("and it cancels the search, not just the text", () => {
  // The reported bug: "I want to cancel the search" with the spinner turning.
  // This × emptied the box and left the request running, and the request then
  // wrote its result over whatever came next.
  expect(searchRow()).toContain("cancelSearch()");
});

test("the caret goes back to the box, because the next thing is another search", () => {
  expect(searchRow()).toContain("searchBox.current?.focus()");
});

test("it is a segment of the field, not a badge floating inside it", () => {
  /* Asked for twice, in two directions: bigger, then attached — "make the
     button part of the input", pointing at a subscribe field whose button is
     welded to the right end. So: full height of the box (`self-stretch` plus
     the margins that cancel the field's padding), flush against the edge (no
     right padding on the field), and clipped to the field's own corner. */
  const row = searchRow();
  expect(row).toContain("self-stretch");
  expect(row, "the field keeps a right padding, so the button cannot reach the edge").toContain("pl-2.5");
  expect(row, "without this the corner sticks out of the field's radius").toContain("overflow-hidden");
  expect(row, "a hairline is what says where the field ends and the button starts").toContain("borderLeft");
});

test("Escape empties it too, and does not reach the view behind", () => {
  const row = searchRow();
  expect(row).toContain('e.key === "Escape"');
  // Without this the workspace reads it as "go back" and the panel closes.
  expect(row).toContain("stopPropagation()");
});

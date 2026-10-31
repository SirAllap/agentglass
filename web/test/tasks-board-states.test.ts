/**
 * What a board says when it has nothing to show: reading, nothing there, could
 * not read, nothing matches. Read from source: there is no renderer here.
 *
 * What a mistake costs: a spinner and a sentence where the mockup draws six
 * bars, an error with no way to try again, or a filtered-out board that says
 * "nothing" as if the tracker were empty.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const url = (p: string) => new URL(p, import.meta.url);
const PANEL = readFileSync(url("../src/components/TasksPanel.tsx"), "utf8");
const STATE = readFileSync(url("../src/components/tasks/BoardState.tsx"), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const panel = strip(PANEL);

test("reading is a skeleton of the rows, labelled with the board, not a spinner", () => {
  expect(panel).toContain("<BoardSkeleton label={`Reading ${boardLabel}…`}");
  expect(panel).not.toContain("Loading the board…");
  expect(STATE).toContain("agx-skeleton");
});

test("a board that could not be read says which, why, and offers Try now and the tracker", () => {
  expect(panel).toContain("`Could not read ${boardLabel}`");
  const at = panel.indexOf("`Could not read ${boardLabel}`");
  const body = panel.slice(at, at + 700);
  expect(body).toContain("Try now");
  expect(body).toContain("source.nouns.openIn");
});

test("an empty list, an empty epic and a filtered-out board each have their own words", () => {
  for (const w of ["Nothing on this list yet", "Nothing in this epic", "Nothing matches those filters", "Nothing open here", "Add a card in the tracker, or look one up by id."]) expect(panel).toContain(w);
  expect(panel).toContain("Clear filters");
  expect(panel).toContain("finished card");
});

test("the stale strip is a note with Try now, tinted by whether rows are still on screen", () => {
  expect(panel).toContain('<BoardNote tone={tasks.length ? "warn" : "err"}');
  expect(panel).toContain("Nothing has been read since ");
  expect(panel).toContain("Showing what was read then.");
});

test("a board with nothing on it draws no column heading above its message", () => {
  expect(panel).toContain('display: !onLooked && !rows.length && !looksLikeId && view !== "loading" ? "none" : "grid"');
});

test("the veil sits over the sticky group heads and tells the footer it is loading", () => {
  expect(panel).toContain("agx-veil absolute inset-0 z-20");
  expect(panel).toContain('view === "loading" || veiled ? "Loading…"');
});

test("a card being read is a skeleton, and a card that failed says so with Try now and Copy id", () => {
  expect(panel).toContain('<BoardSkeleton label="Reading the card…"');
  const at = panel.indexOf('title="Could not read this card"');
  expect(at).toBeGreaterThan(-1);
  const body = panel.slice(at, at + 500);
  expect(body).toContain("<StateButton primary onClick={reread}>Try now</StateButton>");
  expect(body).toContain("Copy id");
});

/**
 * The board's layout follows the approved mockup: the lists rail runs the full
 * height beside the toolbar, the toolbar is two rows (crumb + actions, then the
 * search), a card is one line, and a card's fields are label-left rows.
 * Read from source: there is no renderer here.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const url = (p: string) => new URL(p, import.meta.url);
const PANEL = readFileSync(url("../src/components/TasksPanel.tsx"), "utf8");
const CHROME = readFileSync(url("../src/components/CardChrome.tsx"), "utf8");
const GROUP = readFileSync(url("../src/components/tasks/GroupHead.tsx"), "utf8");
const CSS = readFileSync(url("../src/index.css"), "utf8");

test("the rail spans both rows of a three-column grid, the card pane likewise", () => {
  expect(PANEL).toContain('gridTemplateColumns: "auto minmax(0, 1fr) auto"');
  expect(PANEL).toContain('gridColumn: 1, gridRow: "1 / 3"');
  expect(PANEL).toContain('gridColumn: 3, gridRow: "1 / 3", width: cardW');
});

test("the add-a-list button lives in the rail header, not the toolbar", () => {
  const rail = PANEL.slice(PANEL.indexOf('<nav ref={railNav}'), PANEL.indexOf("</nav>", PANEL.indexOf('<nav ref={railNav}')));
  expect(rail).toContain("source.nouns.addHint");
  const bar = PANEL.slice(PANEL.indexOf("gridColumn: 2, gridRow: 1"), PANEL.indexOf('<nav ref={railNav}'));
  expect(bar).not.toContain("source.nouns.addHint}>");
});

test("a card row is one line: the comment count is inside the task cell, not a column", () => {
  expect(PANEL).not.toContain("{showCmts && <span");
  expect(PANEL).toContain("false, cols.pr);");
  expect(PANEL).toContain("<CommentIcon size={ICON.xs} />{t.comments}");
});

test("the sprint column is drawn only where the rows disagree", () => {
  expect(PANEL).toContain('new Set(tasks.map((x) => x.sprint ?? "")).size > 1');
});

test("a group's points sit on the right, where the Pts column is", () => {
  expect(GROUP).toContain('className="ml-auto pr-4');
});

test("card fields are label-left rows", () => {
  expect(CHROME).toContain('className="agx-lrow min-w-0"');
  expect(CSS).toContain("grid-template-columns: 92px");
});

test("the card header reads id chips, title, actions, tabs; the close is quiet and in every mode", () => {
  const a = PANEL.indexOf("copyIt(t.customId || t.id, \"human\")");
  const h = PANEL.indexOf('<h2 className="text-[13px] font-semibold leading-snug mt-1.5"');
  const act = PANEL.indexOf("The card's actions live above its identity");
  expect(a).toBeLessThan(h);
  expect(h).toBeLessThan(act);
  expect(PANEL).not.toContain('onClose={cardMode === "modal" ? () => setSel(null) : undefined}');
});

test("a read-only board says so in the card, with the button that allows changes", () => {
  const note = readFileSync(url("../src/components/tasks/ReadOnlyNote.tsx"), "utf8");
  expect(note).toContain("This board is read-only.");
  expect(note).toContain("Allow changes");
  expect(PANEL).toContain("<ReadOnlyNote onAllow={onAllow}");
});

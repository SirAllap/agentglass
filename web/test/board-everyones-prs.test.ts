/**
 * The board's lanes are the viewer's two queues. "Show everyone's PRs" is the
 * one per-repository switch that widens them to every open pull request, so the
 * wiring is checked where it lives: the panel decides what the board is handed,
 * and the component must draw the repository's page when it is handed one.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
const views = readFileSync(new URL("../src/components/PrViewsBar.tsx", import.meta.url), "utf8");
const board = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");

test("the choice is stored per repository, off unless it was turned on", () => {
  expect(panel).toContain('const EVERYONE_KEY = "agentglass.pr.everyone"');
  expect(panel).toContain("useState<Record<string, boolean>>(() => loadMap<boolean>(EVERYONE_KEY))");
  expect(panel).toContain("everyones[repo.key] === true");
  expect(panel).toContain("saveMap(EVERYONE_KEY, next)");
});

test("the setting widens the board's list and the cards it files", () => {
  expect(panel).toContain("const boardWideOn = BOARD_IS_WIDE || everyoneOn");
  expect(panel).toContain("const queuesOnly = boardShown && !boardWideOn");
  expect(panel).toContain("const boardWide = boardShown && boardWideOn");
  expect(panel).toContain("others={boardWide && !personLogin ? boardOthersShown : undefined}");
  expect(panel).toContain("showEveryone={boardWide && !personLogin}");
  /* The component must draw the page it is handed, gated by the setting rather
     than by the old constant that made the page unreachable. */
  expect(board).toContain("const wide = !!showEveryone && !!others");
  expect(board).not.toContain("const wide = BOARD_IS_WIDE && !!others");
});

test("the toolbar draws the switch with the house control and a data-tip", () => {
  expect(views).toContain('<Button size="hit" on={everyone.on} aria-pressed={everyone.on}');
  expect(views).toContain('data-tip={everyone.on');
  expect(views).toContain("Show everyone's PRs");
  /* No native `title` on this control: one tip, the app's own. */
  const start = views.indexOf("<Button size=\"hit\" on={everyone.on}");
  const control = views.slice(start, views.indexOf("</Button>", start));
  expect(control).not.toContain("title=");
  expect(panel).toContain("everyone={{ on: everyoneOn, toggle: setEveryone }}");
});

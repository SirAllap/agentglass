/*
 * The board tile's layout decisions: when the action row folds its second button into the "..." menu (a label is
 * never cut to make room), and where the mockup's pieces sit (points, sub-tasks and the face on the bottom row,
 * a title of up to three lines, no dashed "no pull request" box).
 */
import { describe, expect, test } from "bun:test";
import { foldSecondary } from "../src/lib/jiraTileModel.ts";

const base = new URL("../src/", import.meta.url);
const read = (p: string) => Bun.file(new URL(p, base)).text();

describe("foldSecondary", () => {
  test("a 280 px tile cannot hold Move to In Progress, Hand over, the mention chip and the menu", () => {
    expect(foldSecondary({ laneWidth: 280, primary: "Move to In Progress", secondary: "Hand over", mentions: true })).toBe(true);
  });
  test("a short primary leaves room for Hand over", () => {
    expect(foldSecondary({ laneWidth: 280, primary: "Move to Done", secondary: "Assign", mentions: false })).toBe(false);
  });
  test("a wider lane keeps both; an unknown width folds nothing", () => {
    expect(foldSecondary({ laneWidth: 420, primary: "Move to In Progress", secondary: "Hand over", mentions: true })).toBe(false);
    expect(foldSecondary({ laneWidth: 0, primary: "Move to In Progress", secondary: "Hand over", mentions: true })).toBe(false);
  });
});

describe("the tile as the mockup draws it", () => {
  test("the action row never cuts a button label, wraps, and folds the second button", async () => {
    const tile = await read("components/jira/list/JiraTile.tsx");
    const css = await read("index.css");
    expect(tile).toContain("secondary && !folded");
    expect(tile).toContain('className="agx-jt-lbl"');
    expect(css).toMatch(/\.agx-jt-acts \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.agx-jt-act \{[^}]*flex: 0 0 auto; min-width: max-content;/);
    expect(css).toMatch(/\.agx-jt-lbl \{[^}]*min-width: max-content/);
    expect(css).not.toMatch(/\.agx-jt-lbl \{[^}]*text-overflow: ellipsis/);
    expect(css).not.toMatch(/\.agx-jt-act \{[^}]*overflow: hidden/);
  });
  test("no dashed box where the mockup draws nothing", async () => {
    expect(await read("components/jira/list/JiraTile.tsx")).not.toContain("No pull request names this card");
  });
  test("points, sub-tasks and the face are the bottom row; the title takes three lines", async () => {
    const board = await read("components/jira/list/JiraBoard.tsx");
    const foot = board.slice(board.indexOf('<div className="agx-jb-foot">'));
    expect(foot.slice(0, foot.indexOf("</div>"))).toContain("<PeopleFaces");
    expect(foot.slice(0, foot.indexOf("</div>"))).toContain("{t.points} pt");
    expect(foot.slice(0, foot.indexOf("</div>"))).toContain("<CaretIcon");
    expect(await read("index.css")).toMatch(/^\.agx-jb-title \{[^}]*-webkit-line-clamp: 3/m);
  });
});

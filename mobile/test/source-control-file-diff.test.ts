/*
 * A changed file in Source control can be opened to see WHAT changed.
 *
 * The whole row used to be the stage checkbox, so the only thing a tap on a
 * file could do was stage it and a person committed without reading. A rule
 * about source: there is no renderer in this project.
 */
import { expect, test } from "bun:test";

const repos = await Bun.file(new URL("../app/(tabs)/repos.tsx", import.meta.url)).text();
const screen = await Bun.file(new URL("../app/git-diff.tsx", import.meta.url)).text();

test("each changed row has its own control that opens the file's diff", () => {
  expect(repos).toContain('pathname: "/git-diff"');
  expect(repos).toContain("See what changed in ${item.path}");
});

test("the row's name still stages, and the diff control is not inside it", () => {
  const stage = repos.indexOf('accessibilityRole="checkbox"');
  const diff = repos.indexOf('pathname: "/git-diff"');
  expect(stage).toBeGreaterThan(0);
  // The staging Pressable closes before the diff one starts: siblings, not nested.
  const between = repos.slice(stage, diff);
  expect(between).toContain("</Pressable>");
});

test("the screen reads the server's own file-diff, against HEAD, with no write", () => {
  expect(screen).toContain("/git/file-diff?root=");
  expect(screen).not.toContain('method: "POST"');
});

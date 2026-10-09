/*
 * One face component and one bubble, for GitHub people and ClickUp people
 * alike. There is no renderer here, so the rule is asserted against source: no
 * screen keeps its own copy of the drawing.
 */
import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (rel: string): Promise<string> => Bun.file(join(root, rel)).text();
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? (e === "node_modules" ? [] : files(p)) : /\.tsx?$/.test(e) && !/\.test\./.test(e) ? [p] : [];
  });

test("Face is gone: every face is an Avatar", async () => {
  for (const f of [...files(join(root, "src")), ...files(join(root, "app"))]) {
    const code = strip(await Bun.file(f).text());
    expect(code, f).not.toMatch(/\bFace\b.*from ".*Face\.tsx"/);
    expect(code, f).not.toMatch(/<Face\b/);
  }
});

test("the pull request's conversation and a card's comments draw the same Bubble on the same Rail", async () => {
  for (const f of ["src/review/Timeline.tsx", "app/card/[id].tsx"]) {
    const code = strip(await read(f));
    expect(code, f).toMatch(/from "[./]+(?:\/src)?\/(?:review\/)?Bubble\.tsx"/);
    expect(code, f).toContain("<Bubble");
    expect(code, f).toContain("<Rail");
    expect(code, f).toContain("<Avatar");
  }
});

test("a pull request's faces come by login through the computer, not by a hand-built address", async () => {
  const code = strip(await read("src/Avatar.tsx"));
  expect(code).toContain("githubFace({ origin, token }, login)");
  for (const f of ["src/review/Timeline.tsx", "src/review/Overview.tsx", "src/review/PrFilterSheet.tsx"]) {
    expect(strip(await read(f)), f).not.toContain("avatars.githubusercontent.com");
  }
});

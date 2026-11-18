import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BAR } from "../src/nav/bar.ts";
import { STRIP_LABEL } from "../src/model/prBoard.ts";

const text = (p: string): Promise<string> => Bun.file(new URL(p, import.meta.url)).text();

test("the bar is Terminal, PRs, Tasks and nothing else", () => {
  expect(BAR.map((d) => d.label)).toEqual(["Terminal", "PRs", "Tasks"]);
});

test("the PR diff and threads shims are gone; the review takes ?pane=", () => {
  expect(existsSync(new URL("../app/pr/diff.tsx", import.meta.url))).toBe(false);
  expect(existsSync(new URL("../app/pr/threads.tsx", import.meta.url))).toBe(false);
});

test("the board opens on mine, with one switch to everyone", async () => {
  const prs = await text("../app/(tabs)/prs.tsx");
  expect(prs).toContain("const [everyone, setEveryone] = useState(false)");
  expect(prs).toContain('accessibilityRole="switch"');
});

test("the lane strip names every lane", () => {
  expect(Object.keys(STRIP_LABEL).sort()).toEqual(["blocked", "flight", "land", "others", "review"]);
});

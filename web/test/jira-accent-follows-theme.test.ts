import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/index.css"), "utf8");

test("the Jira accent tokens follow the theme, not a hex literal", () => {
  for (const [name, source] of [
    ["--jira-accent", "--primary"],
    ["--jira-accent-hover", "--primary-hover"],
    ["--jira-accent-on", "--on-primary"],
  ] as const) {
    const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe(`var(${source})`);
  }
});

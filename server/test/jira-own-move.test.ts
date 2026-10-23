/**
 * The watch must not announce the person's own move. A rule about source is
 * asserted against source: the route hands the status the card left to the
 * watch, and the write reports it.
 */
import { expect, test } from "bun:test";

const idx = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const jira = await Bun.file(new URL("../src/jira.ts", import.meta.url)).text();

test("the move route remembers the person's own move for the watch", () => {
  const start = idx.indexOf('pathname === "/jira/transition"');
  expect(start).toBeGreaterThan(-1);
  const block = idx.slice(start, idx.indexOf("\n    }\n", start));
  expect(block).toContain("jiraRememberOwnMove(");
});

test("a successful move reports the status the card left", () => {
  expect(jira).toMatch(/task: back\.data, was: /);
});

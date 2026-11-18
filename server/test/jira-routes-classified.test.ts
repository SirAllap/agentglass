/* No POST /jira/ route in index.ts is left without a class: each is person-only, door-only or local (personOnlyJiraRoutes.ts), so a new one cannot be forgotten. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DOOR_ONLY_JIRA_ROUTES, LOCAL_JIRA_ROUTES, PERSON_ONLY_JIRA_ROUTES } from "../src/personOnlyJiraRoutes.ts";

describe("Jira route classification", () => {
  test("every POST /jira/ route in index.ts is person-only, door-only or local", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");
    const found = new Set<string>();
    for (const line of src.split("\n")) {
      if (!line.includes('"POST"')) continue;
      for (const m of line.matchAll(/"(\/jira\/[a-z/-]*)"/g)) found.add(m[1]!);
    }
    expect(found.size).toBeGreaterThan(30);
    const known = new Set([...PERSON_ONLY_JIRA_ROUTES, ...DOOR_ONLY_JIRA_ROUTES, ...LOCAL_JIRA_ROUTES]);
    expect([...found].filter((p) => !known.has(p))).toEqual([]);
  });
});

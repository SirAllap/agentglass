import { describe, expect, test } from "bun:test";
import { ACCOUNT_ID, PERSON_FILTER, idsIn, nameForQueryWith, readable, rememberPerson } from "../src/lib/personNames.ts";
import { nameForQuery } from "../src/components/jira/list/tabsModel.ts";

const CLOUD = "712020:5b10ac8d-82e0-4a41-9d3c-0f1e2a3b4c5d";
const LEGACY = "5b10ac8d82e04a419d3c0f1e";
const NO_RAW_ID = [/\d+:[0-9a-f-]{8,}/, /\b[0-9a-f]{24}\b/];
const clean = (label: string) => { for (const re of NO_RAW_ID) expect(re.test(label)).toBe(false); };

describe("people in saved filters", () => {
  test("finds both id shapes", () => {
    expect(idsIn(`assignee = "${CLOUD}" OR reporter = "${LEGACY}"`).sort()).toEqual([CLOUD, LEGACY].sort());
    expect(ACCOUNT_ID.flags).toContain("g");
  });
  test("a person filter is named with the person, from a name the click held", () => {
    const lookup = (id: string) => (id === CLOUD ? "Jonas K." : undefined);
    expect(nameForQueryWith(`assignee = "${CLOUD}" order by rank`, nameForQuery, lookup)).toBe("Jonas K.");
  });
  test("an id nobody resolves is Person filter, never the id", () => {
    for (const jql of [`assignee = "${CLOUD}"`, `assignee = "${LEGACY}" AND status = Done`, `reporter = "${CLOUD}" AND labels = a`]) {
      const label = nameForQueryWith(jql, nameForQuery, () => undefined);
      expect(label === PERSON_FILTER || label.length > 0).toBe(true);
      clean(label);
      clean(readable(jql, () => undefined));
    }
    expect(nameForQueryWith(`assignee = "${CLOUD}"`, nameForQuery, () => undefined)).toBe(PERSON_FILTER);
  });
  test("a mixed search shows the name where the id was; a plain search is untouched", () => {
    rememberPerson(CLOUD, "Jonas K.");
    const label = readable(`assignee = "${CLOUD}" AND status = Done`);
    expect(label).toBe(`assignee = "Jonas K." AND status = Done`);
    clean(label);
    expect(nameForQueryWith("status = Done", nameForQuery)).toBe("status = Done");
  });
});

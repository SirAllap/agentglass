/*
 * The level-3 doors are listed by hand in two documents: SECURITY.md (what an
 * agent can prepare) and the ui-control skill (what an agent is told exists).
 * One said four while the registry had five, and the skill said "the one that
 * exists". Both are held to the registry here, so a door added or removed
 * shows up as a failing test instead of a stale sentence.
 */
import { describe, expect, test } from "bun:test";
import { UI_ACTIONS } from "../../shared/uiActions.ts";

const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
const doors = Object.entries(UI_ACTIONS).filter(([, d]) => d.level === 3).map(([id]) => id);
const read = (rel: string) => Bun.file(new URL(`../../${rel}`, import.meta.url)).text();
const security = await read("SECURITY.md");
const skill = await read("skills/ui-control/SKILL.md");

describe("the level-3 doors in the documents", () => {
  test("there are some to hold the documents to", () => {
    expect(doors.length).toBeGreaterThanOrEqual(5);
  });
  test("SECURITY.md names every one and counts them", () => {
    for (const id of doors) expect(security, id).toContain(`\`${id}\``);
    expect(security).toContain(`${words[doors.length]} doors ship`);
  });
  test("the ui-control skill names every one and counts them", () => {
    for (const id of doors) expect(skill, id).toContain(`\`${id}\``);
    expect(skill).toContain(`${words[doors.length]} exist`);
  });
});

/*
 * Whose card a pull request names, when it names two.
 *
 * The phone draws two card screens — `/card/[id]` asks the ClickUp board,
 * `/jira/[key]` asks the site — so the one thing this decides is which of them
 * a tap may open, and whether it may open one at all.
 */
import { describe, expect, test } from "bun:test";
import { cardDoor, jiraKeyOf } from "../src/model/cardDoor.ts";
import { readTaskRef } from "../../shared/taskref.ts";

const reach = { keys: ["ORBIT", "WEB"], site: "acme.atlassian.net" };

describe("a Jira key wins", () => {
  test("a pull request naming both ids is Jira's", () => {
    // The branch was cut from the old ClickUp prefix; the title is the Jira key.
    const ref = readTaskRef({ headRefName: "LEGACY-1042-retry-the-sender", title: "[ORBIT-1042] Retry the sender" }, reach);
    expect(ref).toMatchObject({ label: "ORBIT-1042" });
    expect(cardDoor(ref, { clickup: true, jira: reach })).toEqual({ tracker: "jira", id: "ORBIT-1042" });
  });

  test("a key read from a branch is Jira's too", () => {
    const ref = readTaskRef({ headRefName: "feat/orbit-1042-retry" }, reach);
    expect(cardDoor(ref, { clickup: true, jira: reach })).toEqual({ tracker: "jira", id: "ORBIT-1042" });
  });

  test("a Jira address is Jira's with no site connected, because the address says so", () => {
    const ref = readTaskRef({ body: "https://acme.atlassian.net/browse/ORBIT-7" });
    expect(jiraKeyOf(ref, null)).toBe("ORBIT-7");
    expect(cardDoor(ref, { clickup: true, jira: null })).toEqual({ tracker: "jira", id: "ORBIT-7" });
  });
});

describe("ClickUp is the fallback", () => {
  test("a ClickUp-only pull request is ClickUp's", () => {
    const ref = readTaskRef({ headRefName: "CU-86abc12_retry" }, reach);
    expect(cardDoor(ref, { clickup: true, jira: reach })).toEqual({ tracker: "clickup", id: "CU-86abc12" });
  });

  test("a key the site never listed is not sent to Jira", () => {
    // `LEGACY-1042` is a ClickUp custom id on a workspace that has both.
    const ref = readTaskRef({ headRefName: "LEGACY-1042-retry" }, reach);
    expect(jiraKeyOf(ref, reach)).toBeNull();
    expect(cardDoor(ref, { clickup: true, jira: reach })).toEqual({ tracker: "clickup", id: "LEGACY-1042" });
  });

  test("with no Jira site a key is read the way it always was", () => {
    const ref = readTaskRef({ title: "[ORBIT-1042] Retry" });
    expect(cardDoor(ref, { clickup: true, jira: null })).toEqual({ tracker: "clickup", id: "ORBIT-1042" });
  });

  test("no board to draw it in, no door", () => {
    const ref = readTaskRef({ title: "[ORBIT-1042] Retry" }, reach);
    expect(cardDoor(ref, { clickup: false, jira: null })).toBeNull();
    expect(cardDoor(null, { clickup: true, jira: reach })).toBeNull();
  });
});

describe("the phone's two doors", () => {
  const src = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

  test("the chip opens the Jira card before the address leaves the app", async () => {
    const chip = await src("../src/review/TaskChip.tsx");
    expect(chip).toContain("jiraKeyOf(");
    const jiraPress = chip.indexOf("if (jiraKey)");
    expect(jiraPress).toBeGreaterThan(-1);
    expect(jiraPress).toBeLessThan(chip.indexOf('else if ("open" in go) openHttp('));
  });

  test("the pull request screen draws both cards, and the row looks a Jira key up at the site", async () => {
    const screen = await src("../app/pr/[number].tsx");
    expect(screen).toContain('pathname: "/jira/[key]"');
    expect(screen).toContain('tracker === "jira"');
    const state = await src("../src/state/pr-cards.ts");
    expect(state).toContain("/jira/find?q=");
  });
});

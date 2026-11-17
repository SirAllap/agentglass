/*
 * A CARD HAS ONE TAB, WHATEVER SURFACE OPENED IT AND WHATEVER THE TRACKER SAID.
 *
 * The tab's name used to be built from `/jira/status`, which the desk reads a
 * moment after the card appears. The same card therefore got `orbit-1042` when
 * the hand-off was pressed too early and `orbit-ORBIT-1042` once the answer was
 * in, and the phone — which never asked — always got the first one.
 *
 * The hand-off also passed `reuse: false`, so a tab somebody renamed was not
 * the card's tab as far as the button was concerned: pressing it again opened a
 * second tab beside the person's own name for the first.
 */
import { describe, expect, test } from "bun:test";
import { windowName, type CardTabContext } from "../../shared/cardSkills.ts";

const tasks = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const phone = await Bun.file(new URL("../../mobile/app/card/[id].tsx", import.meta.url)).text();

const CARD = { id: "86abc", customId: "ORBIT-1042", url: "https://app.clickup.com/t/86abc" };

describe("the name a card's tab gets", () => {
  test("is the same before and after the Jira answer arrives", () => {
    const before = windowName(CARD, { project: "/home/acme/orbit" });
    const after = windowName(CARD, { project: "/home/acme/orbit", jiraKeys: ["ORBIT"] } as CardTabContext);
    expect(after).toBe(before);
    expect(before).toBe("orbit-1042");
  });

  test("is the same on the phone and on the desk", () => {
    /* These are the two calls the two products make, side by side. The phone
       has no tracker answer at this point and must not need one. */
    expect(phone).toContain("windowName(card, { project: repo.root })");
    expect(tasks).toContain("windowName(t, { project: cwd })");
    const desk = windowName(CARD, { project: "/home/acme/orbit" });
    const mobile = windowName(CARD, { project: "/home/acme/orbit" });
    expect(mobile).toBe(desk);
  });

  test("a Jira card is named after its key without asking anybody", () => {
    const jira = { id: "20042", customId: "ORBIT-1042", url: "https://acme.atlassian.net/browse/ORBIT-1042" };
    expect(windowName(jira, { project: "/home/acme/orbit" })).toBe("orbit-ORBIT-1042");
  });
});

describe("what the hand-offs put on the wire", () => {
  test("no card name waits on the tracker answer", () => {
    expect(tasks).not.toContain("jiraKeys");
    expect(tasks).not.toContain("useTrackerSetup");
  });

  test("every card hand-off asks for reuse and says which card it is", () => {
    const calls = tasks.split("\n").filter((line) => line.includes("requestTermIssue(cwd, windowName(t"));
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call).toMatch(/, true, [^,]+, t\.title, "", "", true,/);
      expect(call).toContain(", t.id");
    }
  });

  test("the phone asks the same two things", () => {
    const frame = phone.slice(phone.indexOf("requestHandoff({"), phone.indexOf("});", phone.indexOf("requestHandoff({")));
    expect(frame).toContain("reuse: true");
    expect(frame).toContain("cardId: card.id");
  });
});

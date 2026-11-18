/*
 * What a Jira comment shows beyond its words: mention chips, the exact date and
 * "(edited)" line, the link to one comment, and the roster an edit sends.
 */
import { describe, expect, test } from "bun:test";
import { commentLink, editRoster, editedLabel, editedTip, exactDate, mentionParts } from "../src/lib/jiraCommentView.ts";

describe("mentionParts", () => {
  test("a named person becomes a mention, the rest stays text", () => {
    expect(mentionParts("@Ada Orbit the retry fires twice", ["Ada Orbit"])).toEqual([{ mention: "Ada Orbit" }, " the retry fires twice"]);
    expect(mentionParts("Fix is up, @Lin Acme can you check?", ["Lin Acme"])).toEqual(["Fix is up, ", { mention: "Lin Acme" }, " can you check?"]);
  });
  test("the longest name wins where one starts another", () => {
    expect(mentionParts("ask @Ada Orbit now", ["Ada", "Ada Orbit"])).toEqual(["ask ", { mention: "Ada Orbit" }, " now"]);
  });
  test("an address, a name run into a word, and nobody behind the @ stay text", () => {
    expect(mentionParts("mail ada@Ada Orbit.dev", ["Ada Orbit"])).toEqual(["mail ada@Ada Orbit.dev"]);
    expect(mentionParts("@Ada Orbiting", ["Ada Orbit"])).toEqual(["@Ada Orbiting"]);
    expect(mentionParts("@Grace said", ["Ada Orbit"])).toEqual(["@Grace said"]);
    expect(mentionParts("no names", [])).toEqual(["no names"]);
  });
  test("the same person twice, and punctuation right after", () => {
    expect(mentionParts("@Ada Orbit, @Ada Orbit.", ["Ada Orbit"])).toEqual([{ mention: "Ada Orbit" }, ", ", { mention: "Ada Orbit" }, "."]);
  });
});

describe("dates", () => {
  const at = new Date(2026, 10, 12, 16, 42).getTime();
  test("the exact date, and nothing for no date", () => {
    expect(exactDate(at)).toBe("12 Nov 2026, 16:42");
    expect(exactDate(0)).toBe("");
  });
  test("(edited) drops the year it shares with the comment, and keeps it across a year", () => {
    expect(editedLabel(at, new Date(2026, 10, 12, 17, 5).getTime())).toBe("(edited 12 Nov, 17:05)");
    expect(editedLabel(at, new Date(2027, 0, 3, 9, 0).getTime())).toBe("(edited 3 Jan 2027, 09:00)");
    expect(editedLabel(at, undefined)).toBe("(edited)");
  });
  test("the hover names the full date and who edited, as far as Jira said", () => {
    const e = new Date(2026, 10, 12, 17, 5).getTime();
    expect(editedTip(e, "Lin Acme")).toBe("Edited 12 Nov 2026, 17:05 by Lin Acme");
    expect(editedTip(e)).toBe("Edited 12 Nov 2026, 17:05");
    expect(editedTip(undefined, "Lin Acme")).toBe("Edited by Lin Acme");
    expect(editedTip()).toBe("Changed after it was written");
  });
});

describe("commentLink", () => {
  test("built on the card's own address, a path prefix kept", () => {
    expect(commentLink("https://orbit.example.net/browse/ORBIT-1042", "ORBIT-1042", "10021")).toBe("https://orbit.example.net/browse/ORBIT-1042?focusedCommentId=10021");
    expect(commentLink("https://dc.example.net/jira/browse/ORBIT-1042", "ORBIT-1042", "7")).toBe("https://dc.example.net/jira/browse/ORBIT-1042?focusedCommentId=7");
  });
  test("no address, a bad one or another scheme: no link", () => {
    expect(commentLink(undefined, "ORBIT-1042", "7")).toBeNull();
    expect(commentLink("not a url", "ORBIT-1042", "7")).toBeNull();
    expect(commentLink("javascript:alert(1)", "ORBIT-1042", "7")).toBeNull();
    expect(commentLink("https://orbit.example.net/browse/ORBIT-1042", "ORBIT-1042", "")).toBeNull();
  });
});

describe("editRoster", () => {
  test("kept mentions first, then the ones picked while editing, once each", () => {
    const ada = { id: "acc-1", name: "Ada Orbit" }, lin = { id: "acc-2", name: "Lin Acme" };
    expect(editRoster([ada], [ada, lin])).toEqual([ada, lin]);
    expect(editRoster([], [])).toEqual([]);
  });
});

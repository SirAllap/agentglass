/*
 * Finding the line that said your name.
 *
 * The inbox knows THAT you were mentioned; opening the pull request left you at
 * the top of a forty-entry conversation hunting for the part about you. Every
 * interesting case here is a string one, which is why this is a module and not
 * a regular expression inside a click handler.
 */
import { describe, expect, test } from "bun:test";
import { callsOut, findMention, prose } from "../src/lib/prMention.ts";

describe("what counts as being called", () => {
  test("your name, however the sentence runs", () => {
    expect(callsOut("@ana can you look at this", "ana")).toBe(true);
    expect(callsOut("thanks @ana!", "ana")).toBe(true);
    expect(callsOut("(@ana)", "ana")).toBe(true);
    // GitHub's logins are case-insensitive and people type them either way.
    expect(callsOut("cc @Ana", "ana")).toBe(true);
    expect(callsOut("cc @ana", "Ana")).toBe(true);
  });

  test("a longer name that starts with yours is not you", () => {
    expect(callsOut("@anabel please", "ana")).toBe(false);
    expect(callsOut("@ana-bot ran it", "ana")).toBe(false);
  });

  test("an address is not a call", () => {
    expect(callsOut("write to ana@example.test", "ana")).toBe(false);
  });

  /* Code is code. A shell line or a URL with a name in it is not somebody
     asking you for anything, and a notification that jumps you to one is worse
     than not jumping at all. */
  test("nor is a name inside code or a link target", () => {
    expect(callsOut("run `curl -u @ana`", "ana")).toBe(false);
    expect(callsOut("```\nssh @ana@host\n```", "ana")).toBe(false);
    expect(callsOut("see [the diff](https://example.test/@ana/x)", "ana")).toBe(false);
    // But the visible text of a link still counts.
    expect(callsOut("see [@ana's note](https://example.test/x)", "ana")).toBe(true);
  });

  test("prose strips the parts that are not prose", () => {
    expect(prose("a `b` c")).toBe("a   c");
    expect(prose("x\n```\n@ana\n```\ny")).toBe("x\n \ny");
  });
});

const at = (iso: string) => ({ createdAt: iso });

describe("which entry to jump to", () => {
  const detail = {
    body: "Fixes the retry loop. cc @ana",
    comments: [
      { nodeId: "C1", body: "no mention here", ...at("2026-08-19T09:00:00Z") },
      { nodeId: "C2", body: "@ana this is the one", ...at("2026-08-19T11:00:00Z") },
      { nodeId: "C3", body: "@ana earlier", ...at("2026-08-19T10:00:00Z") },
    ],
    reviews: [{ nodeId: "R1", body: "looks good, @ana", ...at("2026-08-19T08:00:00Z") }],
    threads: [{ id: "T1", comments: [{ body: "@ana on this line", ...at("2026-08-19T07:00:00Z") }] }],
  };

  test("the most recent one, because that is what the notification is about", () => {
    expect(findMention(detail, "ana")).toEqual({ where: "node", id: "C2" });
  });

  /* A description that says "cc @ana" is true for the life of the pull request;
     a comment from a minute ago is what just happened. */
  test("the body loses to anything somebody said", () => {
    expect(findMention({ ...detail, comments: [] }, "ana")).toEqual({ where: "node", id: "R1" });
  });

  test("a line thread when there is nothing in the timeline", () => {
    expect(findMention({ body: "nothing", threads: detail.threads }, "ana")).toEqual({ where: "thread", id: "T1" });
  });

  test("the body when that is the only place", () => {
    expect(findMention({ body: "cc @ana" }, "ana")).toEqual({ where: "body", id: "" });
  });

  /* An entry with no node id cannot be scrolled to. Landing on the body is
     honest; jumping nowhere and flashing nothing is not. */
  test("a mention we cannot address lands on the body rather than nowhere", () => {
    expect(findMention({ comments: [{ body: "@ana hi", ...at("2026-08-19T11:00:00Z") }] }, "ana"))
      .toEqual({ where: "body", id: "" });
  });

  test("nobody said your name", () => {
    expect(findMention(detail, "bruno")).toBeNull();
    expect(findMention({}, "ana")).toBeNull();
  });
});

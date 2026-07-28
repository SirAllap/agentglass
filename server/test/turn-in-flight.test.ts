// Knowing which sessions are mid-turn is what stops a second `claude` being
// put on a transcript that is already being written — the failure that cut
// replies off halfway and lost the message that caused it.
import { describe, expect, test } from "bun:test";
import { sessionIdIn, activeTurns, turnActive } from "../src/chat.ts";

describe("sessionIdIn", () => {
  test("reads the id out of the opening frame", () => {
    const frame = JSON.stringify({
      type: "system", subtype: "init", session_id: "e3276954-da78-4890-b206-97239111dc5b", model: "claude-haiku-4-5",
    });
    expect(sessionIdIn(frame)).toBe("e3276954-da78-4890-b206-97239111dc5b");
  });

  test("finds it wherever in the chunk it lands", () => {
    expect(sessionIdIn(`{"a":1}\n{"type":"system","session_id":"abcdef12-0000-4000-8000-000000000000"}\n`))
      .toBe("abcdef12-0000-4000-8000-000000000000");
  });

  test("no id in an ordinary assistant frame", () => {
    expect(sessionIdIn(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })))
      .toBe(null);
  });

  test("a truncated or malformed id is not an id", () => {
    expect(sessionIdIn(`{"session_id":"short"}`)).toBe(null);
    expect(sessionIdIn(`{"session_id":}`)).toBe(null);
    expect(sessionIdIn("")).toBe(null);
  });

  test("does not mistake a similarly named field", () => {
    expect(sessionIdIn(`{"parent_session_ids":["aaaaaaaa-0000-4000-8000-000000000000"]}`)).toBe(null);
  });
});

describe("the in-flight register", () => {
  test("starts empty and answers for an unknown session", () => {
    // No turn has been spawned in this process, so nothing may claim to be one:
    // a false positive here freezes a composer that should be usable.
    expect(activeTurns()).toEqual([]);
    expect(turnActive("e3276954-da78-4890-b206-97239111dc5b")).toBe(false);
    expect(turnActive("")).toBe(false);
  });
});

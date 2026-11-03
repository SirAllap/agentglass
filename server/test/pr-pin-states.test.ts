import { beforeEach, describe, expect, test } from "bun:test";
import { groupPins, prPinStates } from "../src/prPinStates.ts";
import { __resetTtlReads } from "../src/ttlread.ts";

// The pinned-PR menu asks for every pin at once: two repositories, three pins,
// one GitHub request, and a second open inside the minute asks for nothing.
const answer = {
  data: {
    r0: { p7: { state: "OPEN", isDraft: false }, p9: { state: "MERGED", isDraft: false } },
    r1: { p3: { state: "OPEN", isDraft: true } },
  },
};

describe("prPinStates", () => {
  beforeEach(() => __resetTtlReads());

  test("one request for all pins, mapped to the four states, then served from memory", async () => {
    const queries: string[] = [];
    const io = async (q: string) => { queries.push(q); return answer; };
    const pins = "acme/orbit#7,acme/orbit#9,acme/zenith#3,not-a-pin,acme/orbit#7";
    const first = await prPinStates(pins, io);
    expect(queries.length).toBe(1);
    expect(first.states).toEqual({ "acme/orbit#7": "open", "acme/orbit#9": "merged", "acme/zenith#3": "draft" });
    await prPinStates(pins, io);
    expect(queries.length).toBe(1);
  });

  test("a failed answer leaves no state and is not remembered", async () => {
    let calls = 0;
    const io = async () => { calls++; return null; };
    expect((await prPinStates("acme/orbit#7", io)).ok).toBe(false);
    await prPinStates("acme/orbit#7", io);
    expect(calls).toBe(2);
  });

  test("nothing a caller sends reaches the query unchecked", () => {
    const by = groupPins('acme/orbit#1" } } mutation{x,acme/orbit#2');
    expect([...by.entries()]).toEqual([["acme/orbit", [2]]]);
  });
});

/*
 * The `/stream` initial frame sends 300 events at once. Measured on a real
 * feed: 542 KB total, 374 KB of it `payload`, and ten events — full file
 * writes, long command output — for 150 KB of that on their own. The feed
 * only ever reads a handful of short fields back out of a payload; nothing on
 * first paint reads the full body of a 30 KB file write.
 *
 * capPayloadStrings caps rather than strips, because one caller (a chat pane
 * resuming mid-turn) does read a tool's real output — so this asserts both
 * halves: short strings pass through untouched, and long ones are cut with a
 * marker saying how much was dropped, at every depth a real payload nests
 * strings at.
 */
import { describe, expect, test } from "bun:test";
import { capPayloadStrings } from "../src/db.ts";

describe("capPayloadStrings", () => {
  test("leaves short strings and non-strings alone", () => {
    const payload = { tool_name: "Write", ok: true, n: 3, tags: ["a", "b"] };
    expect(capPayloadStrings(payload)).toEqual(payload);
  });

  test("caps a long string at the top level", () => {
    const long = "x".repeat(5000);
    const out = capPayloadStrings({ message: long }, 4000) as { message: string };
    expect(out.message.length).toBeLessThan(long.length);
    expect(out.message.startsWith("x".repeat(4000))).toBe(true);
    expect(out.message).toContain("+1000 chars");
  });

  test("caps nested strings — tool_input and tool_response, where the real payloads carry them", () => {
    const bigFile = "line\n".repeat(2000); // well over the cap
    const bigOutput = "y".repeat(10_000);
    const out = capPayloadStrings({
      tool_input: { file_path: "/a/b.ts", content: bigFile },
      tool_response: { content: bigOutput },
    }, 4000) as any;
    expect(out.tool_input.file_path).toBe("/a/b.ts"); // short field: untouched
    expect(out.tool_input.content.length).toBeLessThan(bigFile.length);
    expect(out.tool_response.content.length).toBeLessThan(bigOutput.length);
  });

  test("caps strings inside arrays", () => {
    const long = "z".repeat(5000);
    const out = capPayloadStrings({ list: [long, "short"] }, 4000) as { list: string[] };
    expect(out.list[0].length).toBeLessThan(long.length);
    expect(out.list[1]).toBe("short");
  });
});

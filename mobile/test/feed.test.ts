// The phone drew what an agent said and never what it did, so twenty minutes
// of reading, running and editing looked like three sentences. These pin the
// feed that fixed it: same information as the desktop, grouped for a 412px
// screen.
import { describe, expect, test } from "bun:test";
import { buildFeed, summariseRuns, shortTarget, type FeedEntry } from "../src/model/transcript.ts";

/** The server's order: newest first. */
const msg = (ts: number, text: string, role: "user" | "assistant" = "assistant"): FeedEntry =>
  ({ kind: "message", ts, role, text });
const tool = (ts: number, t: string, target?: string, is_error = false): FeedEntry =>
  ({ kind: "tool", ts, tool: t, target: target ?? null, is_error });

describe("buildFeed", () => {
  test("oldest first, messages and work interleaved", () => {
    const feed = buildFeed([
      msg(500, "done"),
      tool(400, "Edit", "/repo/web/src/app.tsx"),
      tool(300, "Read", "/repo/web/src/app.tsx"),
      msg(200, "have a look", "user"),
    ]);
    expect(feed.map((f) => f.kind)).toEqual(["message", "tools", "message"]);
    expect((feed[0] as { text: string }).text).toBe("have a look");
    expect((feed[2] as { text: string }).text).toBe("done");
  });

  test("consecutive runs collapse into one block, in order", () => {
    const feed = buildFeed([tool(300, "Bash", "bun test"), tool(200, "Read", "a.ts"), tool(100, "Read", "b.ts")]);
    expect(feed).toHaveLength(1);
    const block = feed[0] as { kind: "tools"; runs: { tool?: string }[] };
    expect(block.kind).toBe("tools");
    expect(block.runs.map((r) => r.tool)).toEqual(["Read", "Read", "Bash"]);
  });

  test("a message between two runs breaks the block in two", () => {
    const feed = buildFeed([tool(400, "Edit"), msg(300, "thinking"), tool(200, "Read")]);
    expect(feed.map((f) => f.kind)).toEqual(["tools", "message", "tools"]);
  });

  test("failures are counted so the block can say so", () => {
    const feed = buildFeed([tool(300, "Bash", "bun test", true), tool(200, "Bash", "bun x", false)]);
    expect((feed[0] as { errors: number }).errors).toBe(1);
  });

  test("keeps the newest window, not the oldest", () => {
    const many: FeedEntry[] = Array.from({ length: 200 }, (_, i) => msg(1000 - i, `m${i}`));
    const feed = buildFeed(many, 10);
    expect(feed).toHaveLength(10);
    // Newest is last, and it is the newest of the whole list.
    expect((feed[feed.length - 1] as { text: string }).text).toBe("m0");
  });

  test("an empty or missing timeline is an empty feed, not a crash", () => {
    expect(buildFeed(undefined)).toEqual([]);
    expect(buildFeed([])).toEqual([]);
    // A message with no text carries nothing to draw.
    expect(buildFeed([msg(1, "")])).toEqual([]);
  });
});

describe("summariseRuns", () => {
  test("names the tools and counts the repeats", () => {
    expect(summariseRuns([{ ts: 1, tool: "Read" }, { ts: 2, tool: "Read" }, { ts: 3, tool: "Bash" }]))
      .toBe("Read ×2 · Bash");
  });

  test("stops at three kinds and says how many more", () => {
    const runs = ["Read", "Bash", "Edit", "Grep", "Write"].map((t, i) => ({ ts: i, tool: t }));
    expect(summariseRuns(runs)).toContain("+2 more");
  });

  test("an unnamed run still reads as something", () => {
    expect(summariseRuns([{ ts: 1 }])).toBe("tool");
  });
});

describe("shortTarget", () => {
  test("keeps the end of a path, which is the part that identifies it", () => {
    expect(shortTarget("/home/me/code/app/mobile/src/model/transcript.ts")).toBe("model/transcript.ts");
  });

  test("a command stays a command", () => {
    expect(shortTarget("bun test web/test")).toBe("bun test web/test");
  });

  test("long text is clipped, not wrapped", () => {
    expect(shortTarget("x".repeat(100)).length).toBe(46);
  });

  test("nothing to show is empty, not 'null'", () => {
    expect(shortTarget(null)).toBe("");
    expect(shortTarget(undefined)).toBe("");
  });
});

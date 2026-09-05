/*
 * A container's log as a feed.
 *
 * The two things worth pinning are the ones a live daemon would hide: what
 * happens when a line arrives in two pieces (which is normal, because chunks
 * are bytes off a socket and not lines), and what "pause" means — because a
 * pause that drops what arrived while you were reading is a log viewer that
 * lies quietly.
 */
import { describe, expect, test } from "bun:test";
import { createLogFeed, filterLines, levelOf } from "../src/lib/dockerLogFeed.ts";

/** A stream we can push into by hand, so no daemon and no timing are involved. */
function pipe() {
  let push!: (s: string) => void;
  let stop!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      push = (s: string) => c.enqueue(enc.encode(s));
      stop = () => { try { c.close(); } catch { /* already closed */ } };
    },
  });
  return { stream, push: (s: string) => push(s), stop: () => stop() };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("what arrives", () => {
  test("whole lines land in order", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    p.push("one\ntwo\nthree\n");
    await settle();
    expect(feed.lines()).toEqual(["one", "two", "three"]);
    feed.close();
  });

  /* The case that makes this a module instead of a `split("\n")` at the call
     site: a chunk can end mid-line and the rest arrives later. */
  test("a line split across two chunks is one line", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    p.push("GET /api/ca");
    await settle();
    expect(feed.lines()).toEqual([]);           // nothing complete yet
    p.push("lls 200\n");
    await settle();
    expect(feed.lines()).toEqual(["GET /api/calls 200"]);
    feed.close();
  });

  test("a trailing line with no newline is kept when the stream ends", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    p.push("last thing said");
    p.stop();
    await settle();
    expect(feed.lines()).toEqual(["last thing said"]);
    feed.close();
  });

  test("colour codes are stripped, so a streamed line reads like a polled one", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    p.push("[31mERROR[0m boom\n");
    await settle();
    expect(feed.lines()).toEqual(["ERROR boom"]);
    feed.close();
  });

  test("the buffer is capped, oldest first", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {}, cap: 3 });
    p.push("a\nb\nc\nd\ne\n");
    await settle();
    expect(feed.lines()).toEqual(["c", "d", "e"]);
    feed.close();
  });
});

describe("pausing", () => {
  test("holds the view still and keeps receiving", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    p.push("before\n");
    await settle();
    feed.pause();
    p.push("during one\nduring two\n");
    await settle();

    // Reading is why you paused: the view must not move.
    expect(feed.lines()).toEqual(["before"]);
    // But nothing is lost, and the button can say how much is waiting.
    expect(feed.waiting()).toBe(2);

    feed.resume();
    expect(feed.lines()).toEqual(["before", "during one", "during two"]);
    expect(feed.waiting()).toBe(0);
    feed.close();
  });

  test("a long pause still respects the cap", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {}, cap: 2 });
    feed.pause();
    p.push("a\nb\nc\nd\n");
    await settle();
    feed.resume();
    expect(feed.lines()).toEqual(["c", "d"]);
    feed.close();
  });
});

describe("ending", () => {
  test("the stream closing is said out loud, not left as silence", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    expect(feed.ended()).toBe(null);
    p.stop();
    await settle();
    expect(feed.ended()).toBe("the stream ended");
    feed.close();
  });

  test("a transport that refuses says why", async () => {
    const feed = createLogFeed({ open: async () => ({ error: "too many log streams are already open" }), onChange: () => {} });
    await settle();
    expect(feed.ended()).toContain("too many log streams");
  });

  test("closing on purpose is not an error to report", async () => {
    const p = pipe();
    const feed = createLogFeed({ open: async () => p.stream, onChange: () => {} });
    feed.close();
    p.stop();
    await settle();
    expect(feed.ended()).toBe(null);
  });
});

describe("reading it", () => {
  test("the level of a line, by the words logs actually use", () => {
    expect(levelOf("2026-08-19 ERROR upstream timeout")).toBe("error");
    expect(levelOf("WARN cache miss")).toBe("warn");
    expect(levelOf("INFO ready")).toBe("info");
    expect(levelOf("DEBUG payload")).toBe("debug");
    expect(levelOf("GET /api/calls 200")).toBe(null);
  });

  /* "At least this level", not "exactly": filtering to warnings and being shown
     no errors is a filter that hides the worse thing. */
  test("a filter shows that level and everything above it", () => {
    const lines = ["DEBUG a", "INFO b", "WARN c", "ERROR d", "plain e"];
    expect(filterLines(lines, "warn", "")).toEqual(["WARN c", "ERROR d"]);
    expect(filterLines(lines, "error", "")).toEqual(["ERROR d"]);
    expect(filterLines(lines, null, "")).toEqual(lines);
  });

  test("the search reaches lines that carry no level at all", () => {
    // A stack trace's body has no level and is the half you came for.
    const lines = ["ERROR boom", "  at handler (app.py:41)", "INFO fine"];
    expect(filterLines(lines, null, "handler")).toEqual(["  at handler (app.py:41)"]);
  });

  test("search and level together", () => {
    const lines = ["ERROR timeout", "ERROR refused", "WARN timeout"];
    expect(filterLines(lines, "error", "timeout")).toEqual(["ERROR timeout"]);
  });
});

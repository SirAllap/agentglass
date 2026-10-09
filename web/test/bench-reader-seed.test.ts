/*
 * The bench reader starts on the file you asked for, not on the oldest tab.
 *
 * Measured on an isolated server driving the real bundle: with an older file
 * tab still open in the checkout, "Edit in nvim" on the other file of the same
 * folder started nvim on the OLDER one — the reader session was created with
 * `files[0]`, and the /bench/edit meant to correct it had fired before the
 * session existed and was never sent again. The live half (a shell reader is
 * replaced by nvim on the exact path) is server/test/bench-reader-live.test.ts;
 * this is the choice the window makes before it opens the socket.
 */
import { describe, expect, it } from "bun:test";
import { readerSeed, type BenchTab } from "../src/lib/benchStore.ts";

const file = (id: string, path: string): BenchTab => ({ id, kind: "file", slot: 90, title: path.split("/").pop()!, path });
const older = file("a", "/home/u/Documents/run1/results.json");
const asked = file("b", "/home/u/Documents/run1/results.md");
const term: BenchTab = { id: "t", kind: "term", slot: 1, title: "shell" };

const bench = await Bun.file(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url)).text();

describe("the file the reader session is created with", () => {
  it("is the file on screen, not the oldest file tab", () => {
    expect(readerSeed(null, asked, [older, asked])?.path).toBe(asked.path);
  });

  it("stays the one it was built for while that tab is open, so switching tabs does not reconnect", () => {
    expect(readerSeed(older, asked, [older, asked])).toBe(older);
  });

  it("moves on when the tab it was built for is closed", () => {
    expect(readerSeed(older, asked, [asked])).toBe(asked);
  });

  it("falls back to the oldest file only when no file is on screen", () => {
    expect(readerSeed(null, term, [older, asked])).toBe(older);
    expect(readerSeed(null, null, [])).toBeUndefined();
  });

  it("the window uses this rule, and rebuilds the reader when its editor cannot be reached", () => {
    expect(bench).toContain("readerSeed(");
    expect(bench).not.toMatch(/const seed = files\[0\]/);
    // Not live after the retry is a rebuild on the file asked for, not silence.
    expect(bench).toMatch(/setReaderAt\(\(b\) => \(\{ root, tab: want, gen: \(b\?\.gen \?\? 0\) \+ 1 \}\)\)/);
    expect(bench).toContain("key={readerAt?.gen ?? 0}");
  });
});

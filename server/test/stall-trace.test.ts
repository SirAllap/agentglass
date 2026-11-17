/*
 * The server stall trace: a line on disk for a loop block past LOG_MS, so a
 * freeze report has "nothing from the server" to check against instead of
 * assuming it. The rotation math is pure (no fs), so it is asserted here
 * without a real 1MB file.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendStallLine, rotationPaths, shouldRotate, ROTATE_BYTES, ROTATE_KEEP } from "../src/stallTrace.ts";
import { readFileSync as readSrc } from "node:fs";

const loopwatchSrc = readSrc(join(import.meta.dir, "..", "src", "loopwatch.ts"), "utf8");

describe("rotation math (pure)", () => {
  test("rotation is needed only past the cap", () => {
    expect(shouldRotate(ROTATE_BYTES, ROTATE_BYTES)).toBe(false);
    expect(shouldRotate(ROTATE_BYTES + 1, ROTATE_BYTES)).toBe(true);
  });

  test("the rename plan keeps 3 files, oldest overwritten last", () => {
    expect(rotationPaths("server-stall.log", ROTATE_KEEP)).toEqual([
      ["server-stall.log.1", "server-stall.log.2"],
      ["server-stall.log", "server-stall.log.1"],
    ]);
  });
});

describe("appendStallLine", () => {
  test("appends without rotating under the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-trace-"));
    const file = join(dir, "server-stall.log");
    appendStallLine(file, "one\n", ROTATE_BYTES);
    appendStallLine(file, "two\n", ROTATE_BYTES);
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  test("rotates to .1 once the file is over the cap, never truncating", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-trace-"));
    const file = join(dir, "server-stall.log");
    writeFileSync(file, "old-content\n");
    appendStallLine(file, "new\n", 1); // cap of 1 byte: already over it
    expect(readFileSync(`${file}.1`, "utf8")).toBe("old-content\n");
    expect(readFileSync(file, "utf8")).toBe("new\n");
  });
});

describe("wired into loopwatch", () => {
  test("a stall past LOG_MS writes last=<label> to the trace file, beside the console line", () => {
    expect(loopwatchSrc).toContain("appendStallLine(join(stateDir(), \"server-stall.log\")");
    expect(loopwatchSrc).toContain("server stall ms=${ms} last=${by}");
  });
});

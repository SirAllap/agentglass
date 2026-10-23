/*
 * "Abort" on the merge strip asks before it discards resolutions. A second click
 * while the session was being read or the question was open raised a second
 * question, because `busy` is only set once the abort itself runs.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url).pathname).text();
const start = src.indexOf("const abortMerge = async () => {");
const body = src.slice(start, src.indexOf("\n  };", start));

describe("abortMerge", () => {
  test("returns early while busy or while a first click is still asking", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("if (busy || aborting.current) return;");
  });

  test("lets go of the guard on every way out of the question", () => {
    expect(body).toContain("finally { aborting.current = false; }");
  });
});

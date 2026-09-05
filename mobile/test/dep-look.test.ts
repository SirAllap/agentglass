/*
 * Every status the server can answer has a word on the phone.
 *
 * The Troubleshooting screen indexed `LOOK[dep.status]` with a table of three
 * and the server answers four: `unsupported`, for a tool this platform never
 * uses. On the missing key `.word` threw, and the screen for finding out what
 * is broken was the broken thing. The table is now typed against the shared
 * `DepStatus`, so `tsc` catches a fifth; this checks the words and tones are
 * the right way round, which a type cannot.
 */
import { describe, expect, test } from "bun:test";
import type { DepStatus } from "../../shared/deps.ts";
import { DEP_LOOK, depNeedsAttention } from "../src/model/depLook.ts";

/** Written out rather than derived, so a status added to shared/deps.ts shows
 *  up here as a type error AND as a missing row. */
const EVERY: DepStatus[] = ["ok", "attention", "missing", "unsupported"];

describe("DEP_LOOK", () => {
  test("has a word for each status, and the word is not empty", () => {
    for (const status of EVERY) {
      expect(DEP_LOOK[status], status).toBeDefined();
      expect(DEP_LOOK[status].word.length, status).toBeGreaterThan(0);
    }
  });

  test("unsupported is quiet — neither the green of installed nor a warning", () => {
    /* A tool the platform does not use is nothing to fix. The exact failure a
       warning colour would produce: somebody walking to the computer to install
       Docker Desktop on Linux. */
    expect(DEP_LOOK.unsupported.tone).toBe("mute");
    expect(DEP_LOOK.unsupported.word).toBe("not used here");
  });

  test("the three that were there keep their severities", () => {
    expect(DEP_LOOK.ok.tone).toBe("good");
    expect(DEP_LOOK.attention.tone).toBe("warn");
    expect(DEP_LOOK.missing.tone).toBe("bad");
  });
});

describe("depNeedsAttention", () => {
  test("the two problems", () => {
    expect(depNeedsAttention("attention")).toBe(true);
    expect(depNeedsAttention("missing")).toBe(true);
  });
  test("and not the two non-problems", () => {
    // `unsupported` in this set would make "Everything this app shells out to
    // is installed" false on every machine with a platform.
    expect(depNeedsAttention("ok")).toBe(false);
    expect(depNeedsAttention("unsupported")).toBe(false);
  });
});

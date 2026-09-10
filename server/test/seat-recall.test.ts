/*
 * THE BANK OUTLIVES THE VIEW IT CAME IN.
 *
 * The Clone's rail seat is gone and its ledger stops being written the moment
 * its enable flag goes false. If `recall` were gated on that same flag,
 * switching the scoreboard off would silently take ten thousand precedents
 * with it and the seat would go back to being a fresh model with no memory of
 * this person.
 *
 * The first version of this test proved that by setting
 * AGENTGLASS_UNDERSTUDY=0 — and bun runs every file in ONE process, so it
 * turned the Clone off for twenty other tests. The property is about what this
 * module reads, so it is checked on the module rather than on the environment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-recall-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const { recall, recallBlock } = await import("../src/seatmemory.ts");

describe("the seat's memory does not depend on the Clone being switched on", () => {
  test("it never asks whether the Clone is enabled", () => {
    const src = readFileSync(new URL("../src/seatmemory.ts", import.meta.url), "utf8");
    /* The switch, by both of its names. Reading the bank is not acting as the
       Clone: one is a scoreboard nobody scores, the other is what this person
       has decided. */
    expect(src).not.toContain("AGENTGLASS_UNDERSTUDY");
    expect(src).not.toMatch(/\benabled\s*\(/);
    expect(src).not.toContain("understudyEnabled");
  });
});

describe("what it answers with", () => {
  test("an empty bank says it has nothing instead of inventing a precedent", () => {
    /* A test database has no rows. The seat must be told that in words, or it
       will present its own opinion as this person's. */
    const block = recallBlock("something nobody has ever written down here");
    expect(block).toContain("Nothing recorded");
    expect(block).toContain("no precedent");
  });

  test("an empty question is not a question", () => {
    expect(recallBlock("   ")).toBe("");
    expect(recall("  ").thin).toBe(true);
  });

  test("a question comes back flattened to one line", () => {
    expect(recall("  do I\n  squash  ").question).toBe("do I squash");
  });
});

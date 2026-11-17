import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_ROWS, FLIGHT_PLAN_ROWS, POLARIS_ROWS, SEAT_ROWS, STORED_ROWS, TRACKER_ROWS } from "../src/components/orchestration/doorSpecs.ts";
import { ENV_LIMITS } from "../../shared/envLimits.ts";
import { oneSentence as firstSentence } from "../src/components/orchestration/DoorValueRow.tsx";

/* Every row's help, on every Settings page: one sentence, 14 words at most, ending in a full stop. */
const PAGES = join(import.meta.dir, "..", "src", "components", "settings", "pages");
const files = readdirSync(PAGES).filter((f) => /\.(ts|tsx)$/.test(f)).sort();

/** The help strings written as `help="…"` or `help: "…"`; an expression is not read. */
export const helps = (code: string): string[] => [...code.matchAll(/\bhelp(?:=|:\s*)\{?\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1]!);

/** One sentence: no full stop, question mark or "!" followed by more words. */
export const oneSentence = (s: string): boolean => !/[.!?…]["')]?\s+\S/.test(s.trim());

describe("help copy: one sentence of 14 words at most", () => {
  test("the scan sees the helps", () => {
    const n = files.reduce((a, f) => a + helps(readFileSync(join(PAGES, f), "utf8")).length, 0);
    expect(n).toBeGreaterThan(150);
  });
  test("a two-sentence help fails the rule", () => {
    expect(oneSentence("Stops it. Then restarts it.")).toBe(false);
    expect(oneSentence("Stops a worker that runs too long.")).toBe(true);
  });
  for (const f of files) {
    test(f, () => {
      for (const h of helps(readFileSync(join(PAGES, f), "utf8"))) {
        expect(h.trim().split(/\s+/).length, `${f}: ${h}`).toBeLessThanOrEqual(14);
        expect(oneSentence(h), `${f}: ${h}`).toBe(true);
        expect(/[.…]$/.test(h), `${f}: ${h}`).toBe(true);
      }
    });
  }

  // The door rows draw their own hint when a page gives no help of its own: the same rule.
  test("door rows and the limits table", () => {
    const hints = [...CLEANUP_ROWS, ...FLIGHT_PLAN_ROWS, ...POLARIS_ROWS, ...SEAT_ROWS, ...STORED_ROWS, ...TRACKER_ROWS].map((r) => ({ id: r.id, h: r.hint }))
      .concat(ENV_LIMITS.map((l) => ({ id: l.id, h: firstSentence(l.hint) })));
    for (const { id, h } of hints) {
      expect(h.trim().split(/\s+/).length, `${id}: ${h}`).toBeLessThanOrEqual(14);
      expect(oneSentence(h), `${id}: ${h}`).toBe(true);
    }
  });
});

/**
 * The Radar dial measures a session against ITS OWN context window.
 *
 * The same token count means different things on a 200K model and a 1M one:
 * 180K is a 200K session about to compact and a 1M session with most of its
 * room left. The dial answers "how close is this one to compacting", so two
 * sessions at the same share of their own window sit at the same distance,
 * whatever the window, and the absolute tokens live in the blip's tooltip.
 */
import { describe, expect, test } from "bun:test";
import { ctxShare, blipTitle } from "../src/components/Radar.tsx";

const card = (ctxTokens: number, ctxLimit: number) => ({ ctxTokens, ctxLimit, title: "orbit-api", source_app: "acme" });

describe("the radar dial scale", () => {
  test("the same share of their own window draws at the same distance", () => {
    expect(ctxShare(card(500_000, 1_000_000))).toBeCloseTo(0.5, 6);
    expect(ctxShare(card(100_000, 200_000))).toBeCloseTo(0.5, 6);
  });

  test("the same token count on a bigger window reads as more room", () => {
    expect(ctxShare(card(180_000, 200_000))!).toBeGreaterThan(ctxShare(card(180_000, 1_000_000))!);
  });

  test("no turn yet has no share, so the blip falls back to recency", () => {
    expect(ctxShare(card(0, 200_000))).toBeNull();
    expect(ctxShare(card(40_000, 0))).toBeNull();
  });

  test("the tooltip carries the absolute tokens and the window they are measured against", () => {
    const t = blipTitle(card(412_000, 1_000_000));
    expect(t).toContain("orbit-api");
    expect(t).toContain("412");
    expect(t).toContain("1.00M");
    expect(t).toContain("41%");
  });

  test("a blip with no turn says so instead of printing 0%", () => {
    expect(blipTitle(card(0, 200_000))).not.toContain("%");
  });
});

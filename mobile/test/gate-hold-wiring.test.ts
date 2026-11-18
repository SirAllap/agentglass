/*
 * What the gate card promises about its two decisions, asserted against its
 * source and the button it holds (there is no renderer here).
 *
 *   - Allow is a HOLD. The release is the dangerous half — the server says so —
 *     and a plain press that allows is the one thing this screen must not have.
 *   - Deny stays a tap: the safe direction must not be slower.
 *   - A released hold reports that nothing was sent, and the button asks the
 *     policy before it acts rather than hardcoding a duration.
 */
import { describe, expect, test } from "bun:test";

const strip = (src: string): string =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

const card = strip(await Bun.file(new URL("../src/terminal/GateCard.tsx", import.meta.url)).text());
const ui = strip(await Bun.file(new URL("../src/ui.tsx", import.meta.url)).text());

describe("the gate's Allow", () => {
  test("is drawn as a hold for the permission policy, never as a press", () => {
    expect(card).toContain('action="gate.allow"');
    expect(card).not.toMatch(/onPress=\{\(\) => \{\s*void decide\("allow"\)/);
    expect(card).not.toMatch(/\{button\("Allow"/);
  });

  test("reports a release that decided nothing", () => {
    expect(card).toContain("onRelease");
  });
});

describe("the gate's Deny", () => {
  test("stays a tap, because the safe direction must not be slow", () => {
    expect(card).toMatch(/onPress=\{\(\) => \{ void decide\("deny"\); \}\}/);
  });
});

describe("the hold button", () => {
  test("asks the policy rather than owning the duration", () => {
    expect(ui).toContain("settle(");
    expect(ui).toContain("HOLD_MS");
    expect(ui).toContain("onPressOut");
  });
});

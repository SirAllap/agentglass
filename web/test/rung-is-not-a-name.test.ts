/*
 * THE WORD BESIDE THE PORTRAIT IS A SETTING.
 *
 * "I don't understand why you called it deputy, I'm not sure it really fits
 * with this." Nobody had named it that: the portrait's own label is "The
 * clone", and the word above the counts is `rungFor(frame.level).name` — how
 * much the clone is allowed to do without asking. Set in 13px semibold next to
 * a face and with nothing else around it, a setting reads as a name.
 *
 * So the rung carries the micro-label every other setting on this screen has,
 * and this fails if it loses it again.
 */
import { describe, expect, test } from "bun:test";

const PANEL = new URL("../src/components/understudy/UnderstudyPanel.tsx", import.meta.url);

describe("the rung says what it is", () => {
  test("the level is labelled where it is drawn", async () => {
    const src = await Bun.file(PANEL).text();
    const at = src.indexOf("rungFor(frame.level).name");
    expect(at).toBeGreaterThan(0);
    /* Whatever the block grows to, the label has to be in the same span as the
       word — a fixed byte count would pass the day somebody moves it away. */
    const around = src.slice(Math.max(0, at - 700), at);
    expect(around).toContain("how much it may do");
  });

  test("and the portrait is still the thing with the name", async () => {
    const src = await Bun.file(PANEL).text();
    expect(src).toContain('label="The clone"');
  });
});

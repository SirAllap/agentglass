import { describe, expect, it } from "bun:test";

/**
 * A rule about source, asserted against source: there is no renderer in this
 * project. The moment plays a long timeline, and a person who asked their
 * system for less motion must get the finished frame, not the film.
 */
const comp = await Bun.file(new URL("../src/components/Celebration.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/components/celebration.css", import.meta.url)).text();
const host = await Bun.file(new URL("../src/components/WhatsNew.tsx", import.meta.url)).text();

const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the 1.0 moment", () => {
  it("honours prefers-reduced-motion and the app's own switch", () => {
    expect(comp).toContain("(prefers-reduced-motion: reduce)");
    expect(comp).toContain("data-reduce-motion");
  });

  it("creates no animation when motion is reduced", () => {
    const from = comp.indexOf("const play = () => {");
    expect(from).toBeGreaterThan(-1);
    const body = comp.slice(from, comp.indexOf("\n  };", from));
    expect(body).toContain("!reducedMotion()");
    expect(body).toContain("playMoment(");
  });

  it("closes on Escape and cancels the timeline", () => {
    expect(comp).toContain('e.key === "Escape"');
    expect(code(comp)).toContain("a.cancel()");
  });

  it("uses no animation library", () => {
    expect(code(comp)).not.toMatch(/from "motion|from "framer|gsap/);
  });

  it("is reached only through the 1.0 decision", () => {
    expect(host).toContain("isCelebrationTag(announce)");
  });

  it("keeps the small window in one screen", () => {
    expect(css).toContain("@media (max-height: 620px)");
    expect(css).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
  });
});

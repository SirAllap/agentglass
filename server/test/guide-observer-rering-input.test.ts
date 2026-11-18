/* Guide observer decisions: the ring after a same-page #hash step, and the "Use suggestion" fill counting as typing. */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { typingCounts, rearmOpen, REARM_MS, shouldSend, observerSource } = require("../../electron/guide-observer.js") as {
  typingCounts: (trusted: unknown) => boolean;
  rearmOpen: (now: number, armedAt: number, windowMs: number) => boolean;
  REARM_MS: number;
  shouldSend: (hasExtra: boolean, key: string, sent: string, force: boolean) => boolean;
  observerSource: (s: unknown) => string;
};

describe("typingCounts", () => {
  it("counts the person's own keys", () => expect(typingCounts(true)).toBe(true));
  it("ignores a script-made event, tagged or not: the card's fill is reported by the main process", () => {
    expect(typingCounts(false)).toBe(false);
    expect(typingCounts(undefined)).toBe(false);
    expect(typingCounts("true")).toBe(false);
  });
});

describe("rearmOpen", () => {
  it("is shut until a hashchange armed it", () => expect(rearmOpen(5000, 0, REARM_MS)).toBe(false));
  it("is open inside the window", () => expect(rearmOpen(1000 + 1500, 1000, REARM_MS)).toBe(true));
  it("is shut after the window: a later page scroll does not force a send", () => expect(rearmOpen(1000 + 1501, 1000, REARM_MS)).toBe(false));
});

describe("shouldSend", () => {
  it("stays quiet when the rect did not move", () => expect(shouldSend(false, "a", "a", false)).toBe(false));
  it("sends when it moved", () => expect(shouldSend(false, "b", "a", false)).toBe(true));
  it("sends an unmoved rect after a hashchange (force)", () => expect(shouldSend(false, "a", "a", true)).toBe(true));
  it("always sends a press", () => expect(shouldSend(true, "a", "a", false)).toBe(true));
});

describe("guest source", () => {
  const src = observerSource({ selector: "#orbit-1042", wait: "input" });
  it("re-rings on hashchange, popstate and scroll settle", () => {
    for (const k of ['"hashchange", hashed', '"popstate", hashed', '"scrollend", rering']) expect(src).toContain(k);
  });
  it("the draft fill sends input and no change (a change can submit)", () => {
    const drive = readFileSync(resolve(import.meta.dir, "../../web/src/lib/browserDrive.ts"), "utf8");
    expect(drive).not.toContain('n.dispatchEvent(new Event("change", { bubbles: true }));\n  const end');
  });
});

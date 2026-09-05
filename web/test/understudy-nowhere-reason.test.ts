/**
 * The banner has to say WHY it has nowhere to work.
 *
 * It read "It has nowhere to work, so it will decline every task" and stopped
 * there. The morning it mattered the answer was that the app had been
 * relaunched by its own installer, so the server started outside any checkout
 * and discovery found nothing — and the only control on the banner ("Pick a
 * checkout") listed that same empty discovery, so the way out was not on the
 * screen at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nowhereLine } from "../src/components/understudy/Work.tsx";

describe("the line under the banner", () => {
  test("prints the server's reason and the action that fixes it", () => {
    const line = nowhereLine({
      why: "The server was started outside a git checkout and no project has been opened in this app, so discovery had nowhere to look.",
      fix: "Open acme in this app, or start the server from inside the checkout.",
    });
    expect(line.why).toContain("outside a git checkout");
    expect(line.fix).toContain("Open acme");
  });

  test("a server that sends no reason still leaves a why and a fix on screen", () => {
    // The whole point of the change: "nowhere" with nothing after it is the bug.
    for (const r of [null, undefined, {}, { why: "  ", fix: "" }]) {
      const line = nowhereLine(r as never);
      expect(line.why.trim().length, "the banner must always say why").toBeGreaterThan(0);
      expect(line.fix.trim().length, "and what to do about it").toBeGreaterThan(0);
    }
  });
});

describe("the banner itself", () => {
  /* Read from the source: the component fetches in an effect, so a static
     render only ever produces the loading state. Same reason as
     understudy-work-render.test.ts. */
  const SRC = readFileSync(new URL("../src/components/understudy/Work.tsx", import.meta.url), "utf8");

  test("the red block prints the reason, not just the consequence", () => {
    const at = SRC.indexOf("It has nowhere to work, so it will decline every task");
    expect(at, "the banner is still there").toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 900);
    expect(block, "the why").toContain("nowhereLine(reason).why");
    expect(block, "the one action that fixes it").toContain("nowhereLine(reason).fix");
  });

  test("the reason comes from the server, not from a guess in the client", () => {
    expect(SRC).toContain("setReason(ab?.reason ?? null)");
  });
});

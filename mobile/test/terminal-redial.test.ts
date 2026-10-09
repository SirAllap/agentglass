/*
 * A terminal socket the server's restart closed is dialled again by the screen
 * that owns it. The decision lives in `redial.ts`; the wiring is asserted
 * against `TerminalView.tsx` because there is no renderer here.
 */
import { describe, expect, test } from "bun:test";
import { REDIAL_MS, STABLE_MS, redialIn } from "../src/terminal/redial.ts";

const drop = { code: 1006, refused: false, active: true, failures: 0 };

describe("when a dropped terminal is dialled again", () => {
  test("a server that vanished is redialled, soon at first and then less often", () => {
    expect(redialIn(drop)).toBe(1000);
    const waits = REDIAL_MS.map((_, failures) => redialIn({ ...drop, failures }));
    expect(waits).toEqual([...REDIAL_MS]);
    expect([...waits].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(waits);
  });

  test("it gives up after the last wait and leaves the rest to the person", () => {
    expect(redialIn({ ...drop, failures: REDIAL_MS.length })).toBeNull();
  });

  test("a refusal is final: the server said no and why", () => {
    expect(redialIn({ ...drop, refused: true })).toBeNull();
  });

  test("a close the server chose is not a drop", () => {
    expect(redialIn({ ...drop, code: 1000 })).toBeNull();
    expect(redialIn({ ...drop, code: 1008 })).toBeNull();
    expect(redialIn({ ...drop, code: undefined })).toBeNull();
  });

  test("nothing is dialled for a phone in a pocket", () => {
    expect(redialIn({ ...drop, active: false })).toBeNull();
  });

  test("going away and service restart count as the server vanishing", () => {
    expect(redialIn({ ...drop, code: 1001 })).toBe(1000);
    expect(redialIn({ ...drop, code: 1012 })).toBe(1000);
  });
});

const view = await Bun.file(new URL("../src/terminal/TerminalView.tsx", import.meta.url)).text();
const effect = view.slice(view.indexOf("// One socket per pane."), view.indexOf("// Deliberately only what identifies the CONNECTION"));

describe("the socket effect", () => {
  test("asks redialIn from the close handler and bumps the attempt when it answers", () => {
    const at = effect.indexOf("ws.onclose = ");
    expect(at).toBeGreaterThan(-1);
    const handler = effect.slice(at);
    expect(handler).toContain("redialIn(");
    expect(handler).toContain("setAttempt(");
  });

  test("a socket that stayed up starts the count again", () => {
    expect(effect).toContain("STABLE_MS");
  });

  test("the timer dies with the effect, so a retired socket never redials", () => {
    const cleanup = effect.slice(effect.indexOf("return () => {"));
    expect(cleanup).toContain("clearTimeout(");
  });
});

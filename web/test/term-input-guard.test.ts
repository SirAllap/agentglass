/*
 * A mouse report that was computed while the terminal was off screen.
 *
 * Measured in headless Chrome against the shipped xterm: a press, the terminal
 * taken out of the document, a release. The press is `ESC [ < 0 ; 3 ; 1 M`, the
 * release `ESC [ < 0 ; NaN ; NaN m`, because a detached element has no computed
 * style to read the padding from. The program that asked for mouse reports
 * cannot parse that and echoes its tail into the prompt.
 *
 * The risk in a filter on every keystroke is eating something real, so most of
 * this pins what must pass untouched.
 */
import { describe, expect, it } from "bun:test";
import { gridOk, termShown, termInputGuard } from "../src/lib/termInputGuard.ts";

const ESC = "\x1b";
const press = `${ESC}[<0;3;1M`;
const release = `${ESC}[<0;3;1m`;
const nanRelease = `${ESC}[<0;NaN;NaNm`;

describe("termInputGuard", () => {
  it("sends zero bytes for the NaN release seen in the wild", () => {
    const g = termInputGuard();
    expect(g.filter(nanRelease, true)).toBe("");
  });

  it("drops every non-finite or out-of-range coordinate", () => {
    const g = termInputGuard();
    for (const bad of ["NaN;NaN", "Infinity;4", "3;undefined", "-2;5", "0;4", "4;0", "1.5;2", ";", "3;", "7;99999999"]) {
      expect(g.filter(`${ESC}[<0;${bad}M`, true)).toBe("");
      expect(g.filter(`${ESC}[<35;${bad}M`, true)).toBe("");
    }
  });

  it("passes whole, in-range reports through unchanged, motion and wheel too", () => {
    const g = termInputGuard();
    for (const ok of [press, release, `${ESC}[<32;10;4M`, `${ESC}[<64;10;4M`, `${ESC}[<0;249;62m`]) {
      expect(g.filter(ok, true)).toBe(ok);
    }
  });

  it("drops reports while the terminal is hidden, even well formed ones", () => {
    const g = termInputGuard();
    expect(g.filter(`${ESC}[<32;10;4M`, false)).toBe("");
    expect(g.filter(press, false)).toBe("");
  });

  it("answers a release dropped for being late with a clean one where the press was", () => {
    const g = termInputGuard();
    expect(g.filter(press, true)).toBe(press);
    expect(g.filter(nanRelease, false)).toBe(release);
    // Only once: the pair is closed.
    expect(g.filter(nanRelease, false)).toBe("");
  });

  it("does not invent a release for a press that was never sent", () => {
    const g = termInputGuard();
    expect(g.filter(press, false)).toBe("");
    expect(g.filter(nanRelease, false)).toBe("");
  });

  it("a release that went through closes the pair", () => {
    const g = termInputGuard();
    g.filter(press, true);
    g.filter(release, true);
    expect(g.filter(nanRelease, false)).toBe("");
  });

  it("also guards the urxvt encoding", () => {
    const g = termInputGuard();
    expect(g.filter(`${ESC}[35;NaN;NaNM`, true)).toBe("");
    expect(g.filter(`${ESC}[35;12;4M`, true)).toBe(`${ESC}[35;12;4M`);
  });

  it("leaves everything else alone", () => {
    const g = termInputGuard();
    for (const d of ["a", "ls -la\r", `${ESC}[A`, `${ESC}[1;5C`, `${ESC}[I`, `${ESC}[O`, `${ESC}[200~hi${ESC}[201~`, "NaN", `echo ${ESC}[<0;NaN;NaNm`, "é"]) {
      expect(g.filter(d, false)).toBe(d);
      expect(g.filter(d, true)).toBe(d);
    }
  });
});

describe("gridOk", () => {
  it("refuses a resize the pty cannot use", () => {
    expect(gridOk(80, 24)).toBe(true);
    for (const [c, r] of [[0, 0], [80, 0], [0, 24], [NaN, 24], [80, Infinity], [-1, 5], [1.5, 2]]) {
      expect(gridOk(c!, r!)).toBe(false);
    }
  });
});

describe("termShown", () => {
  it("is false for nothing, a detached node and a hidden one", () => {
    expect(termShown(null)).toBe(false);
    expect(termShown(undefined)).toBe(false);
    expect(termShown({ isConnected: false, getClientRects: () => [1] } as unknown as Element)).toBe(false);
    expect(termShown({ isConnected: true, getClientRects: () => [] } as unknown as Element)).toBe(false);
    expect(termShown({ isConnected: true, getClientRects: () => [1] } as unknown as Element)).toBe(true);
  });
});

describe("the panels route their input through the guard", () => {
  // No renderer in this project: a rule about source is asserted against source.
  for (const f of ["components/TerminalPanel.tsx", "components/ShellConsole.tsx", "components/PeekFile.tsx", "components/bench/BenchTerm.tsx"]) {
    it(`${f} filters onData`, async () => {
      const src = (await Bun.file(new URL(`../src/${f}`, import.meta.url)).text())
        .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(src).toContain("termInputGuard()");
      expect(src).toMatch(/\.filter\([^)]*termShown\(term\.element\)\)/);
    });
  }
});

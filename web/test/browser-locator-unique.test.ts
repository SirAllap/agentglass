/**
 * The match-count decision behind "a loc= must be unique", as pure functions:
 * none matches refuses, exactly one acts, several refuse with the count and the
 * first three candidates. Only a CSS selector on a read verb may take the first.
 */
import { describe, expect, test } from "bun:test";
import { MATCH_VERDICT, MANY_SAMPLES, manySentence } from "../src/lib/browserLocator.ts";

const verdict = new Function(`return ${MATCH_VERDICT}`)() as (n: number, lenientCss: boolean) => string;

describe("match verdict", () => {
  test("none refuses, one acts, several refuse", () => {
    expect(verdict(0, false)).toBe("none");
    expect(verdict(1, false)).toBe("one");
    expect(verdict(2, false)).toBe("many");
    expect(verdict(9, false)).toBe("many");
  });
  test("only lenient CSS may take the first of several", () => {
    expect(verdict(4, true)).toBe("one");
    expect(verdict(0, true)).toBe("none");
  });
});

describe("many sentence", () => {
  const s = ['e1 button "Save"', 'e2 button#b2 "Save"', 'e3 a "Save"', 'e4 div "Save"'];
  test("names the count and only the first 3 candidates", () => {
    const out = manySentence('text=Save', 4, s);
    expect(MANY_SAMPLES).toBe(3);
    expect(out).toContain("matched 4 elements");
    expect(out).toContain(s[0]!);
    expect(out).toContain(s[2]!);
    expect(out).not.toContain(s[3]!);
    expect(out).toContain("narrow text=Save to one");
  });
  test("no samples still says the count", () => {
    expect(manySentence("text=Save", 2)).toBe("selector matched 2 elements: narrow text=Save to one, or use one of the ids");
  });
});

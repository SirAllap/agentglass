/*
 * One comparable number instead of four kinds of token — #298.
 *
 * `input_tokens + output_tokens` is not a quantity. It adds a token that costs
 * five uncached input tokens to one that costs a tenth, and drops the two cache
 * classes entirely — so a session that reads a large context every turn, which
 * is most of them, looked enormous and was cheap. It was the expression behind
 * nine separate figures in this app, every one of them labelled "tokens".
 *
 * The rule below is written over the *tree* rather than over those nine sites,
 * because the failure mode is somebody adding a tenth. A number that is wrong
 * in a way nothing crashes on is the kind that survives, and this is the only
 * thing that would notice.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fmtEq, eqTitle, EQ_SUFFIX } from "../src/lib/format.ts";

const SRC = new URL("../src", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const rel = (p: string) => p.slice(SRC.length + 1);

describe("nothing adds up token classes by hand", () => {
  /**
   * `demo.ts` is exempt: it fabricates rows to *populate* those fields rather
   * than reading them, so the string appears there as a key list and an
   * assignment, never as a figure anybody is shown.
   */
  const EXEMPT = new Set(["lib/demo.ts"]);

  test("`input_tokens + output_tokens` appears nowhere it is rendered", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (EXEMPT.has(rel(f))) continue;
      const src = readFileSync(f, "utf8");
      // Both spellings, since `a.input_tokens + a.output_tokens` and the bare
      // property names are the two shapes this has taken.
      for (const [i, line] of src.split("\n").entries()) {
        if (/input_tokens\s*\+\s*[\w.?]*output_tokens/.test(line)) {
          // The honest fallback for a server too old to send the weighted
          // figure is exactly this sum, so it is allowed *behind* a `??`.
          if (/equiv_tokens\s*\?\?/.test(line)) continue;
          offenders.push(`${rel(f)}:${i + 1}  ${line.trim()}`);
        }
      }
    }
    expect(offenders, `a spend figure is summing token classes by hand:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("and the context measures are left alone, because they are not spend", () => {
    /*
     * The opposite mistake, and the reason the rule above names one specific
     * sum rather than banning arithmetic on these fields.
     *
     * A context meter counts what is *in the window* — prompt, cache read,
     * cache write — and excludes output, which has already left. Weighting it
     * by price would be nonsense: a 200k context is 200k of context whatever it
     * cost, and dividing it by a limit measured in real tokens would draw the
     * bar at a tenth of its true length.
     */
    const derive = readFileSync(join(SRC, "lib/derive.ts"), "utf8");
    expect(derive).toContain("e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens");
    const chat = readFileSync(join(SRC, "lib/chatStore.ts"), "utf8");
    expect(chat).toMatch(/contextTokens/);
  });
});

describe("what a weighted figure is called", () => {
  test("not `tok`, because it has stopped being a count of tokens", () => {
    expect(EQ_SUFFIX).not.toBe("tok");
    expect(fmtEq(4_200_000)).toBe(`4.20M ${EQ_SUFFIX}`);
  });

  test("and every site says it the same way", () => {
    // Eight call sites each wording this themselves is how three of them come
    // to word it wrongly. `tok` may not survive next to a weighted number.
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (/\}\s*tok</.test(line) || /\btok<\/span>/.test(line)) bad.push(`${rel(f)}:${i + 1}  ${line.trim()}`);
      }
    }
    expect(bad, `a weighted figure is still labelled "tok":\n${bad.join("\n")}`).toEqual([]);
  });

  test("the explanation names the multipliers, not just the idea", () => {
    // "weighted by price" tells somebody nothing they can check. The numbers
    // are what make the figure believable when it does not match their
    // intuition — which is the whole reason it exists.
    const t = eqTitle(1234);
    expect(t).toContain("1,234");
    expect(t).toMatch(/output token counts as 5/);
    expect(t).toMatch(/cache read 0\.1/);
  });

  test("and an unknown figure says so rather than reading as zero", () => {
    expect(eqTitle(null)).toContain("unknown");
    expect(fmtEq(null)).toContain("—");
  });
});

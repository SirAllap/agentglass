// Values pasted into JavaScript that is about to be evaluated in a page.
//
// The capture and audit scripts build snippets of JS as strings and hand them
// to `Runtime.evaluate`. Quoting those values with `JSON.stringify` is the
// obvious move and is not quite right, because JSON is not a subset of
// JavaScript: U+2028 and U+2029 survive it unescaped and were line terminators
// to a JS parser, so a value carrying one ends the string early and everything
// after it is parsed as code. `</script>` is the same hole in an HTML context.
//
// Neither is theoretical here. `AUDIT_REPO` comes from the environment, and the
// label fragments are chosen to match text the app rendered, so these values
// have already stopped being literals written in the script.
//
// It lives in the server suite because that is a place CI runs; the helper it
// tests is shared by the scripts under scripts/, the conflict drive and the
// browser panel, all three of which hand a built string to an engine.
import { describe, expect, test } from "bun:test";
import { jsLit } from "../../shared/jsLit.ts";

/** What a JS engine gets back when it evaluates the literal we produced. The
 *  real question is never "how is it spelled" but "does it round-trip". */
const evaluated = (v: unknown) => new Function(`return ${jsLit(v)}`)();

describe("jsLit", () => {
  test("round-trips ordinary selectors and labels", () => {
    for (const v of ['nav button', '.mb-screen.on .mb-row', 'Files', '\\', "it's", 'a "quoted" label']) {
      expect(evaluated(v)).toBe(v);
    }
  });

  test("round-trips the objects the key helper passes", () => {
    expect(evaluated({ ctrlKey: true })).toEqual({ ctrlKey: true });
  });

  test("escapes the line separators JSON leaves bare", () => {
    // The bug: `JSON.stringify` returns these raw, and a JS parser of the era
    // that matters here ends the string on them.
    expect(jsLit("a\u2028b")).not.toContain("\u2028");
    expect(jsLit("a\u2029b")).not.toContain("\u2029");
    expect(evaluated("a\u2028b")).toBe("a\u2028b");
    expect(evaluated("a\u2029b")).toBe("a\u2029b");
  });

  test("a value cannot close a script element", () => {
    const out = jsLit("</script><script>alert(1)</script>");
    expect(out).not.toContain("<");
    expect(evaluated("</script><script>alert(1)</script>")).toBe("</script><script>alert(1)</script>");
  });

  test("a quote in the value cannot end the literal early", () => {
    const hostile = '";window.pwned=1;"';
    expect(evaluated(hostile)).toBe(hostile);
  });
});

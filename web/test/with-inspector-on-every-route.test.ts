/**
 * `--with-inspector` has to survive whichever route produced the frame.
 *
 * `shot` has more than one way to a picture — the debugger's
 * `Page.captureScreenshot` first, the shell's off-screen render behind it, the
 * element's own `capturePage` last — and the join with the inspector lived on
 * the last branch alone. The debugger route is the one that answers almost
 * always, and it returned before ever reaching the join: measured, a full-size
 * page and the warning, while `inspect shot` on the same tab a second later
 * handed back the inspector. Nothing was wrong with the photograph; it was
 * never taken.
 *
 * Invisible to a type checker and to any test that drives one route, because
 * each branch is correct on its own. So the rule is counted rather than
 * exercised: every way out of `shot` that hands back a picture goes through the
 * same composite.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/lib/browserDrive.ts", import.meta.url), "utf8");

/** The `case "shot"` body, read by balancing braces so a comment added inside
 *  it cannot quietly change what is being read. */
function shotCase(): string {
  const at = SRC.indexOf('case "shot": {');
  expect(at, "the shot verb moved").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SRC.indexOf("{", at); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error("unbalanced");
}

/** Comments stripped: this is a rule about what the code does, not about what
 *  is written near it — and the prose here says "with inspector" a lot. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("every successful way out of shot goes through the inspector composite", () => {
  const body = code(shotCase());
  const successes = body.match(/return\s*\{\s*\n?\s*ok:\s*true/g) ?? [];
  const composed = body.match(/withInspectorHalf\(/g) ?? [];
  /* More than one route has always existed here, so a single success return
     means the branches were folded and this test needs rewriting rather than
     deleting. The definition is not counted: it names the helper without
     calling it. */
  expect(successes.length, "shot has fewer picture-returning branches than it used to").toBeGreaterThanOrEqual(2);
  expect(composed.length, "a branch of shot returns a picture without offering the inspector half")
    .toBe(successes.length);
});

test("the composite reports the half it could not take rather than dropping the flag", () => {
  const body = code(shotCase());
  /* A caller that asked for the inspector and got the page alone has to be
     able to tell — the CLI prints the warning off exactly this. Reporting it
     only on success would leave the failure indistinguishable from a shot
     nobody asked the inspector for. */
  expect(body).toContain("withInspector: false");
  expect(body).toContain("withInspector: true");
});

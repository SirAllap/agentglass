/*
 * Every class the understudy's fields name has to exist.
 *
 * `agx-input` was written on every input, textarea and select in that feature
 * and defined in no stylesheet at all. They rendered as the browser's bare
 * controls — no padding, no border of ours, and a select in the system's blue
 * — which is what "it feels like it has no room to breathe" looks like from the outside.
 *
 * Nothing failed, which is the point: a class name that matches no rule is
 * valid HTML, valid TypeScript, and invisible to a type checker. The only
 * thing that catches it is looking, and looking is what this replaces.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
/*
 * Both places this application defines CSS, because it has two.
 *
 * Most rules live in index.css. The scrollbar rules are a string constant in
 * DiffLines.tsx, injected at runtime — they need `::-webkit-scrollbar`, which
 * a stylesheet cannot express per-pane. A guard that knew only the first would
 * report `.agx-scroll` as undefined on all forty-nine of its uses, and the
 * fix somebody reaches for then is deleting the guard.
 */
const css = readFileSync(join(here, "..", "src", "index.css"), "utf8")
  + readFileSync(join(here, "..", "src", "components", "diff", "DiffLines.tsx"), "utf8");

/** Every `agx-…` class this feature's components ask for. */
function asked(): { file: string; cls: string }[] {
  const dir = join(here, "..", "src", "components", "understudy");
  const out: { file: string; cls: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".tsx")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/className="([^"]*)"/g)) {
      for (const cls of (m[1] ?? "").split(/\s+/)) {
        if (cls.startsWith("agx-")) out.push({ file: f, cls });
      }
    }
  }
  return out;
}

describe("a class that is asked for is a class that exists", () => {
  test("every agx- class the understudy names is defined in the stylesheet", () => {
    const missing = [...new Set(asked()
      .filter(({ cls }) => !css.includes(`.${cls}`))
      .map(({ file, cls }) => `${file}: .${cls}`))].sort();
    expect(missing, "styled with a rule nobody wrote").toEqual([]);
  });

  test("and the fields have padding, which is the thing that was missing", () => {
    const rule = css.slice(css.indexOf(".agx-input {"), css.indexOf("}", css.indexOf(".agx-input {")));
    expect(rule).toContain("padding");
    expect(rule).toContain("border");
  });

  test("a select does not fall back to the platform's own colours", () => {
    // The field is ours; the popup belongs to the platform. On a dark theme an
    // unstyled option list is a white box in the middle of the panel.
    expect(css).toContain("select.agx-input option");
  });
});

describe("a control on this screen governs something", () => {
  /*
   * TWELVE OF THEM DID NOT, and they had the best position on the panel.
   *
   * Initiative (off · watching · asked · offering · queued · undo · acting)
   * and Reach (read · draft · its own worktree · shared branch · outward)
   * described the predictor's ladder — how far it could go alone, how far its
   * reversible acts could reach. That machinery was removed after measuring
   * that its tables had never held a row, and the dials stayed.
   *
   * A dial wired to nothing is worse than no dial: somebody sets it before
   * walking away and believes they have bounded the thing.
   */
  const panel = readFileSync(join(here, "..", "src", "components", "understudy", "UnderstudyPanel.tsx"), "utf8");
  const code = panel.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

  test("the panel no longer offers the ladder's dials", () => {
    expect(code).not.toContain("PostureInline");
    expect(code).not.toContain("/understudy/stance");
    expect(code).not.toContain("/understudy/reach");
  });

  test("what it does show is what reaches the loop", () => {
    /*
     * Counted in the code the loop runs, not asserted from memory:
     * `understudyEnabled`, `isHalted`, `openProjectName` and `proposeScope`
     * have callers there; stance and reach have none. The first two are the
     * state word in this header; the last two live on the Work tab beside the
     * button that starts a run, which is where a limit belongs.
     */
    const work = readFileSync(join(here, "..", "src", "components", "understudy", "Work.tsx"), "utf8");
    expect(work).toContain("/understudy/propose-scope");
    expect(work).toContain("/understudy/open-project");
    expect(code).toContain("frame.halted");
  });
});

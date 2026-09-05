/*
 * Why code blocks in a review were grey, and why "sometimes".
 *
 * Reported twice, with screenshots: the same comment flat grey in one session and
 * coloured in the next. The first guess was a cached failure (a rejected dynamic
 * import — real, fixed, and NOT this), which is why this file exists: the second
 * time it was measured against the actual library instead of reasoned about.
 *
 * The measurement is the first test below. Shiki refuses to tokenise with a theme
 * that has not been registered — `ShikiError: Theme 'github-dark' not found, you
 * may need to load it first` — and the pull-request panel had its own code-block
 * renderer that passed `shikiTheme()` straight in without ever loading it. So it
 * threw, was caught, and rendered plain text… unless some OTHER surface had
 * already loaded that theme in the same session. Open the diff first and a review
 * was coloured; go straight to the review and it was not. Restarting the app was
 * never the fix — what changed was which surface was opened first.
 *
 * These run against the real shiki with its JavaScript regex engine (the one the
 * app uses, because a packaged webview may have no wasm-unsafe-eval), so they
 * prove the mechanism rather than describing it.
 */
import { describe, expect, it } from "bun:test";
import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { ensureLanguage, ensureTheme } from "../src/lib/highlight.ts";

const fresh = () => createHighlighter({ themes: [], langs: [], engine: createJavaScriptRegexEngine() });

describe("tokenising with a theme nobody registered", () => {
  it("throws — this is the whole bug", async () => {
    const hl = await fresh();
    await hl.loadLanguage("python" as never);
    expect(() => hl.codeToHtml("x = 1", { lang: "python" as never, theme: "github-dark" }))
      .toThrow(/not found/i);
  });

  it("and works the moment the theme is really there", async () => {
    const hl = await fresh();
    await hl.loadLanguage("python" as never);
    await hl.loadTheme("github-dark" as never);
    const { tokens } = hl.codeToTokens("x = 1", { lang: "python" as never, theme: "github-dark" });
    expect(tokens[0]!.length).toBeGreaterThan(1);
  });
});

describe("ensureTheme is the way to ask", () => {
  it("returns a name the highlighter has actually got", async () => {
    const hl = await fresh();
    const { name, failed } = await ensureTheme(hl, "github-dark", false);
    expect(failed).toBeUndefined();
    expect(name).toBe("github-dark");
    expect(hl.getLoadedThemes()).toContain("github-dark");
    await ensureLanguage(hl, "python");
    const { tokens } = hl.codeToTokens("def f(x):\n    return x", { lang: "python" as never, theme: name! });
    expect(tokens.length).toBe(2);
    // Coloured, not one grey run: the failure this is all about renders as a
    // single token with no colour on it.
    expect(tokens[0]!.length).toBeGreaterThan(1);
    expect(tokens[0]!.some((t) => !!t.color)).toBe(true);
  });

  // A theme that does not exist must not be reported as the one you asked for:
  // recording a name the highlighter has not got is how this bug gets rebuilt.
  it("falls back within the same light/dark family and says which id it could not honour", async () => {
    const hl = await fresh();
    const { name, failed } = await ensureTheme(hl, "no-such-theme-anywhere", false);
    expect(failed).toBe("no-such-theme-anywhere");
    expect(name).toBe("github-dark");
    expect(hl.getLoadedThemes()).toContain("github-dark");
  });
});

// The trap the two tests above walked into, and the reason the caches are keyed by
// highlighter: a note about what one object has loaded, kept in a variable that
// outlives it, tells the NEXT object it is already done.
describe("two highlighters do not share each other's loads", () => {
  it("each one is really given the theme it was asked for", async () => {
    const a = await fresh();
    const b = await fresh();
    expect((await ensureTheme(a, "github-dark", false)).name).toBe("github-dark");
    expect((await ensureTheme(b, "github-dark", false)).name).toBe("github-dark");
    expect(a.getLoadedThemes()).toContain("github-dark");
    expect(b.getLoadedThemes()).toContain("github-dark");
    await ensureLanguage(b, "python");
    expect(b.getLoadedLanguages()).toContain("python");
    // Which is what a retry after a failed build now does — see onceOk. Before
    // this, the second highlighter was told the work was done and threw on the
    // first block it was asked to colour.
    expect(() => b.codeToTokens("x = 1", { lang: "python" as never, theme: "github-dark" })).not.toThrow();
  });
});

describe("the rule, in the source", () => {
  it("nothing tokenises with a theme it has not ensured", async () => {
    // Deliberately a text rule as well as the behavioural tests above: the two
    // faults this file is about were both "a second implementation that skipped
    // the step", and the step is easy to skip again in a third one.
    const files = ["../src/components/PrPanel.tsx", "../src/lib/mdCode.tsx", "../src/components/diff/DiffLines.tsx"];
    for (const rel of files) {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      const calls = src.match(/codeTo(?:Html|Tokens)\([^)]*\)/g) ?? [];
      for (const call of calls) {
        expect(call).not.toContain("shikiTheme()");
      }
    }
  });

  it("and a fenced block with no language is still offered a guess", async () => {
    // The other half of what the pull-request panel's own renderer got wrong: it
    // returned early on a bare fence, and a review pasted out of an editor very
    // often has one.
    const src = await Bun.file(new URL("../src/lib/mdCode.tsx", import.meta.url)).text();
    expect(src).toContain("guessLang(code)");
  });
});

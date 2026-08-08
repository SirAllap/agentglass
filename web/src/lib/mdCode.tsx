/*
 * A fenced code block, coloured.
 *
 * The diff has had real syntax highlighting for a long time — shiki, with the
 * theme the user picked in the diff's own picker — while every code block in a
 * ClickUp card, an agent's message or a pull-request body was rendered as one
 * flat grey mass. Same app, same code, two different worlds; and the grey one
 * is where a bug report's evidence lives.
 *
 * So this is the diff's highlighter, pointed at markdown. Nothing new is
 * installed and no second palette is invented: `THEME_KEY` is the same
 * preference the diff reads, "auto" resolves through the same luminance check,
 * and the bold-keywords switch is the same one.
 *
 * Everything is lazy and every failure is the old behaviour. Shiki's core, its
 * grammars and its themes are separate dynamic chunks (see highlight.ts), so a
 * card with no code costs nothing; and until the chunk lands — or if it never
 * does, or the grammar is one shiki does not have — what is on screen is the
 * plain monospace block that was there before. Colour is an improvement on
 * legible text, never a precondition for it.
 */
import { useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki";
import { getHighlighter, ensureLanguage, ensureTheme, shikiTheme, langFromTag, guessLang } from "./highlight.ts";
import { THEME_KEY, BOLD_KEY } from "./diffHighlight.ts";

const pref = (key: string, fallback: string): string => {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
};

/** The app's theme lives in CSS custom properties on <html>, and "auto" is read
 *  off `--bg`. A theme switch therefore has to re-tokenize, or a block stays in
 *  the palette of the theme it happened to be rendered under. */
function useThemeTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const o = new MutationObserver(() => setN((x) => x + 1));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => o.disconnect();
  }, []);
  return n;
}

export function CodeBlock({ code, tag, className, style }: {
  code: string;
  /** The word after the fence, if there was one. */
  tag?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const lang = useMemo(() => langFromTag(tag) ?? guessLang(code), [tag, code]);
  const tick = useThemeTick();
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    if (!lang) { setLines(null); return; }
    let alive = true;
    void (async () => {
      const hl = await getHighlighter();
      await ensureLanguage(hl, lang);
      const chosen = pref(THEME_KEY, "auto");
      const { name } = await ensureTheme(hl, chosen === "auto" ? shikiTheme() : chosen, pref(BOLD_KEY, "1") !== "0");
      if (!name || !alive) return;
      setLines(hl.codeToTokens(code, { lang: lang as never, theme: name }).tokens);
    })().catch(() => { /* plain text is the fallback, and it is already on screen */ });
    return () => { alive = false; };
  }, [code, lang, tick]);

  return (
    <pre className={className} style={style}>
      <code>
        {lines
          ? lines.map((toks, i) => (
              <span key={i}>
                {toks.map((t, j) => (
                  <span key={j} style={{
                    color: t.color,
                    // 1 is italic, 2 bold, 4 underline in shiki's FontStyle enum.
                    fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined,
                    fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined,
                  }}>{t.content}</span>
                ))}
                {i < lines.length - 1 ? "\n" : null}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}

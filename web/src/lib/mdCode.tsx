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

/** How many times a failed load is retried, and how long after each. Short
 *  enough that a server coming back up is caught while somebody is still looking
 *  at the comment; few enough that a grammar shiki simply does not have is asked
 *  for three times and then left alone. */
const RETRIES = 2;
const RETRY_MS = [400, 1500];

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

  /*
   * Colouring is attempted more than once, and that is a fix rather than a
   * belt-and-braces.
   *
   * Every piece of this is fetched at the moment a block first needs it — shiki's
   * core, the grammar, the theme — from the local server. So the ordinary way to
   * lose colour is a load that failed once: the window outlived a server restart
   * (which is what installing a build does), or a chunk request lost a race with
   * the first paint. The block then sat grey until the app was restarted, because
   * nothing ever asked again: this effect had run, caught, and had no reason to
   * fire a second time.
   *
   * Reported that way, with a screenshot of a comment in flat grey and the same
   * comment coloured after a restart. The other half of the fix is in
   * highlight.ts, which no longer remembers a failure at all; this half is what
   * gets the block that was on screen when it happened.
   *
   * Twice, then quiet. A permanent failure — a grammar shiki does not have, a
   * policy that blocks the chunk — is a thing to stop asking about, not something
   * to retry behind somebody's back for the life of the window.
   */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!lang) { setLines(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const hl = await getHighlighter();
      await ensureLanguage(hl, lang);
      const chosen = pref(THEME_KEY, "auto");
      const { name } = await ensureTheme(hl, chosen === "auto" ? shikiTheme() : chosen, pref(BOLD_KEY, "1") !== "0");
      if (!name) throw new Error("no theme could be registered");
      if (!alive) return;
      setLines(hl.codeToTokens(code, { lang: lang as never, theme: name }).tokens);
    })().catch(() => {
      /* Plain text is on screen and stays on screen — colour is an improvement on
         legible text, never a precondition for it. */
      if (!alive || attempt >= RETRIES) return;
      timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS[attempt] ?? 1200);
    });
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // `attempt` is a dependency on purpose: bumping it is what runs this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, lang, tick, attempt]);
  /* Back to nothing when the code or the theme changes, so a block that has
     given up on one language tries again for the next. */
  useEffect(() => { setAttempt(0); }, [code, lang, tick]);

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

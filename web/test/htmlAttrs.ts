/*
 * What a browser would BUILD out of a string — elements and attributes — asked
 * of a real HTML parser rather than of a regular expression.
 *
 * This exists because the difference is not academic. A security audit proved
 * arbitrary script execution in `renderInline`: the href was interpolated raw,
 * a URL may legally contain a double quote, and a crafted markdown link closed
 * the attribute and named its own. The output string LOOKED fine — it was full
 * of `&quot;` and `https://` and nothing that reads as an attack — and real
 * Chrome built an `onmouseover` out of it and ran the handler. A guard written
 * as `expect(html).not.toMatch(/…/)` is a guess about how a parser tokenises;
 * this is the parser's own answer, and it is the only question that means
 * anything when the string is on its way to `dangerouslySetInnerHTML`.
 *
 * Lifted out of `pr-body-xss.test.ts`, which had it first, so that every suite
 * making a "this stays inert" claim asks it the same way.
 *
 * ONE limitation, measured, and it decides where each helper may be used:
 * `HTMLRewriter` hands back the SOURCE TEXT of an attribute value, not the
 * value the browser would end up with — `href="https://e.example/&quot;x"`
 * comes back as `https://e.example/&quot;x`, references intact. Which elements
 * and attributes EXIST is the parser's answer and is authoritative; anything
 * about what a value MEANS has to decode first, which is what `urlScheme` is
 * for.
 */

export type BuiltAttr = { tag: string; name: string; value: string };
export interface Built {
  /** Every element the parser built, in document order, lowercased. */
  tags: string[];
  /** Every attribute of every one of them. */
  attrs: BuiltAttr[];
}

/** Everything a browser would build from this string. */
export async function domOf(html: string): Promise<Built> {
  const tags: string[] = [];
  const attrs: BuiltAttr[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        tags.push(el.tagName);
        for (const [name, value] of el.attributes) attrs.push({ tag: el.tagName, name, value });
      },
    })
    .transform(new Response(html))
    .text();
  return { tags, attrs };
}

/** Every attribute of every element the browser would build from this string. */
export async function attributesOf(html: string): Promise<BuiltAttr[]> {
  return (await domOf(html)).attrs;
}

/** The handful of character references that can hide a scheme. Deliberately
 *  generous — see `urlScheme`. */
function decodeRefs(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (m, hex: string) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return m; } })
    .replace(/&#(\d+);?/g, (m, dec: string) => { try { return String.fromCodePoint(Number(dec)); } catch { return m; } })
    .replace(/&colon;/gi, ":").replace(/&Tab;/gi, "\t").replace(/&NewLine;/gi, "\n")
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}

/**
 * The scheme a browser would actually navigate — `"javascript"`, `"https"` —
 * lowercased and without its colon, or null when the value names no scheme.
 *
 * Three things happen to a URL before anything looks at its scheme, and every
 * one of them has been used to smuggle a script URL past a check that read the
 * attribute as written: character references are decoded, TAB/CR/LF are removed
 * wherever they appear, and leading C0 control characters are ignored. So
 * `&#106;avascript:`, `java&Tab;script:` and the same word behind a control
 * character are all one link, and a check on the written text sees three
 * different strings.
 *
 * It decodes MORE eagerly than a browser does — references without their
 * closing semicolon, in any position. That is the direction to be wrong in: it
 * can only ever call something a script URL that a browser would treat as
 * text, never the other way round.
 */
export function urlScheme(value: string): string | null {
  const v = decodeRefs(value).replace(/[\t\r\n]/g, "").replace(/^[\u0000-\u0020]+/, "");
  return v.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? null;
}

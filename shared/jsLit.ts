/**
 * A value as a JavaScript literal, safe to paste into source that is about to
 * be evaluated somewhere else.
 *
 * Three places in this repository build a snippet of JavaScript as a string and
 * hand it to an engine: the capture and audit scripts through CDP
 * `Runtime.evaluate`, the conflict drive the same way, and the browser panel
 * through the webview's `executeJavaScript`. The values pasted into them are
 * selectors, key names, label fragments and typed text.
 *
 * `JSON.stringify` alone is the obvious way to quote those and it is not quite
 * enough, because JSON is not a subset of JavaScript. U+2028 and U+2029 survive
 * it unescaped and were line terminators to a JS parser, which ends the string
 * mid-expression and leaves whatever follows as code; the same value reaching an
 * inline `<script>` would end it at a literal `</script>`.
 *
 * Neither is exotic once a value stops being written in the file that uses it.
 * `AUDIT_REPO` is read from the environment, label fragments are chosen to match
 * text the app rendered, and the panel's selectors arrive over the wire from an
 * agent — the server's own gate refuses a newline, a carriage return and a NUL
 * in a selector and lets U+2028 through, so that shape does reach a literal.
 *
 * So the quoting is done once, correctly, in the one place all of it passes
 * through, instead of being a property of who happened to call it. It lives in
 * `shared/` rather than beside any one caller because the callers are in
 * `scripts/`, `web/` and `server/`, and a second copy is where two of them
 * drift apart.
 *
 * It does not change the string the engine ends up with — `\x3c` is `<` to a JS
 * parser, and `\u2028` is U+2028. What changes is that neither can end anything
 * early on the way there.
 *
 * Note the escapes in the two replacements below: a bare U+2028 in a regular
 * expression literal is a line terminator in SOURCE, and the file does not
 * parse. That is the same property this function exists to handle, seen from
 * the other side.
 */
export const jsLit = (v: unknown): string =>
  JSON.stringify(v)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // `\x3c` is the same character to a JS parser and cannot close a script
    // element, so a snippet stays inert wherever it is eventually placed.
    .replace(/</g, "\\x3c");

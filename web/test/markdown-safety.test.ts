// The link-safety rule from the markdown renderer, pinned here.
//
// Message text is untrusted — a model or a tool can emit anything — and the
// renderer turns [label](href) into a real anchor. The renderer itself builds
// React elements (no dangerouslySetInnerHTML), so markup injection isn't
// possible, but an href is still attacker-controlled: `javascript:` and `data:`
// URLs execute on click.
//
// Kept as a plain predicate test rather than a DOM render: the rule is a pure
// function, and rendering a component to assert one attribute would test React.
//
// It lived in the server suite, where the renderer it describes could not be
// imported at all. That is what made it a copy.
//
// It used to restate the rule as its own regexp, with a comment saying it
// mirrored the renderer. That is a test of a copy: the renderer could change
// its mind about a scheme and this would keep passing on the old answer. It now
// imports the very function the renderer calls, so there is one rule with one
// test — and the renderer no longer pattern-matches the URL at all, it asks the
// URL parser, which is the stricter reader of the two.
import { describe, expect, test } from "bun:test";
import { externalUrl } from "../src/lib/externalUrl.ts";

/** The renderer's own check: only an absolute http(s) URL becomes a link. */
const isSafeHref = (href: string) => externalUrl(href) !== undefined;

describe("markdown link hrefs", () => {
  test("allows ordinary web links", () => {
    expect(isSafeHref("https://github.com/SirAllap/agentglass")).toBe(true);
    expect(isSafeHref("http://localhost:4000/stats")).toBe(true);
    expect(isSafeHref("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  test("rejects script-bearing schemes", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeHref("vbscript:msgbox")).toBe(false);
  });

  test("rejects schemes that reach the local machine", () => {
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("app://localhost/x")).toBe(false);
  });

  test("rejects a scheme-relative or relative href", () => {
    // Not dangerous, but it isn't a link we can vouch for either — rendered as
    // plain text instead.
    expect(isSafeHref("//evil.example.com")).toBe(false);
    expect(isSafeHref("/admin")).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });

  test("a leading-whitespace trick doesn't slip through", () => {
    expect(isSafeHref(" javascript:alert(1)")).toBe(false);
    expect(isSafeHref("\tjavascript:alert(1)")).toBe(false);
    // Whitespace inside the scheme is the sharper version of the same trick,
    // and it is why this is parsed rather than matched: a pattern anchored on
    // `https?://` reads this as "not a link" and moves on, while a browser
    // handed the raw string strips the tab and runs it.
    expect(isSafeHref("java\tscript:alert(1)")).toBe(false);
    // Surrounding whitespace on an otherwise ordinary link is not a trick, and
    // the parser says so: it trims, then judges the scheme. The regexp this
    // replaced called it unsafe, which cost a real link for no safety.
    expect(isSafeHref("\thttps://ok.example.com")).toBe(true);
  });
});

// Mirrors the table detection in web/src/lib/markdown.tsx. A table is only a
// table when a |---| separator follows the header — without that guard, any
// prose line containing pipes (a shell pipeline, a TypeScript union) would be
// silently eaten and re-rendered as a one-row table.
const isTableStart = (line: string, next: string) =>
  /^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(next);

describe("markdown table detection", () => {
  test("recognises a table with its separator", () => {
    expect(isTableStart("| a | b |", "|---|---|")).toBe(true);
    expect(isTableStart("| a | b |", "| :--- | ---: |")).toBe(true);
    expect(isTableStart("| a | b |", "|:--:|:--:|")).toBe(true);
  });

  test("a pipe in prose is not a table", () => {
    expect(isTableStart("run `ps aux | grep bun` first", "and then look")).toBe(false);
    expect(isTableStart("| a | b |", "just more prose")).toBe(false);
    expect(isTableStart("type T = | A | B |", "| not | a separator |")).toBe(false);
  });

  test("a table cannot begin at its separator", () => {
    // The separator is never the header: "|---|" followed by data is a
    // malformed table, and treating it as a start would render the dashes as
    // column names.
    expect(isTableStart("|---|---|", "| a | b |")).toBe(false);
    expect(isTableStart("plain text", "|---|---|")).toBe(false);
  });
});

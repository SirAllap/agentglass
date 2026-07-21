// The link-safety rule from the markdown renderer, pinned here.
//
// Message text is untrusted — a model or a tool can emit anything — and the
// renderer turns [label](href) into a real anchor. The renderer itself builds
// React elements (no dangerouslySetInnerHTML), so markup injection isn't
// possible, but an href is still attacker-controlled: `javascript:` and `data:`
// URLs execute on click.
//
// Kept as a plain predicate test rather than a DOM render because the server
// suite has no React test environment; the renderer imports this same rule.
import { describe, expect, test } from "bun:test";

/** Mirrors the check in web/src/lib/markdown.tsx — only http(s) becomes a link. */
const isSafeHref = (href: string) => /^https?:\/\//i.test(href);

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
    expect(isSafeHref("\thttps://ok.example.com")).toBe(false);
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

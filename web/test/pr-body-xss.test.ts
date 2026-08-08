/*
 * The href is an attribute, and an attribute is a place where text becomes
 * syntax.
 *
 * A security audit proved arbitrary script execution here: `renderInline`
 * interpolated the href raw, a URL may legally contain a double quote, so a
 * crafted markdown link closed the attribute and named its own. The audit
 * loaded the output as `innerHTML` in real Chrome, dispatched a `mouseover`,
 * and watched `globalThis.PWN` change. Every body this parser reads is written
 * by anyone who can comment on the pull request.
 *
 * These do not eyeball the string. They run it through a real HTML parser and
 * ask what ELEMENTS and ATTRIBUTES came out — the same question the browser
 * asks, and the only one that can answer "is this inert".
 */
import { describe, expect, test } from "bun:test";
import { parseBody } from "../src/lib/prBody.ts";
import { attributesOf } from "./htmlAttrs.ts";

/* The parser-backed helper, shared with the allowlist file. It was copied here
   and there, which is the shape that produced three of today's findings: a fact
   with two producers has no owner. */
const htmlOf = (body: string) =>
  parseBody(body).map((b) => ("html" in b ? b.html : "")).join("\n");

describe("nothing a comment can write becomes an attribute", () => {
  const payloads: [string, string][] = [
    ["the audit's own, which ran in Chrome",
      "See [hover me](https://e.com/(https://x/onmouseover=globalThis.PWN=31337+) for details."],
    ["a quote straight in the href",
      '[click](https://e.com/" onmouseover="alert(1))'],
    ["a quote in a bare URL",
      'look at https://e.com/a" onload="alert(1) here'],
    ["a nested link inside a link's text",
      "[outer [inner](https://b.example/x)](https://a.example/y)"],
    ["an entity that decodes to a quote",
      "[t](https://e.com/&quot;&#32;onmouseover=alert(1))"],
    ["a bare URL immediately after a markdown link",
      "[a](https://one.example/x)https://two.example/y"],
  ];

  for (const [name, body] of payloads) {
    test(name, async () => {
      const attrs = await attributesOf(htmlOf(body));
      const bad = attrs.filter((a) => /^on/i.test(a.name));
      expect(bad).toEqual([]);
      // And nothing outside the two attributes a link is allowed to carry.
      const unexpected = attrs.filter((a) => !["href", "target", "rel", "class", "data-on", "src", "alt", "loading", "referrerpolicy", "colspan", "align", "style", "title", "aria-label"].includes(a.name.toLowerCase()));
      expect(unexpected).toEqual([]);
    });
  }

  test("a link still works, and still points where it said", async () => {
    const attrs = await attributesOf(htmlOf("[docs](https://acme.example/guide)"));
    expect(attrs.find((a) => a.name === "href")?.value).toBe("https://acme.example/guide");
    expect(attrs.find((a) => a.name === "rel")?.value).toContain("noreferrer");
  });

  test("javascript: is still not a link at all", async () => {
    const html = htmlOf("[t](javascript:alert(1)) and vbscript:alert(2) and //evil.example/x");
    expect(html).not.toContain("<a ");
  });
});

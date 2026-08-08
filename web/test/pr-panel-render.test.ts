/*
 * Tests that actually execute the panel.
 *
 * A read-only audit proved by mutation that the 26 tests guarding this
 * component never ran it: it made `PrView` return null — the whole Pull
 * requests view drawing nothing at all — and the suite stayed at 1802 pass,
 * because every one of those assertions reads `PrPanel.tsx` as TEXT and checks
 * for substrings. A substring is still there when the code around it is dead.
 *
 * The reason nobody had written a render test is that importing the component
 * threw: `api.ts` read `location` at module scope and there is no DOM under
 * `bun test`. That is one guard, and with it the component imports in 162ms.
 *
 * There is no DOM here either, so effects do not run and what these see is the
 * first paint. That is exactly the mutation class above — a component that
 * renders nothing, or renders the wrong thing before its data lands — and it is
 * what no test in this file's neighbourhood could see.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrView, Md, MD_CSS } from "../src/components/PrPanel.tsx";

const draw = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("the panel draws something", () => {
  test("PrView is not empty on its first paint", () => {
    // The audit's own mutation was `return null` here. This is the assertion
    // that would have caught it.
    const html = draw(React.createElement(PrView, { active: true }));
    expect(html.length).toBeGreaterThan(200);
    expect(html).toContain("<");
  });

  test("and it mounts its own stylesheet, which is where the prose gets its shape", () => {
    /*
     * `MD_CSS` is a string constant, so asserting the string proves nothing
     * about whether it reaches the page — the audit deleted it from the
     * `<style>` element and every heading, table and bullet in every pull
     * request body lost its typography, with the suite green.
     */
    const html = draw(React.createElement(PrView, { active: true }));
    expect(html).toContain(".agx-md ul{list-style:disc}");
  });

  test("the bullets win the cascade, which is the whole of that bug", () => {
    /*
     * Tailwind's preflight sets `list-style: none` on every ul. The panel's
     * sheet used to set the indent and colour the marker and never put the
     * marker back, so a review's findings arrived as text nudged right. Being
     * present is not enough — the LAST declaration wins, so that is what is
     * asserted.
     */
    const decls = [...MD_CSS.matchAll(/\.agx-md ul\s*\{[^}]*list-style:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(decls.length).toBeGreaterThan(0);
    expect(decls[decls.length - 1]).toBe("disc");
    expect(MD_CSS).not.toContain(".agx-md ul,.agx-md ol{list-style:none}");
  });
});

describe("a pull request body, as the panel draws it", () => {
  const html = (body: string) => draw(React.createElement(Md, { body }));

  test("a list is a list, with real items", () => {
    const out = html("- first finding\n- second finding\n");
    expect(out).toContain("<ul");
    expect((out.match(/<li/g) ?? []).length).toBe(2);
    expect(out).toContain("first finding");
  });

  test("a bullet under a numbered step is a real child list, and keeps its own marker", () => {
    // Flat, every `<li>` of the `<ol>` took a number: two sub-bullets became
    // steps 3 and 4 and pushed the real step 3 to 5.
    const out = html("1. one\n2. two\n   - note\n   - other\n3. three\n");
    expect(out).toContain("<ol");
    expect(out).toContain("<ul");
    // The nested list lives INSIDE an item, not beside it.
    expect(out).toMatch(/<li>[^]*?<ul>[^]*?note/);
  });

  test("a numbered list with blank lines between the steps is one list", () => {
    const out = html("1. first\n\n2. second\n\n3. third\n");
    expect((out.match(/<ol/g) ?? []).length).toBe(1);
    expect((out.match(/<li/g) ?? []).length).toBe(3);
  });

  test("a single newline is a break, the way GitHub renders a comment", () => {
    expect(html("Review Summary\n1 blocking. 2 minor.")).toContain("<br>");
  });

  test("the allowlisted inline tags are drawn and everything else is text", () => {
    const out = html("<i>report only</i> and <img src=x onerror=alert(1)>");
    expect(out).toContain("<i>report only</i>");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
  });

  test("an href cannot end its own attribute", async () => {
    // The stored-XSS blocker, asked of the component rather than the parser.
    const out = html("See [hover](https://e.com/(https://x/onmouseover=alert(1)) here.");
    const attrs: string[] = [];
    await new HTMLRewriter()
      .on("*", { element(el) { for (const [n] of el.attributes) attrs.push(n); } })
      .transform(new Response(out)).text();
    expect(attrs.filter((a) => /^on/i.test(a))).toEqual([]);
  });
});

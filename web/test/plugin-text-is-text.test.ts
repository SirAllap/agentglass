/*
 * A plugin's words are somebody else's string.
 *
 * A catalogue entry and an installed manifest both carry a title, a publisher
 * and a description that a stranger wrote, and the app draws all three. React
 * escapes a child, so the rule holds today by default — and it holds only
 * until somebody wants the description to render its own markdown and reaches
 * for `dangerouslySetInnerHTML`. The pull request body took exactly that road
 * once, and the hole was where the output was built, not in the allow-list.
 *
 * So: the market row is drawn for real with markup in every field and must
 * come out as text, and every screen that draws a manifest is held to having
 * no raw-HTML sink at all. The site's copy of the same list has its own lock
 * in server/test/landing-plugins-page.test.ts.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { Offer } from "../src/components/plugins/Market.tsx";
import type { Catalogue } from "../../shared/types.ts";

type Entry = Catalogue["plugins"][number];

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;

describe("a plugin's words, drawn", () => {
  test("a market row puts markup in as text", () => {
    const entry: Entry = {
      id: "clock",
      title: `Clock ${HOSTILE}`,
      publisher: `acme ${HOSTILE}`,
      description: `Puts the time in the top bar. ${HOSTILE}`,
      categories: [],
      source: { kind: "git", url: "https://github.com/acme/clock", ref: null },
    };
    const html = renderToStaticMarkup(React.createElement(Offer, { entry, owner: "acme", onInstalled: () => {} }));
    expect(html).toContain("Puts the time in the top bar.");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  test("no screen that draws a manifest has a raw-HTML sink", () => {
    const dir = new URL("../src/components/plugins/", import.meta.url);
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => new URL(f, dir)),
      new URL("../src/components/PluginsPane.tsx", import.meta.url),
    ];
    // A count, so a folder that moved does not pass by checking nothing.
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const sink of ["dangerouslySetInnerHTML", "innerHTML", "insertAdjacentHTML", "outerHTML"]) {
        expect(src.includes(sink), `${f.pathname.split("/").pop()} uses ${sink}`).toBe(false);
      }
    }
  });
});

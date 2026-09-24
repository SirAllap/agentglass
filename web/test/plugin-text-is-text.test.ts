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
    const html = renderToStaticMarkup(React.createElement(Offer, { entry, owner: "acme", onInstalled: () => {}, mode: "install" }));
    expect(html).toContain("Puts the time in the top bar.");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  // A text scan of named files, not of what they import: a sink in a module
  // outside this list passes. The markdown renderer is on it because a plugin's
  // tree hands it the plugin's own text; anything else a screen here starts
  // rendering plugin text through has to be added by hand.
  test("no screen that draws a manifest has a raw-HTML sink", () => {
    const dir = new URL("../src/components/plugins/", import.meta.url);
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => new URL(f, dir)),
      new URL("../src/components/PluginsPane.tsx", import.meta.url),
      new URL("../src/lib/markdown.tsx", import.meta.url),
    ];
    // A count, so a folder that moved does not pass by checking nothing.
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      // Comment lines out: markdown.tsx names the sink it refuses to use.
      const src = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .join("\n");
      for (const sink of ["dangerouslySetInnerHTML", "innerHTML", "insertAdjacentHTML", "outerHTML"]) {
        expect(src.includes(sink), `${f.pathname.split("/").pop()} uses ${sink}`).toBe(false);
      }
    }
  });
});

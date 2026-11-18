/* A plugin's link and picture, drawn with hostile values: no img for svg or javascript:, no anchor for http:. */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Offer } from "../src/components/plugins/Market.tsx";
import { PluginPreview } from "../src/components/plugins/PluginPreview.tsx";

const draw = (src: string) => renderToStaticMarkup(React.createElement(PluginPreview, { src, name: "Orbit", tint: "red", children: "tile" }));

describe("a plugin's picture", () => {
  test.each(["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "http://acme.test/p.png"])("%p is a tile, never an img", (src) => {
    const html = draw(src);
    expect(html).not.toContain("<img");
    expect(html).toContain('data-preview="tile"');
  });
  test("https and a png data: image are drawn", () => {
    expect(draw("https://acme.test/p.png")).toContain("<img");
    expect(draw("data:image/png;base64,iVBORw0KGgo=")).toContain("<img");
  });
});

describe("a plugin's repository link", () => {
  const offer = (url: string) => renderToStaticMarkup(React.createElement(Offer, {
    entry: { id: "orbit-clock", description: "d", categories: [], source: { kind: "git", url, ref: "0123456789abcdef0123456789abcdef01234567" } },
    owner: "acme", onInstalled: () => {}, mode: "install",
  }));
  test("javascript: and http: make no anchor", () => {
    for (const url of ["javascript:alert(1)", "http://acme.test/orbit-clock"]) expect(offer(url)).not.toMatch(/href="(javascript|http):/);
  });
});

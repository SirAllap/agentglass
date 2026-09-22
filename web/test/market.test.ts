/*
 * The market screen: one list, and only what you can still take.
 *
 * Both rules here were the screen's two complaints. A plugin already on the
 * machine was offered again, on a shelf of one, so the page read as if
 * nothing had been installed; and the list itself could be removed — on the
 * only list there is — leaving a plugins page whose whole content was a box
 * asking for somebody else's URL.
 *
 * The search rule is asserted against the function, the rest against the
 * source, because there is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Offer, WhatIsCloned, matching, tintOf, types } from "../src/components/plugins/Market.tsx";
import type { Catalogue } from "../../shared/types.ts";
import { domOf } from "./htmlAttrs.ts";

const market = await Bun.file(new URL("../src/components/plugins/Market.tsx", import.meta.url)).text();
const pane = await Bun.file(new URL("../src/components/PluginsPane.tsx", import.meta.url)).text();
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();

/** Comments out, then look for the words. Both of these files explain in
 *  prose what they no longer do, and a test that reads the explanation as
 *  the thing itself is a test that can never go green. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

type Entry = Catalogue["plugins"][number];
const entry = (over: Partial<Entry> & { id: string }): Entry => ({
  source: { kind: "git", url: `https://github.com/acme/${over.id}`, ref: null },
  description: "",
  categories: [],
  ...over,
});

describe("what the market offers", () => {
  test("matches on what a person remembers, not only the title", () => {
    const shelf = [
      entry({ id: "local-review", title: "Local Review", publisher: "orbit", description: "Reviews your pull requests on this machine.", categories: ["review"] }),
      entry({ id: "clock", title: "Clock", publisher: "acme", description: "Puts the time in the top bar.", categories: ["bar"] }),
    ];
    expect(matching(shelf, "pull requests").map((e) => e.id)).toEqual(["local-review"]);
    expect(matching(shelf, "ORBIT").map((e) => e.id)).toEqual(["local-review"]);
    expect(matching(shelf, "bar").map((e) => e.id)).toEqual(["clock"]);
  });

  test("an empty box is not a filter", () => {
    const shelf = [entry({ id: "a" }), entry({ id: "b" })];
    expect(matching(shelf, "   ")).toHaveLength(2);
  });

  test("nothing matching is empty, never the whole shelf", () => {
    expect(matching([entry({ id: "a" })], "zzz")).toHaveLength(0);
  });

  test("an installed plugin is left out of the list, and said so underneath", () => {
    // The filter itself is one line in the component; what this holds is that
    // the page says how many it left out rather than quietly showing less.
    expect(code(market)).toContain("all.filter((e) => !installed(e.source.url))");
    expect(code(market)).toMatch(/already installed \$\{have === 1 \? "is" : "are"\} left out of this list/);
    expect(code(market)).toMatch(/Everything in the market is installed/);
  });
});

describe("finding one in a market that has grown", () => {
  const shelf = [
    entry({ id: "local-review", title: "Local Review", categories: ["review", "pull requests"] }),
    entry({ id: "sweeper", title: "Sweeper", categories: ["review"] }),
    entry({ id: "clock", title: "Clock", categories: ["bar"] }),
  ];

  test("the types on offer are counted, commonest first", () => {
    expect(types(shelf)).toEqual([
      { name: "review", count: 2 },
      { name: "bar", count: 1 },
      { name: "pull requests", count: 1 },
    ]);
  });

  test("counted over what is left on the shelf, so a filter cannot offer nothing", () => {
    // An installed plugin is filtered out before this runs; a type whose only
    // plugin is installed must not survive as a button that returns nothing.
    expect(types(shelf.filter((e) => e.id !== "clock")).map((t) => t.name)).not.toContain("bar");
  });

  test("a market with no types offers no filter row", () => {
    expect(types([entry({ id: "bare" })])).toEqual([]);
  });

  test("the search box is always there, not past some length", () => {
    expect(code(market)).not.toContain("SEARCHABLE");
    expect(code(market)).toContain('placeholder="Search the market"');
  });

  test("the filter is by the words the author filed it under", () => {
    expect(code(market)).toContain("(e.categories ?? []).includes(type)");
  });
});

describe("a row you can tell from the one above it", () => {
  test("every plugin gets a hue from the ramp that means nothing", () => {
    // The state colours would say a plugin is good, broken or careful. The
    // graph ramp is the set that says nothing — see its note in index.css.
    for (const id of ["local-review", "orbit-clock", "a", ""]) {
      expect(tintOf(id)).toMatch(/^var\(--graph-[1-8]\)$/);
    }
  });

  test("the same plugin keeps its colour between reads", () => {
    expect(tintOf("local-review")).toBe(tintOf("local-review"));
  });

  test("keyed on the id, so a new entry does not repaint the list", () => {
    // Position would: insert one at the top and every row below it changes.
    expect(code(market)).toContain("id.charCodeAt(i)");
    expect(code(market)).toContain("tintOf(entry.id)");
  });
});

describe("the list is the project's, and only the project's", () => {
  test("no way to add another list, and no way to remove this one", () => {
    for (const gone of ["Add by URL", "Another catalogue", "pluginCatalogueAdd", "pluginCatalogueRemove"]) {
      expect(code(market)).not.toContain(gone);
      expect(code(pane)).not.toContain(gone);
    }
    // "Remove" still belongs to an installed plugin's own card, on the page
    // above. What must not be here is a Remove on the list itself.
    expect(code(market)).not.toContain("Remove");
  });

  test("and the routes those buttons called are gone with them", () => {
    expect(code(api)).not.toContain("/plugins/catalogues");
    expect(code(api)).toContain("/plugins/catalogue?url=");
  });

  test("it is read on sight — no collapsed row to click open first", () => {
    // The old screen fetched on a click on the URL. This one fetches on mount,
    // which is the difference between a page about plugins and a page about a
    // JSON address.
    expect(code(market)).toContain("useEffect(() => { void load(); }, [load]);");
  });

  test("every row leads to the repository it would install, checked not trusted", () => {
    // The URL comes out of a document fetched over the network, so it goes
    // through the same scheme check every other outbound link in the app uses.
    expect(code(market)).toContain("externalUrl(entry.source.url)");
    expect(code(market)).toContain('rel="noopener noreferrer"');
    expect(code(market)).toContain("Repository");
  });

  test("the whole entry can be read without leaving the page", () => {
    // A row holds two lines of a description; the dialog holds the sentence,
    // the categories, the exact source and the ref it is pinned to.
    expect(code(market)).toContain("function Details(");
    expect(code(market)).toContain("entry.source.ref");
    expect(code(market)).toContain('aria-modal="true"');
  });

  test("it opens above the settings sheet it was opened from", async () => {
    // Settings is a full-height sheet; a dialog at a lower layer opens behind
    // the page that raised it and reads as a button that does nothing.
    expect(code(market)).toContain("LAYER.settingsDialog");
    const layers = code(await Bun.file(new URL("../src/lib/layers.ts", import.meta.url)).text());
    expect(layers).toMatch(/settingsDialog: 101\d\d,/);
    expect(layers.indexOf("settingsDialog")).toBeGreaterThan(layers.indexOf("settings:"));
    expect(layers.indexOf("settingsDialog")).toBeLessThan(layers.indexOf("menu:"));
  });

  test("Escape closes the dialog, not the settings sheet under it", () => {
    // Both listen on window; the sheet in the bubble phase. Captured and
    // stopped, or one key press closes both.
    expect(code(market)).toContain('window.addEventListener("keydown", onKey, true)');
    expect(code(market)).toContain("e.stopPropagation()");
  });

  test("read fresh, and said so", () => {
    expect(code(market)).toContain("api.pluginCatalogueFetch(MARKET_URL)");
    expect(code(market)).toContain("https://sirallap.github.io/agentglass/plugins.json");
  });
});

/*
 * A catalogue entry is a stranger's text: the manifest's publisher, the
 * submission's description. React renders strings as text, and nothing in
 * this screen says so out loud — so the day somebody reaches for markup to
 * bold a word, a description becomes a script. Rendered here and handed to a
 * real HTML parser, which is the only judge of what a browser would build.
 */
describe("a stranger's words stay words", () => {
  const HOSTILE = {
    description: '<img src=x onerror="alert(1)"> reviews things',
    publisher: '<script>alert(2)</script><a href="javascript:alert(3)">acme</a>',
    title: "<b>Orbit</b>",
  };

  test("the row puts title, publisher and description in as text", async () => {
    const html = renderToStaticMarkup(React.createElement(Offer, {
      entry: entry({ id: "orbit", ...HOSTILE }), owner: "acme", onInstalled: () => {},
    }));
    const built = await domOf(html);
    for (const tag of ["img", "script", "a", "b"]) expect(built.tags, `a <${tag}> was built from the entry`).not.toContain(tag);
    expect(built.attrs.map((a) => a.name)).not.toContain("onerror");
    // And the words are still there, for a person to read.
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;alert(2)");
  });

  test("the details' source line puts the URL and the ref in as text too", async () => {
    const html = renderToStaticMarkup(React.createElement(WhatIsCloned, {
      entry: entry({ id: "orbit", source: { kind: "git", url: "https://github.com/acme/orbit\"><img src=x>", ref: "<img src=y>" } }),
    }));
    expect((await domOf(html)).tags).not.toContain("img");
  });
});

describe("what a pinned entry says it installs", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const render = (over: Partial<Entry>) => renderToStaticMarkup(React.createElement(WhatIsCloned, { entry: entry({ id: "orbit", ...over }) }));

  test("a commit is shown short, the way git prints one, with the whole of it a hover away", () => {
    const html = render({ source: { kind: "git", url: "https://github.com/acme/orbit", ref: SHA }, sha256: "a".repeat(64) });
    expect(html).toContain(">0123456<");
    expect(html).toContain(`title="${SHA}"`);
    expect(html).not.toContain(`@${SHA}`);
  });

  test("and says the install is held to the listed hash only when there is one", () => {
    const pinned = render({ source: { kind: "git", url: "https://github.com/acme/orbit", ref: SHA }, sha256: "a".repeat(64) });
    expect(pinned).toContain("refuses");
    const commitOnly = render({ source: { kind: "git", url: "https://github.com/acme/orbit", ref: SHA } });
    expect(commitOnly).not.toContain("refuses");
    expect(commitOnly).toContain("0123456");
  });

  test("a branch is a ref somebody can move, and an unpinned entry is whatever the branch holds", () => {
    expect(render({ source: { kind: "git", url: "https://github.com/acme/orbit", ref: "main" } })).toContain("@main");
    expect(render({ source: { kind: "git", url: "https://github.com/acme/orbit", ref: "main" } })).toContain("can move");
    expect(render({})).toContain("default branch");
  });
});

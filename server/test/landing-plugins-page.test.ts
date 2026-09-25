/*
 * The plugins have a site of their own, and the landing only points at it.
 *
 * The landing used to draw its own copy of the catalogue from a plugins.json
 * that stays frozen for released apps. A second shelf reading a frozen file is
 * a market that goes stale without anybody noticing, so the landing keeps no
 * list at all: every link that says "plugins" leads to the market site, and an
 * old link to the page that used to be here still reaches the plugin it named.
 */
import { describe, expect, test } from "bun:test";

const PAGE = await Bun.file(new URL("../../landing/index.html", import.meta.url)).text();
const MARKET = "https://sirallap.github.io/agentglass-plugins/";

/** The page's script with comment lines dropped, so a word in a comment is not
 *  mistaken for code. */
const CODE = PAGE.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

describe("the landing's plugins", () => {
  test("draws no catalogue of its own", () => {
    expect(PAGE).not.toContain('<main id="plugins"');
    expect(CODE).not.toContain('fetch("plugins.json"');
    expect(PAGE).not.toMatch(/class="pl-/);
  });

  test("the header, the home's card and the guide all lead to the market site", () => {
    const nav = PAGE.match(/<nav class="hd-nav">[\s\S]*?<\/nav>/);
    expect(nav).not.toBeNull();
    expect(nav![0]).toContain(`<a href="${MARKET}">Plugins</a>`);
    expect(PAGE).toContain(`<a class="nxc big" href="${MARKET}">`);
    expect(PAGE).toContain(`<a href="${MARKET}" style="color:var(--vio)">Browse the plugins</a>`);
    expect(PAGE).not.toContain('href="#/plugins');
  });

  test("asks to be listed in the plugins repository, never in this one", () => {
    expect(PAGE).not.toContain("SirAllap/agentglass/issues/new?template=plugin_submission");
  });

  test("an old link to the plugins page, or to one plugin on it, lands on the market", () => {
    const start = CODE.indexOf('const pages = ["home", "guide", "faq"];');
    expect(start).toBeGreaterThan(-1);
    const router = CODE.slice(start, CODE.indexOf('addEventListener("hashchange", go);', start));
    expect(router).toContain('if (first === "plugins")');
    expect(router).toContain(`location.replace("${MARKET}" + (id ? "#/plugin/" + id : ""));`);
  });
});

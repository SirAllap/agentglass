/* A Settings page opens in one paint: when the page asked for is swapped in, which page block draws
   where, when a read goes out, and which headings the "On this page" rail lists. */
import { describe, expect, it } from "bun:test";
import { CAP_MS, FRESH_MS, HOLD_MS, backPane, layerRole, otherLayer, pageReady, shouldFetch, shouldPrefetch, switchPhase } from "../src/lib/settingsReady.ts";
import { autoCheckHint } from "../src/lib/aboutRules.ts";
import { foundTitle, railEntries, sameEntries, type SectionMeta } from "../src/components/settings/shell/shellRules.ts";
import { clearSettingsCache, hasReads, prefetchPage, registerRead } from "../src/components/settings/shell/pageLoad.tsx";

describe("switch phase", () => {
  it("swaps at once when the page is ready, however early", () => {
    expect(switchPhase(true, 0)).toBe("swap");
    expect(switchPhase(true, HOLD_MS + 1)).toBe("swap");
  });
  it("keeps the old page during the hold, then a skeleton, then swaps at the cap", () => {
    expect(switchPhase(false, 0)).toBe("hold");
    expect(switchPhase(false, HOLD_MS - 1)).toBe("hold");
    expect(switchPhase(false, HOLD_MS)).toBe("skeleton");
    expect(switchPhase(false, CAP_MS - 1)).toBe("skeleton");
    expect(switchPhase(false, CAP_MS)).toBe("swap");
  });
  it("is ready only once mounted with nothing still out", () => {
    expect(pageReady(false, undefined)).toBe(false);
    expect(pageReady(true, undefined)).toBe(true);
    expect(pageReady(true, new Set())).toBe(true);
    expect(pageReady(true, new Set(["a"]))).toBe(false);
  });
});

describe("layers", () => {
  it("the back layer mounts the page asked for only while it is not on screen", () => {
    expect(backPane("git", "perm", false)).toBe("perm");
    expect(backPane("perm", "perm", false)).toBe(null);
    expect(backPane(null, "perm", false)).toBe("perm");
  });
  it("search results are never held back", () => {
    expect(backPane("git", "perm", true)).toBe(null);
    expect(layerRole(true, "git", true)).toBe("plain");
    expect(layerRole(false, "perm", true)).toBe("none");
  });
  it("the front layer is on screen, the back one out of sight, an empty one not drawn", () => {
    expect(layerRole(true, "git", false)).toBe("shown");
    expect(layerRole(false, "perm", false)).toBe("pending");
    expect(layerRole(true, null, false)).toBe("none");
    expect(otherLayer("a")).toBe("b");
    expect(otherLayer("b")).toBe("a");
  });
});

describe("reads", () => {
  it("fetches when nothing is cached or the value is stale, never twice at once", () => {
    expect(shouldFetch(undefined, false, 1000)).toBe(true);
    expect(shouldFetch(undefined, true, 1000)).toBe(false);
    expect(shouldFetch({ at: 1000 }, false, 1000 + FRESH_MS - 1)).toBe(false);
    expect(shouldFetch({ at: 1000 }, false, 1000 + FRESH_MS)).toBe(true);
  });
  it("a hover warms a page with reads, not the page already on screen", () => {
    expect(shouldPrefetch("perm", "git", true)).toBe(true);
    expect(shouldPrefetch("perm", "perm", true)).toBe(false);
    expect(shouldPrefetch("perm", "git", false)).toBe(false);
  });
  it("a hover then a click is one request, not two", async () => {
    clearSettingsCache();
    let calls = 0;
    registerRead("test-page", "test/read", async () => { calls++; return 1; });
    expect(hasReads("test-page")).toBe(true);
    expect(hasReads("no-such-page")).toBe(false);
    prefetchPage("test-page");
    prefetchPage("test-page");
    await new Promise((r) => setTimeout(r, 0));
    prefetchPage("test-page");
    expect(calls).toBe(1);
  });
});

describe("rail entries", () => {
  const m = (id: string, title = id): SectionMeta => ({ id, title, kind: "normal" });
  it("lists every section the page drew when it drew any", () => {
    const declared = [m("keeping-score"), m("score"), m("learns")];
    const found = [m("keeping-score"), m("score"), m("learn-setup"), m("learn-never", "What it must never see"), m("learn-rules")];
    expect(railEntries(declared, found).map((x) => x.id)).toEqual(["keeping-score", "score", "learn-setup", "learn-never", "learn-rules"]);
  });
  it("falls back to the declaration with no DOM", () => {
    const declared = [m("a"), m("b")];
    expect(railEntries(declared, null)).toBe(declared);
    expect(railEntries(declared, [])).toBe(declared);
  });
  it("compares by id, title and kind", () => {
    expect(sameEntries([m("a")], [m("a")])).toBe(true);
    expect(sameEntries([m("a")], [m("a", "A")])).toBe(false);
    expect(sameEntries(null, [m("a")])).toBe(false);
  });
});

describe("rail title of a drawn section", () => {
  const declared: SectionMeta[] = [{ id: "build", title: "This build", kind: "normal" }];
  it("prefers the visible heading", () => {
    expect(foundTitle(" Setup checks ", "checks", declared)).toBe("Setup checks");
  });
  it("falls back to the declared title, never the raw id", () => {
    expect(foundTitle(undefined, "build", declared)).toBe("This build");
    expect(foundTitle("", "build", declared)).toBe("This build");
  });
  it("drops a node with no heading and no declaration", () => {
    expect(foundTitle(null, "opens", declared)).toBeNull();
  });
});

describe("auto-check hint", () => {
  it("follows the switch", () => {
    expect(autoCheckHint(false)).toBe("Off: the release feed is asked only when you press Check.");
    expect(autoCheckHint(true)).toMatch(/^On: /);
  });
});

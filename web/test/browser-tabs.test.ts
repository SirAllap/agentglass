/*
 * The tab strip's small rules — the ones nobody notices until one is wrong.
 *
 * Most of this is about closing. Which tab takes the focus afterwards is the
 * difference between closing four tabs in a row without looking, and being
 * thrown somewhere different every time; and closing the last one has to leave
 * something behind, because a browser view with no page in it has nothing to
 * show and no way back.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { addTab, closeTab, MAX_TABS, newTab, patchTab, stepTab, tabLabel, __resetTabIds } from "../src/lib/browserTabs.ts";

beforeEach(__resetTabIds);

const three = () => {
  const a = newTab("https://a.test/");
  const b = newTab("https://b.test/");
  const c = newTab("https://c.test/");
  return { a, b, c, tabs: [a, b, c] };
};

describe("what a tab is called", () => {
  it("uses the page's own title once it has one", () => {
    expect(tabLabel({ ...newTab("https://github.com/x"), title: "Releases · x" })).toBe("Releases · x");
  });

  it("falls back to the host, which is what you scan a strip for", () => {
    expect(tabLabel(newTab("https://github.com/SirAllap/agentglass/releases"))).toBe("github.com");
  });

  it("says New tab only when there is genuinely nothing to say", () => {
    expect(tabLabel(newTab())).toBe("New tab");
  });

  it("survives something that is not a URL at all", () => {
    expect(tabLabel(newTab("not a url"))).toBe("not a url");
  });

  it("prefers the title even over a perfectly good host", () => {
    expect(tabLabel({ ...newTab("https://a.test/"), title: "  Home  " })).toBe("Home");
  });
});

describe("closing", () => {
  it("moves to the tab on the right", () => {
    // Every browser does this, and it is the only rule under which closing
    // several in a row leaves the cursor somewhere predictable.
    const { a, b, c, tabs } = three();
    const r = closeTab(tabs, b.id);
    expect(r.tabs.map((t) => t.id)).toEqual([a.id, c.id]);
    expect(r.activeId).toBe(c.id);
  });

  it("falls back to the left at the end of the strip", () => {
    const { a, b, c, tabs } = three();
    const r = closeTab(tabs, c.id);
    expect(r.activeId).toBe(b.id);
    expect(r.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("closing three in a row keeps landing somewhere sensible", () => {
    const { a, b, c, tabs } = three();
    const one = closeTab(tabs, a.id);
    expect(one.activeId).toBe(b.id);
    const two = closeTab(one.tabs, b.id);
    expect(two.activeId).toBe(c.id);
  });

  it("leaves a blank tab rather than an empty strip", () => {
    // A browser view with no page in it has nothing to show and no way back.
    const only = newTab("https://a.test/");
    const r = closeTab([only], only.id);
    expect(r.tabs).toHaveLength(1);
    expect(r.tabs[0]!.url).toBe("about:blank");
    expect(r.activeId).toBe(r.tabs[0]!.id);
    expect(r.tabs[0]!.id).not.toBe(only.id);
  });

  it("ignores a tab that is not there", () => {
    const { tabs } = three();
    expect(closeTab(tabs, "nope").tabs).toBe(tabs);
  });
});

describe("opening", () => {
  it("puts a new tab next to the one it came from", () => {
    // A link opened from the first tab belongs beside it, not at the far end
    // past six others.
    const { a, b, c, tabs } = three();
    const r = addTab(tabs, "https://new.test/", a.id);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.tabs.map((t) => t.id)).toEqual([a.id, r.tab.id, b.id, c.id]);
  });

  it("appends when it came from nowhere in particular", () => {
    const { tabs } = three();
    const r = addTab(tabs, "https://new.test/");
    if ("error" in r) throw new Error(r.error);
    expect(r.tabs.at(-1)!.id).toBe(r.tab.id);
  });

  it("refuses past the cap, and says why and what to do", () => {
    // Each tab is a live Chromium guest, in an app that is also running a
    // fleet of agents. A silent drop would look like the button was broken.
    let tabs = Array.from({ length: MAX_TABS }, () => newTab("https://x.test/"));
    const r = addTab(tabs, "https://one-too-many.test/");
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain(String(MAX_TABS));
    expect(r.error).toContain("Close one");
  });
});

describe("patching one tab", () => {
  it("changes only the one named", () => {
    const { a, b, tabs } = three();
    const next = patchTab(tabs, b.id, { title: "moved" });
    expect(next[1]!.title).toBe("moved");
    expect(next[0]).toBe(tabs[0]);   // untouched, same object
    expect(next[2]).toBe(tabs[2]);
  });

  it("hands back the very same list when nothing changed", () => {
    // These arrive from a poll. Without this the strip repaints continuously.
    const { b, tabs } = three();
    expect(patchTab(tabs, b.id, { title: "" })).toBe(tabs);
    expect(patchTab(tabs, b.id, { url: "https://b.test/" })).toBe(tabs);
  });

  it("says nothing about a tab that has gone", () => {
    const { tabs } = three();
    expect(patchTab(tabs, "gone", { title: "x" })).toBe(tabs);
  });
});

describe("stepping through them", () => {
  it("wraps at the end", () => {
    const { a, c, tabs } = three();
    expect(stepTab(tabs, c.id, 1)).toBe(a.id);
    expect(stepTab(tabs, a.id, -1)).toBe(c.id);
  });

  it("stays put when there is only one", () => {
    const a = newTab();
    expect(stepTab([a], a.id, 1)).toBe(a.id);
  });

  it("lands somewhere real when the active tab has gone", () => {
    const { a, tabs } = three();
    expect(stepTab(tabs, "gone", 1)).toBe(a.id);
  });
});

/*
 * Which profile a tab belongs to.
 *
 * Chromium decides a guest's partition when it attaches, so this is fixed for
 * the life of the tab — which makes every rule about *inheriting* it load
 * bearing. Getting one wrong signs somebody out mid-flow, and the symptom
 * ("it logged me out") points nowhere near the tab strip.
 */
describe("profiles", () => {
  it("a new tab is in the default profile unless asked otherwise", () => {
    expect(newTab("https://a.test/").profile).toBe("");
    expect(newTab("https://a.test/", "work").profile).toBe("work");
  });

  it("a link opened from a page stays in that page's profile", () => {
    // The one that matters. An OAuth popup, or a middle-click on a result, must
    // land in the identity the page it came from is signed into — otherwise the
    // popup is a stranger and the sign-in fails in a way nobody can explain.
    const work = newTab("https://app.test/", "work");
    const r = addTab([work], "https://auth.test/", work.id);
    if ("error" in r) throw new Error("should have opened");
    expect(r.tab.profile).toBe("work");
  });

  it("an explicit profile wins over the tab it was opened beside", () => {
    // This is what "open a new tab as somebody else" does from the menu.
    const work = newTab("https://app.test/", "work");
    const r = addTab([work], "https://app.test/", work.id, "client");
    if ("error" in r) throw new Error("should have opened");
    expect(r.tab.profile).toBe("client");
  });

  it("a tab opened from nowhere is in the default profile", () => {
    const r = addTab([newTab("https://a.test/", "work")], "https://b.test/");
    if ("error" in r) throw new Error("should have opened");
    expect(r.tab.profile).toBe("");
  });

  it("closing the last tab leaves a blank one in the same profile", () => {
    // Closing your last work tab should not quietly drop you back into the
    // default identity — the strip would look the same and the next page you
    // opened would be signed in as somebody else.
    const only = newTab("https://a.test/", "work");
    const r = closeTab([only], only.id);
    expect(r.tabs.length).toBe(1);
    expect(r.tabs[0]!.profile).toBe("work");
  });
});

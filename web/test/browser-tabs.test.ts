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
import { readFileSync } from "node:fs";
import { addTab, closeTab, pickSleeper, wake, SLEEP_GRACE_MS, type Recency, popupHome, isBlank, listable, MAX_TABS, newTab, patchTab, pruneBlank, stepTab, tabLabel, withInspected, __resetTabIds } from "../src/lib/browserTabs.ts";

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

  it("closing the last tab leaves nothing open", () => {
    // The island's overview and the person's bar are the way back, so no blank
    // tab is put in the closed one's place (it showed as a white card there).
    const only = newTab("https://a.test/", "work");
    expect(closeTab([only], only.id)).toEqual({ tabs: [], activeId: "" });
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

  it("carries an ephemeral tab's own partition, when `newtab --from-template` minted one", () => {
    // `newtab --from-template`'s visible-tab jar: the partition is main's to
    // mint (electron/main.js `ag:tabEphemeralOpen`), not derived from the
    // tab's own id, so it travels as its own argument.
    const { tabs } = three();
    const r = addTab(tabs, "https://acme.example/", undefined, undefined, undefined, "agentglass-browser-eph-t1a2b3c4");
    if ("error" in r) throw new Error(r.error);
    expect(r.tab.partition).toBe("agentglass-browser-eph-t1a2b3c4");
  });

  it("leaves an ordinary tab with no partition of its own", () => {
    // The webview falls back to `partitionFor(BROWSER_PARTITION, profile)` —
    // this only ever carries a value for the ephemeral fork.
    const r = addTab(three().tabs, "https://ordinary.example/");
    if ("error" in r) throw new Error(r.error);
    expect(r.tab.partition).toBeUndefined();
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

describe("a full strip puts the least-used tab to sleep", () => {
  const full = () => Array.from({ length: MAX_TABS }, (_, i) => newTab(`https://x${i}.test/`));
  const rec = (tabs: ReturnType<typeof full>, over: Partial<Recency> = {}): Recency => ({
    activeId: tabs[0]!.id,
    usedAt: Object.fromEntries(tabs.map((t, i) => [t.id, 1000 + i])),
    held: () => false,
    ...over,
  });

  it("picks the oldest-used, not the first row", () => {
    const tabs = full();
    const r = rec(tabs, { usedAt: Object.fromEntries(tabs.map((t, i) => [t.id, 1000 - i])) });
    expect(pickSleeper(tabs, r)).toBe(tabs[MAX_TABS - 1]!.id);
  });

  it("never the tab in front, even when it is the oldest", () => {
    const tabs = full();
    const r = rec(tabs, { activeId: tabs[0]!.id, usedAt: { ...rec(tabs).usedAt, [tabs[0]!.id]: 1 } });
    expect(pickSleeper(tabs, r)).toBe(tabs[1]!.id);
  });

  it("never a tab an agent holds", () => {
    const tabs = full();
    const held = new Set([tabs[1]!.id, tabs[2]!.id]);
    expect(pickSleeper(tabs, rec(tabs, { held: (t) => held.has(t.id) }))).toBe(tabs[3]!.id);
  });

  it("skips tabs already asleep, and answers null when every one is protected", () => {
    const tabs = full().map((t, i) => (i === 1 ? { ...t, asleep: true } : t));
    expect(pickSleeper(tabs, rec(tabs))).toBe(tabs[2]!.id);
    expect(pickSleeper(tabs, rec(tabs, { held: () => true }))).toBeNull();
  });

  it("addTab sleeps the pick, seats the new tab awake and names who slept", () => {
    const tabs = full();
    const r = addTab(tabs, "https://thirteen.test/", undefined, undefined, undefined, undefined, rec(tabs));
    if ("error" in r) throw new Error(r.error);
    expect(r.slept).toBe(tabs[1]!.id);
    expect(r.tabs.find((t) => t.id === r.slept)!.asleep).toBe(true);
    expect(r.tab.asleep).toBeUndefined();
    expect(r.tabs.filter((t) => !t.asleep).length).toBe(MAX_TABS);
  });

  it("still refuses, with a true sentence, when every awake tab is in front or held", () => {
    const tabs = full();
    const r = addTab(tabs, "https://thirteen.test/", undefined, undefined, undefined, undefined, rec(tabs, { held: () => true }));
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("in an agent's hands");
  });

  it("waking a sleeper at the cap puts the least-used awake tab to sleep, so the cap holds", () => {
    // 14 pages: 12 awake, 2 asleep. Waking each one used to reach 14 awake.
    const full12 = full();
    const tabs = [...full12, { ...newTab("https://a.test/"), asleep: true }, { ...newTab("https://b.test/"), asleep: true }];
    let now = tabs;
    for (const id of [tabs[12]!.id, tabs[13]!.id]) now = wake(now, id, rec(now));
    expect(now.filter((t) => !t.asleep).length).toBe(MAX_TABS);
    expect(now.find((t) => t.id === tabs[12]!.id)!.asleep).toBeFalsy();
    expect(now.find((t) => t.id === tabs[13]!.id)!.asleep).toBeFalsy();
  });

  it("grace is minutes, so an agent between two verbs keeps its page", () => {
    expect(SLEEP_GRACE_MS).toBeGreaterThanOrEqual(60_000);
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
});

/*
 * A blank tab is not a page.
 *
 * It is the state between pressing Ctrl+T and typing something, and the panel
 * already says so in the middle of the screen. A row for it in the sidebar is
 * the same sentence said again, in a list of pages you actually have — "it
 * should not count as a tab".
 */
describe("blank tabs", () => {
  const blank = { ...newTab(), id: "b1" };
  const real = { ...newTab("https://orbit.example/"), id: "r1", title: "Orbit" };

  it("a blank one is one with no address and no title", () => {
    expect(isBlank(blank)).toBe(true);
    expect(isBlank(real)).toBe(false);
    // A tab that has started loading has a title or an address, so it is a page
    // from that moment on rather than from when it finishes.
    expect(isBlank({ ...blank, url: "https://orbit.example/" })).toBe(false);
    expect(isBlank({ ...blank, title: "Loading…" })).toBe(false);
  });

  it("the list draws pages only", () => {
    expect(listable([blank, real]).map((t) => t.id)).toEqual(["r1"]);
  });

  /* Not drawn means not reachable, so one left in the background would be a tab
     with no way back to it. */
  it("one you have walked away from is dropped", () => {
    expect(pruneBlank([blank, real], "r1").map((t) => t.id)).toEqual(["r1"]);
  });

  it("the one you are on survives — that is where you are about to type", () => {
    expect(pruneBlank([blank, real], "b1").map((t) => t.id)).toEqual(["b1", "r1"]);
  });

  it("never nothing", () => {
    // An empty list has no active tab and nowhere to type.
    expect(pruneBlank([blank], "somebody-else")).toHaveLength(1);
  });
});

/*
 * WHICH PAGE SOMEBODY ELSE IS INSPECTING.
 *
 * An agent can open the inspector from a terminal, and it opens hidden — so
 * without a mark on the tab there is no pixel anywhere saying it is there, and
 * the switch in the ⋯ menu stays off because that switch is about what the
 * panel itself opened. Before it opened hidden you found out because it
 * covered half the window: a bug, and by accident the only signal there was.
 *
 * The shell reports every open and close, including the panel's own, so this
 * is told the same thing more than once by design. That is what the identity
 * rule is for.
 */
describe("the inspector mark", () => {
  it("adds and removes the page it is told about", () => {
    const none: ReadonlySet<string> = new Set();
    const one = withInspected(none, "t1", true);
    expect([...one]).toEqual(["t1"]);
    expect([...withInspected(one, "t2", true)].sort()).toEqual(["t1", "t2"]);
    expect([...withInspected(one, "t1", false)]).toEqual([]);
  });

  it("hands back the SAME set when told what it already knows", () => {
    /* Not an optimisation — the panel would re-render its whole tab list on
       every repeat, and the shell repeats by design. `toBe`, not `toEqual`:
       an equal set is a new object and React reads it as news. */
    const one = withInspected(new Set(), "t1", true);
    expect(withInspected(one, "t1", true)).toBe(one);
    const none: ReadonlySet<string> = new Set();
    expect(withInspected(none, "t9", false)).toBe(none);
  });

  it("ignores a guest it could not place on any tab", () => {
    /* The panel passes "" when no mounted webview owns that guest — a page
       that closed mid-flight. Adding it would light a mark on nothing. */
    const one = withInspected(new Set(), "t1", true);
    expect(withInspected(one, "", true)).toBe(one);
  });
});

describe("a page that opens a tab", () => {
  /* A link with target=_blank in an agent's container tab opened in the
     owner's own profile, beside whatever tab was in front: the agent's page
     got the owner's cookies. */
  const tabs = [
    { id: "t1", profile: "" },
    { id: "t2", profile: "orbit-agent" },
    { id: "t3", profile: "orbit-agent", partition: "persist:agx-eph-1" },
  ] as never;
  const ids: Record<string, number> = { t1: 40, t2: 41, t3: 42 };
  const idOf = (id: string) => ids[id];

  it("opens beside its opener, in the opener's profile, not the front tab's", () => {
    expect(popupHome(tabs, idOf, 41, "t1")).toEqual({ from: "t2", profile: "orbit-agent" });
  });
  it("keeps an ephemeral opener's own jar", () => {
    expect(popupHome(tabs, idOf, 42, "t1")).toEqual({ from: "t3", profile: "orbit-agent", partition: "persist:agx-eph-1" });
  });
  it("stays the owner's when the owner's tab opened it", () => {
    expect(popupHome(tabs, idOf, 40, "t2")).toEqual({ from: "t1", profile: "" });
  });
  it("is refused when the opener is none of ours, rather than guessed", () => {
    /* No profile is a safe guess for a page nobody can attribute: the front
       tab's is the owner's cookies, and a named one may be another agent's. */
    expect(popupHome(tabs, idOf, 99, "t1")).toBeNull();
  });
  it("falls back to the tab in front only when the page named no opener", () => {
    expect(popupHome(tabs, idOf, undefined, "t2")).toEqual({ from: "t2", profile: undefined });
  });
});

describe("the popup is wired from the page to the panel", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  it("sends the opener's id from both places a guest asks for a tab", () => {
    const main = read("../../electron/main.js");
    expect(main).toContain('win.webContents.send("ag:browser-open-tab", safe, guest.id)');
    expect(main).toContain('win.webContents.send("ag:browser-open-tab", url, guest.id)');
  });
  it("hands it through the bridge and opens in the opener's profile and jar", () => {
    expect(read("../../electron/preload.js")).toContain("fn(String(url), typeof opener === \"number\" ? opener : undefined)");
    const panel = read("../src/components/BrowserPanel.tsx");
    expect(panel).toContain("popupHome(tabsRef.current, idOf, opener, activeId)");
    expect(panel).toContain("open(url, home.from, home.profile, undefined, (id) => notePopup(opener, id, url), home.partition)");
  });
});

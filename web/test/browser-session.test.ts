/*
 * Reopening where you left off, without paying for it.
 *
 * Two things are being asserted here and they pull against each other. The
 * tabs have to come back — same pages, same order, same one in front. And
 * bringing them back must not mount twelve Chromium guests at launch, because
 * each tab in this browser is a live guest with its own processes and the app
 * around it is already running a fleet of agents. So a restored tab is a name,
 * an icon and an address until it is selected.
 *
 * The rules about WHAT is worth restoring are the third thing: a blank tab is
 * the absence of a page rather than a page, and an address this browser did
 * not put there does not come back at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { newTab, sleepingTab, wake, __resetTabIds, type BrowserTab } from "../src/lib/browserTabs.ts";
import { readSession, saveSession, forgetSession, forgetProfileTabs, worthSaving, countFor, setFor, SESSION_KEY } from "../src/lib/browserSession.ts";

/** localStorage, in a test runner that has none. */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  __resetTabIds();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
});
afterEach(() => store.clear());

const tab = (url: string, over: Partial<BrowserTab> = {}): BrowserTab => ({ ...newTab(url), ...over });

describe("what is worth writing down", () => {
  it("keeps the pages you were actually on", () => {
    const tabs = [tab("https://github.com/"), tab("https://clickup.com/")];
    expect(worthSaving(tabs).map((t) => t.url)).toEqual(["https://github.com/", "https://clickup.com/"]);
  });

  it("drops the blank ones", () => {
    // Three blank tabs restored is nothing restored, and it looks like a bug
    // rather than like an empty browser.
    const tabs = [tab("about:blank"), tab("https://github.com/"), tab("about:blank")];
    expect(worthSaving(tabs).map((t) => t.url)).toEqual(["https://github.com/"]);
  });

  it("refuses anything that is not http", () => {
    // `file://` would reopen somebody's disk on launch; nothing else belongs
    // in a list this browser wrote.
    const tabs = [tab("file:///etc/passwd"), tab("chrome://settings"), tab("https://ok.test/")];
    expect(worthSaving(tabs).map((t) => t.url)).toEqual(["https://ok.test/"]);
  });

  it("never writes more than the strip can hold", () => {
    const tabs = Array.from({ length: 40 }, (_, i) => tab(`https://s${i}.test/`));
    expect(worthSaving(tabs)).toHaveLength(12);
  });
});

describe("a profile is a set of tabs", () => {
  it("keeps each profile's strip apart", () => {
    const work = [tab("https://github.com/", { title: "GitHub" })];
    const test = [tab("https://staging.test/", { profile: "work" }), tab("https://mail.test/", { profile: "work" })];
    saveSession("", work, work[0]!.id);
    saveSession("work", test, test[1]!.id);

    const back = readSession()!;
    expect(setFor(back, "")!.tabs.map((t) => t.url)).toEqual(["https://github.com/"]);
    expect(setFor(back, "work")!.tabs.map((t) => t.url)).toEqual(["https://staging.test/", "https://mail.test/"]);
    expect(setFor(back, "work")!.active).toBe(1);
  });

  it("does not delete the profile you are not looking at", () => {
    // The whole reason the file is keyed by profile: the other profile's tabs
    // are not in memory, so a write that rebuilt the file from what is on
    // screen would throw them away.
    saveSession("work", [tab("https://staging.test/", { profile: "work" })], "");
    saveSession("", [tab("https://github.com/")], "");
    expect(countFor(readSession(), "work")).toBe(1);
  });

  it("remembers which profile you were in", () => {
    saveSession("work", [tab("https://staging.test/")], "");
    expect(readSession()!.current).toBe("work");
  });

  it("says how many pages each profile is holding", () => {
    saveSession("work", [tab("https://a.test/", { profile: "work" }), tab("https://b.test/", { profile: "work" })], "");
    expect(countFor(readSession(), "work")).toBe(2);
    expect(countFor(readSession(), "nope")).toBe(0);
  });

  it("stops holding a profile it has been emptied of", () => {
    saveSession("work", [tab("https://a.test/", { profile: "work" })], "");
    saveSession("work", [tab("about:blank", { profile: "work" })], "");
    expect(setFor(readSession(), "work")).toBeNull();
  });

  it("drops a profile's tabs when the profile is forgotten", () => {
    saveSession("", [tab("https://keep.test/")], "");
    saveSession("work", [tab("https://gone.test/")], "");
    forgetProfileTabs("work");
    expect(countFor(readSession(), "work")).toBe(0);
    expect(countFor(readSession(), "")).toBe(1);
  });
});

describe("round trip", () => {
  it("brings back the pages, in order, with what they were called", () => {
    const tabs = [
      tab("https://github.com/", { title: "GitHub", icon: "https://github.com/f.ico" }),
      tab("https://clickup.com/", { title: "ClickUp", icon: null }),
    ];
    saveSession("", tabs, tabs[1]!.id);

    const set = setFor(readSession(), "")!;
    expect(set.tabs.map((t) => t.url)).toEqual(["https://github.com/", "https://clickup.com/"]);
    expect(set.tabs[0]!.title).toBe("GitHub");
    expect(set.tabs[0]!.icon).toBe("https://github.com/f.ico");
    expect(set.active).toBe(1);
  });

  it("points at the right tab after the blank ones are dropped", () => {
    // The index is into the SAVED list, not the live one. Saving the live index
    // would open on the wrong page, or past the end of the list.
    const tabs = [tab("about:blank"), tab("https://a.test/"), tab("https://b.test/")];
    saveSession("", tabs, tabs[2]!.id);
    expect(setFor(readSession(), "")!.active).toBe(1);
  });

  it("falls back to the first tab when the one in front was not saved", () => {
    const tabs = [tab("https://a.test/"), tab("about:blank")];
    saveSession("", tabs, tabs[1]!.id);
    expect(setFor(readSession(), "")!.active).toBe(0);
  });

  it("writes nothing at all when there was nothing to keep", () => {
    saveSession("", [tab("about:blank")], "");
    expect(store.get(SESSION_KEY)).toBeUndefined();
    expect(readSession()).toBeNull();
  });

  it("does not carry over what the guest alone can know", () => {
    // `loading`, `failed` and the history flags describe a process that no
    // longer exists. Restoring them would restore a lie.
    const tabs = [tab("https://a.test/", { loading: true, failed: "net::ERR", canBack: true })];
    saveSession("", tabs, tabs[0]!.id);
    expect(JSON.stringify(readSession())).not.toMatch(/loading|failed|canBack/);
  });
});

describe("a session that cannot be trusted", () => {
  it("survives a truncated write", () => {
    store.set(SESSION_KEY, '{"v":2,"byProfile":{"":{"tabs":[{"url":"https://a.te');
    expect(readSession()).toBeNull();
  });

  it("drops a version it does not know", () => {
    store.set(SESSION_KEY, JSON.stringify({ v: 99, byProfile: { "": { tabs: [{ url: "https://a.test/" }], active: 0 } } }));
    expect(readSession()).toBeNull();
  });

  it("reads a session from before profiles were a place", () => {
    // v1 was one flat list. Those are real tabs somebody left open, so they go
    // into the default profile rather than being dropped for having the wrong
    // shape.
    store.set(SESSION_KEY, JSON.stringify({ v: 1, active: 1, tabs: [{ url: "https://a.test/" }, { url: "https://b.test/" }] }));
    const back = readSession()!;
    expect(back.current).toBe("");
    expect(setFor(back, "")!.tabs.map((t) => t.url)).toEqual(["https://a.test/", "https://b.test/"]);
    expect(setFor(back, "")!.active).toBe(1);
  });

  it("re-checks the addresses on the way in, not only on the way out", () => {
    // The file is on disk and editable. A `file://` that was written by hand
    // must not be opened just because it is in the session.
    store.set(SESSION_KEY, JSON.stringify({ v: 2, current: "", byProfile: { "": { tabs: [{ url: "file:///etc/shadow" }], active: 0 } } }));
    expect(readSession()).toBeNull();
  });

  it("refuses a profile id it did not mint", () => {
    // This string picks a cookie jar. A hand-edited one must not name a
    // partition nobody validated.
    store.set(SESSION_KEY, JSON.stringify({
      v: 2, current: "../../evil",
      byProfile: { "../../evil": { tabs: [{ url: "https://a.test/" }], active: 0 }, "": { tabs: [{ url: "https://ok.test/" }], active: 0 } },
    }));
    const back = readSession()!;
    expect(back.current).toBe("");
    expect(Object.keys(back.byProfile)).toEqual([""]);
  });

  it("clamps an active index that points nowhere", () => {
    store.set(SESSION_KEY, JSON.stringify({ v: 2, current: "", byProfile: { "": { tabs: [{ url: "https://a.test/" }], active: 9 } } }));
    expect(setFor(readSession(), "")!.active).toBe(0);
  });

  it("forgets on request", () => {
    saveSession("", [tab("https://a.test/")], "");
    forgetSession();
    expect(readSession()).toBeNull();
  });
});

describe("what a restored tab costs", () => {
  it("comes back asleep, which is what makes it free", () => {
    const t = sleepingTab("https://a.test/", "A", null, "");
    expect(t.asleep).toBe(true);
    expect(t.title).toBe("A");
    // Everything a guest would have reported starts empty, because there is no
    // guest to have reported it.
    expect(t.loading).toBe(false);
    expect(t.canBack).toBe(false);
  });

  it("wakes when it is opened, and only that one", () => {
    const tabs = [sleepingTab("https://a.test/", "A", null, ""), sleepingTab("https://b.test/", "B", null, "")];
    const after = wake(tabs, tabs[1]!.id);
    expect(after[0]!.asleep).toBe(true);
    expect(after[1]!.asleep).toBe(false);
  });

  it("returns the same array when there is nothing to wake", () => {
    // Selecting a tab that is already open must not re-render every guest in
    // the strip, which a new array would.
    const tabs = [tab("https://a.test/")];
    expect(wake(tabs, tabs[0]!.id)).toBe(tabs);
  });

  it("carries the profile, because that is which jar it loads with", () => {
    expect(sleepingTab("https://a.test/", "A", null, "work").profile).toBe("work");
  });
});

/*
 * A TAB IS FILED UNDER ITS OWN IDENTITY.
 *
 * The strip holds one list whatever profile each page belongs to — that is what
 * makes an agent's tab addressable while a person works in another identity.
 * The write used to file the whole list under whichever profile was on screen,
 * which RELABELLED every foreign tab in it: an agent's page, opened with
 * `--as review-pr-540` into the list that happened to be loaded, came back
 * after a restart as one of the default profile's pages.
 *
 * That is the whole of "the agent ended up in Default without doing anything
 * wrong", and the obvious diagnosis — "profiles do not survive a restart" — is
 * the wrong one. The profile survived. The tab was filed under the wrong one
 * before the restart and came back wearing it.
 */
describe("a strip holding more than one profile", () => {
  it("files each tab under the profile it belongs to, not the one on screen", () => {
    const mine = tab("https://github.com/");                               // the person's
    const theirs = tab("https://staging.test/", { profile: "agent1" });   // an agent's
    saveSession("", [mine, theirs], mine.id);

    const back = readSession()!;
    expect(setFor(back, "")!.tabs.map((t) => t.url)).toEqual(["https://github.com/"]);
    expect(setFor(back, "agent1")!.tabs.map((t) => t.url)).toEqual(["https://staging.test/"]);
  });

  it("does not empty a profile just because it is not in the strip", () => {
    saveSession("agent1", [tab("https://staging.test/", { profile: "agent1" })], "");
    // A later write from the person's own strip, which knows nothing about it.
    saveSession("", [tab("https://github.com/")], "");
    expect(countFor(readSession(), "agent1")).toBe(1);
  });

  it("still clears the profile being written from when its last page closes", () => {
    saveSession("agent1", [tab("https://staging.test/", { profile: "agent1" })], "");
    saveSession("agent1", [], "");
    expect(setFor(readSession(), "agent1")).toBeNull();
  });
});

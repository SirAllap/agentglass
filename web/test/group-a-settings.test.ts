/*
 * Settings added for the Notifications and Sidebar pages: the volume (quiet,
 * normal, loud) over two switches that already existed, and the count badge on
 * the three rail icons that carry a number. Each is a registry setting an agent
 * can reach, stored the way the old switches were, and read by what draws it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal.ts";
import { classOf } from "../../shared/settingClass.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());

const R = await import("../src/lib/settingsRegistry.ts");
const sys = await import("../src/lib/sysNotify.ts");
const badges = await import("../src/lib/railBadges.ts");
const facts = await import("../src/lib/pageFacts.ts");
const def = (id: string) => R.SETTING_DEFS.find((d) => d.id === id)!;

beforeEach(() => { store.clear(); badges.resetRailBadges(); });

describe("notifications.volume", () => {
  it("is a low-class def on the Notifications page", () => {
    expect(def("notifications.volume").page).toBe("notifications");
    expect(classOf("notifications.volume")?.class).toBe("low");
  });
  it("starts Quiet, as the two switches under it do", () => {
    expect(def("notifications.volume").get()).toBe("quiet");
  });
  it("Normal is quiet off and the app's own notices off; Loud is the same with them on", () => {
    expect(def("notifications.volume").set("normal").ok).toBe(true);
    expect(sys.notifyQuiet()).toBe(false);
    expect(sys.appNotify()).toBe(false);
    expect(def("notifications.volume").get()).toBe("normal");
    expect(def("notifications.volume").set("loud").ok).toBe(true);
    expect(sys.appNotify()).toBe(true);
    expect(def("notifications.volume").get()).toBe("loud");
  });
  it("Quiet wins over the own-notices switch and leaves it as it was", () => {
    def("notifications.volume").set("loud");
    def("notifications.volume").set("quiet");
    expect(sys.notifyQuiet()).toBe(true);
    expect(sys.appNotify()).toBe(true);
    expect(def("notifications.volume").get()).toBe("quiet");
  });
  it("the older quiet door still moves the same state", () => {
    def("notifications.volume").set("normal");
    expect(def("notifications.quiet").set(true).ok).toBe(true);
    expect(def("notifications.volume").get()).toBe("quiet");
  });
  it("refuses a word that is not a level", () => {
    for (const bad of ["silent", "", 1, true]) expect(def("notifications.volume").set(bad as never).ok).toBe(false);
  });
});

describe("rail count badges", () => {
  it("one def per view that wears a count, and no other", () => {
    expect(Object.keys(badges.COUNTED_VIEWS).sort()).toEqual(["lantern", "tasks"]);
    for (const id of Object.keys(badges.COUNTED_VIEWS)) {
      expect(def(`rail.badge.${id}`).page).toBe("rail");
      expect(def(`rail.badge.${id}`).get()).toBe(true);
    }
    expect(R.SETTING_DEFS.some((d) => d.id === "rail.badge.git")).toBe(false);
    expect(classOf("rail.badge.lantern")?.class).toBe("low");
  });
  it("turning one off hides that view's count and no other", () => {
    expect(def("rail.badge.lantern").set(false).ok).toBe(true);
    expect(badges.railBadgeOn("lantern")).toBe(false);
    expect(badges.railBadgeOn("tasks")).toBe(true);
    const shown = badges.visiblePips({ tasks: { count: 2 }, lantern: { count: 3 } });
    expect(shown.tasks).toEqual({ count: 2 });
    expect(shown.lantern).toEqual({});
    expect(badges.railBadgesCustomised()).toBe(true);
  });
  it("is remembered, and Reset puts every count back", () => {
    def("rail.badge.tasks").set(false);
    expect(store.get("agentglass.railBadgesOff")).toBe('["tasks"]');
    badges.resetRailBadges();
    expect(badges.railBadgeOn("tasks")).toBe(true);
    expect(store.has("agentglass.railBadgesOff")).toBe(false);
  });
  it("the rail draws what visiblePips lets through", () => {
    const ws = readFileSync(new URL("../src/components/workspace/Workspace.tsx", import.meta.url), "utf8");
    expect(ws).toContain("pips={visiblePips(pips)}");
  });
});

describe("header chips from a page's own facts", () => {
  const on = [{ tone: "ok" as const, text: "On" }];
  it("the volume names the Notifications chip", () => {
    expect(facts.pageChips("notifications", on, { volume: "Loud" })[0]!.text).toBe("Loud volume");
    expect(facts.pageChips("notifications", on, {})[0]!.text).toBe("On");
  });
  it("tmux says its version, Tasks its sources, Terminal what is unsaved, Browser what can come in", () => {
    expect(facts.pageChips("tmux", [{ tone: "ok", text: "tmux ready" }], { tmuxVersion: "3.4" })[0]!.text).toBe("tmux 3.4");
    expect(facts.pageChips("tasks", [], { taskSources: 3 })[0]!.text).toBe("3 on the board");
    expect(facts.pageChips("tasks", [], { taskSources: 1 })[0]!.text).toBe("1 on the board");
    expect(facts.pageChips("terminal", [], { unsavedRules: 1 })[0]).toEqual({ tone: "warn", text: "1 unsaved" });
    expect(facts.pageChips("terminal", [], { unsavedRules: 0 })).toEqual([]);
    expect(facts.pageChips("browser", [], { importableSites: 12 })[0]!.text).toBe("12 sites to bring in");
  });
  it("a page with nothing to add keeps the nav's chips", () => {
    expect(facts.pageChips("diff", on, { volume: "Loud" })).toEqual(on);
  });
});

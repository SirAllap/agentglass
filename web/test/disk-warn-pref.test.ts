/*
 * "Warn when free disk is under N %": the store, the def an agent reaches it
 * through, the row that draws it, and the rule that picks the mounts the machine
 * panel's badge names.
 *
 * The badge decides on one number per mount (free / size), so the boundary is the
 * thing to hold: exactly N % free is not under N, and off names nothing.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());

const P = await import("../src/lib/diskWarnPref.ts");
const R = await import("../src/lib/settingsRegistry.ts");
const { classOf } = await import("../../shared/settingClass.ts");
const { SETTINGS_ROWS } = await import("../src/lib/settingsRows.gen.ts");

const KEY = "agentglass.disk.warnPct";
const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const def = () => R.SETTING_DEFS.find((d) => d.id === "prefs.diskWarn")!;

beforeEach(() => { store.clear(); });
afterAll(() => { store.clear(); });

describe("the store", () => {
  it("is 10 until somebody chooses, and a choice is kept", () => {
    expect(P.diskWarnPct()).toBe(10);
    for (const n of [0, 5, 15, 20, 10]) { P.setDiskWarnPct(n); expect(P.diskWarnPct()).toBe(n); }
  });

  it("off survives as off and is not mistaken for 'unset'", () => {
    P.setDiskWarnPct(0);
    expect(store.get(KEY)).toBe("0");
    expect(P.diskWarnPct()).toBe(0);
  });

  it("a stored value that is not one of the offered ones reads as the default", () => {
    for (const bad of ["7", "-5", "abc", "", "100"]) { store.set(KEY, bad); expect(P.diskWarnPct(), bad).toBe(10); }
  });

  it("offers exactly off, 5, 10, 15 and 20, and the default is among them", () => {
    expect([...P.DISK_WARN_CHOICES]).toEqual([0, 5, 10, 15, 20]);
    expect(P.DISK_WARN_CHOICES).toContain(P.DISK_WARN_DEFAULT);
  });
});

describe("which mounts the badge names", () => {
  const GB = 1e9;
  const mount = (name: string, size: number, free: number) => ({ mount: name, size, free });
  const rootFs = mount("/", 100 * GB, 9 * GB);
  const data = mount("/data", 100 * GB, 40 * GB);

  it("names a mount with less than N % free, on any mount", () => {
    expect(P.lowDiskMounts([rootFs, data], 10).map((m) => m.mount)).toEqual(["/"]);
    expect(P.lowDiskMounts([data, rootFs], 10).map((m) => m.mount)).toEqual(["/"]);
  });

  it("exactly N % free is not under N", () => {
    expect(P.lowDiskMounts([mount("/", 100 * GB, 10 * GB)], 10)).toEqual([]);
    expect(P.lowDiskMounts([mount("/", 100 * GB, 10 * GB - 1)], 10).length).toBe(1);
  });

  it("off names none, however full", () => {
    expect(P.lowDiskMounts([mount("/", 100 * GB, 0)], 0)).toEqual([]);
  });

  it("a mount that reports no size is never named", () => {
    expect(P.lowDiskMounts([mount("/proc", 0, 0)], 20)).toEqual([]);
    expect(P.freePct(mount("/proc", 0, 0))).toBeNull();
  });

  it("a higher threshold names more mounts", () => {
    const m = mount("/", 100 * GB, 18 * GB);
    expect(P.lowDiskMounts([m], 15)).toEqual([]);
    expect(P.lowDiskMounts([m], 20).length).toBe(1);
  });
});

describe("the def an agent reaches it through", () => {
  it("is a level 2 low-class setting on Window & startup, a number that defaults to 10", () => {
    expect(def().page).toBe("prefs");
    expect(def().section).toBe("Disk space");
    expect(def().level).toBe(2);
    expect(def().default).toBe(10);
    expect(def().type).toBe("number");
    expect(classOf("prefs.diskWarn")?.class).toBe("low");
  });

  it("settings.get and settings.list answer with the value and its words", () => {
    expect(R.settings.get("prefs.diskWarn")).toEqual({ ok: true, id: "prefs.diskWarn", value: 10, display: "under 10 % free" });
    const row = R.settings.list().find((r) => r.id === "prefs.diskWarn")!;
    expect(row).toMatchObject({ writable: true, secret: false, class: "low", value: 10, type: "number" });
    R.settings.set("prefs.diskWarn", 0, "tester");
    expect(R.settings.get("prefs.diskWarn")).toMatchObject({ value: 0, display: "off" });
  });

  it("settings.set stores what the pref module's own setter stores, and leaves an undo", () => {
    store.clear();
    P.setDiskWarnPct(15);
    const viaSetter = JSON.stringify([...store]);
    store.clear();
    const r = R.settings.set("prefs.diskWarn", 15, "tester");
    expect(r).toMatchObject({ ok: true, prev: 10, value: 15 });
    expect(JSON.stringify([...store])).toBe(viaSetter);
    expect(R.settings.undo((r as { undo: string }).undo)).toBe(true);
    expect(P.diskWarnPct()).toBe(10);
  });

  it("takes the word 'off' for 0, and only the offered numbers", () => {
    expect(R.settings.set("prefs.diskWarn", "off", "tester")).toMatchObject({ ok: true, value: 0 });
    for (const bad of [7, -1, 100, 12.5, "15", "ten", true, null]) {
      const r = R.settings.set("prefs.diskWarn", bad, "tester");
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.error).toContain("accepted: one of 0 (off), 5, 10, 15, 20");
    }
    expect(P.diskWarnPct()).toBe(0);
  });
});

describe("the row that draws it", () => {
  it("is in the generated index, on Window & startup, bound to the def", () => {
    const row = SETTINGS_ROWS.find((r) => r.settingId === "prefs.diskWarn")!;
    expect(row).toMatchObject({ pane: "prefs", section: "Disk space", label: "Warn when free disk is under" });
    expect(R.isMigrated("prefs", "Disk space")).toBe(true);
  });

  it("only that section of the page is migrated: the display size and start at login are the window's own", () => {
    expect(R.MIGRATED.prefs).toEqual(["Disk space"]);
    expect(R.isMigrated("prefs", "Size and startup")).toBe(false);
  });

  it("the row writes through the def and re-reads when an agent changes it", async () => {
    const src = await read("components/SettingsModal.tsx");
    expect(src).toContain('setting("prefs.diskWarn").set(');
    expect(src).toContain("useSyncExternalStore(subscribeSettings, diskWarnPct");
    expect(src).toContain("DISK_WARN_CHOICES.map(");
  });

  it("the window's prefs reader says what the setting is, so settings.prefs shows it", async () => {
    const { readPrefs } = await import("../src/lib/paneState.ts");
    P.setDiskWarnPct(20);
    expect(readPrefs().diskWarnPct).toBe(20);
  });
});

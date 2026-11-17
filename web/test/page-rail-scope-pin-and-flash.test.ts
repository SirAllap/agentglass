import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cancelPendingFlash, hasPendingFlash, jumpToSection } from "../src/components/settings/shell/PageRail.tsx";
import { api } from "../src/lib/api.ts";
import { resetScannedRepos, scannedReposOnce } from "../src/components/settings/scope/useScope.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/** A scroll box with one listener slot per type, and sections that sit 800px down (so a jump moves it). */
function fakeBox() {
  const listeners = new Map<string, Set<() => void>>();
  const box = {
    scrollTop: 0, scrollHeight: 4000, clientHeight: 600, parentElement: null,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (t: string, fn: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: () => void) => { listeners.get(t)?.delete(fn); },
    fire(t: string) { for (const fn of [...(listeners.get(t) ?? [])]) { listeners.get(t)!.delete(fn); fn(); } },
    count: (t: string) => listeners.get(t)?.size ?? 0,
  };
  const flashed: string[] = [];
  const section = (id: string) => ({
    tagName: "SECTION", parentElement: box, querySelector: () => null,
    getBoundingClientRect: () => ({ top: 800 }),
    scrollIntoView() {}, removeAttribute() {}, offsetWidth: 0,
    setAttribute(name: string) { if (name === "data-rail-flash") flashed.push(id); },
    addEventListener() {},
  });
  const sections: Record<string, ReturnType<typeof section>> = { a: section("a"), b: section("b") };
  const root = { querySelector: (sel: string) => sections[/data-section="(\w+)"/.exec(sel)![1]] ?? null };
  return { box, root, flashed };
}

const g = globalThis as Record<string, unknown>;
const saved = { CSS: g.CSS, getComputedStyle: g.getComputedStyle };
afterEach(() => { cancelPendingFlash(); g.CSS = saved.CSS; g.getComputedStyle = saved.getComputedStyle; resetScannedRepos(); });

describe("a cut-off jump does not flash", () => {
  test("a second jump drops the first one's scrollend; only the landed section flashes", () => {
    const { box, root, flashed } = fakeBox();
    g.CSS = { escape: (s: string) => s };
    g.getComputedStyle = (el: unknown) => ({ overflowY: el === box ? "auto" : "visible", scrollMarginTop: "0" });
    jumpToSection(root as unknown as HTMLElement, "a");
    expect(box.count("scrollend")).toBe(1);
    jumpToSection(root as unknown as HTMLElement, "b");
    expect(box.count("scrollend")).toBe(1);
    box.fire("scrollend");
    expect(flashed).toEqual(["b"]);
    expect(hasPendingFlash()).toBe(false);
  });
});

describe("a scope switch releases the rail's pin", () => {
  test("the scroll-spy effect keys on the scope too, and every scoped page passes it", () => {
    const rail = src("components/settings/shell/PageRail.tsx");
    expect(rail).toContain("}, [listKey, scrollRoot, scopeKey]);");
    const page = src("components/settings/shell/SettingsPage.tsx");
    expect(page.match(/scopeKey=\{scopeKey\}/g)?.length).toBe(2);
    for (const [f, key] of [["FlightPlanPage", "root"], ["FlowReviewPage", "p.root"], ["PolarisPage", "sc.root"], ["PermissionsPage", "root"]]) {
      expect(src(`components/settings/pages/${f}.tsx`)).toContain(`scopeKey={${key}}`);
    }
  });
});

describe("the project menu's repo sweep", () => {
  test("runs scan=1 once per app session, and again only after a failure", async () => {
    const real = api.gitReposAll;
    let calls = 0;
    let fail = true;
    (api as { gitReposAll: unknown }).gitReposAll = (scan = false) => {
      calls++;
      expect(scan).toBe(true);
      return fail ? Promise.reject(new Error("down")) : Promise.resolve({ repos: [], hidden: [] });
    };
    try {
      await expect(scannedReposOnce()).rejects.toThrow("down");
      fail = false;
      await scannedReposOnce();
      await scannedReposOnce();
      expect(calls).toBe(2);
    } finally {
      (api as { gitReposAll: unknown }).gitReposAll = real;
    }
  });
});

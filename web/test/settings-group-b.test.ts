/*
 * The settings added with the Group B pages (Usage, Commands, Tools & services, ClickUp, Jira, Remote,
 * Data & privacy, About): each is held where its behaviour is, not drawn.
 *
 * There is no renderer here, so a rule about source is asserted against source: sliced to the
 * function's own closing, comments stripped before a word is called absent.
 */
import { describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
});

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const modal = await read("components/SettingsModal.tsx");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const fn = (src: string, head: string, next: string) => src.slice(src.indexOf(head), src.indexOf(next, src.indexOf(head)));

describe("About: look for a release by itself", () => {
  test("on until it is switched off, kept in the window", async () => {
    const P = await import("../src/lib/updateCheckPref.ts");
    expect(P.autoCheckUpdates()).toBe(true);
    P.setAutoCheckUpdates(false);
    expect(P.autoCheckUpdates()).toBe(false);
    P.setAutoCheckUpdates(true);
    expect(P.autoCheckUpdates()).toBe(true);
  });

  test("the timer's look reads it before it asks, and the About button does not", async () => {
    const store = code(await read("lib/updateStore.ts"));
    const check = fn(store, "async function check()", "export function startUpdateChecks");
    expect(check.indexOf("autoCheckUpdates()")).toBeGreaterThan(-1);
    expect(check.indexOf("autoCheckUpdates()")).toBeLessThan(check.indexOf("api.updateStatus()"));
    const about = fn(code(modal), "function AboutPane(", "function AboutCredits(");
    expect(about).toContain("const recheck = async () =>");
    expect(about.slice(about.indexOf("const recheck"), about.indexOf("const canInstall"))).not.toContain("autoCheckUpdates");
  });

  test("an agent can read and change it, as the low-class setting it is", async () => {
    const R = await import("../src/lib/settingsRegistry.ts");
    const def = R.SETTING_DEFS.find((d) => d.id === "about.autoCheck");
    expect(def?.page).toBe("about");
    expect(def?.level).toBe(2);
    const { classOf } = await import("../../shared/settingClass.ts");
    expect(classOf("about.autoCheck")?.class).toBe("low");
  });
});

describe("About: the licences are the build's own", () => {
  test("every package that ships has a name, a version and a licence, in order", async () => {
    const { LICENCES } = await import("../src/lib/licences.gen.ts");
    expect(LICENCES.length).toBeGreaterThan(10);
    for (const l of LICENCES) { expect(l.name).toBeTruthy(); expect(l.version).toMatch(/^\d/); expect(l.licence).toBeTruthy(); }
    expect([...LICENCES].map((l) => l.name)).toEqual([...LICENCES].map((l) => l.name).sort((a, b) => a.localeCompare(b)));
  });

});

describe("Data & privacy", () => {
  const pane = code(fn(modal, "function PrivacyPane(", "type ToolsFilter"));
  test("a shorter retention asks first, because it deletes", () => {
    expect(pane).toContain("const shorter = ");
    expect(pane.indexOf("if (shorter(days)) { setAsking(days); return; }")).toBeGreaterThan(-1);
    expect(pane.indexOf("if (shorter(days))")).toBeLessThan(pane.indexOf("api.privacyRetention(days)"));
  });
  test("erasing is two presses, and the second says it is for good", () => {
    expect(pane).toContain('setErasing("ask")');
    expect(pane).toContain("Erase for good");
    expect(pane.indexOf("Erase for good")).toBeLessThan(pane.indexOf("void erase()") + 400);
  });
  test("the update check says what it does: every six hours on the desktop with the timer on, else on request", () => {
    expect(pane).toContain("const timer = IS_DESKTOP && autoCheckUpdates()");
    expect(pane).toContain("Every 6 hours");
    expect(pane).toContain("Only on request");
  });
});

describe("Commands: pinned is the command bar's own pin", () => {
  test("the switch pins through the store the bar reads, five at most", async () => {
    const src = code(await read("components/RecipesPane.tsx"));
    expect(src).toContain("togglePin(pinRoot, `${RECIPE}${r.id}`)");
    expect(src).toContain("MAX_COMMAND_PINS");
    expect(src).toContain("usePinMap()");
  });
});

describe("Usage: the week is drawn from the pace config", () => {
  test("working days and hours decide each bar, and today is marked", () => {
    const week = code(fn(modal, "function WeekBars(", "function PacePane("));
    expect(week).toContain("cfg.workDays[i]");
    expect(week).toContain("cfg.workEnd - cfg.workStart");
    expect(week).toContain("data-today");
  });
});

describe("Engines: Read usage and Plugins: the licence filter", () => {
  test("Read usage is Codex's, only while ready, and runs the one minimal turn before it reads", async () => {
    const src = code(await read("components/engines/EnginesPane.tsx"));
    expect(src).toContain('p.id === "codex" && state === "ready"');
    const read1 = fn(src, "const readUsage = async", "const state = engineState(e);");
    expect(read1.indexOf("api.refreshCodexUsage()")).toBeGreaterThan(-1);
    expect(read1.indexOf("api.refreshCodexUsage()")).toBeLessThan(read1.indexOf("refreshProviderUsage()"));
  });
  test("the market offers a licence select drawn from what the listings state", async () => {
    const m = code(await read("components/plugins/Market.tsx"));
    expect(m).toContain('title="Licence"');
    expect(m).toContain("licencesOn(all)");
    expect(m).toContain("byLicence(byScope(byType, scope), licence)");
  });
});

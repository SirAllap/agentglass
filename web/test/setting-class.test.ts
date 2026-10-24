/*
 * Every setting the window holds has a class (shared/settingClass.ts), and the
 * window applies an escalation only when it narrows or the server granted it.
 *
 * The class table is what the settings door decides with; a def added without a
 * line there would be judged by its level alone, so this is the test that turns
 * that into a red build instead of a silent default.
 */
import { describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { classOf, agentVerdict, NEEDS_APPROVAL, SETTING_CLASSES } from "../../shared/settingClass.ts";

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

const R = await import("../src/lib/settingsRegistry.ts");
type Def = import("../src/lib/settingsRegistry.ts").SettingDef;

/** A def held in memory, with an id of the caller's choosing (the class follows the id). */
const mem = (id: string, start: string): Def & { now: () => string } => {
  let v = start;
  return {
    id, page: "x", section: "", label: id, level: 2, default: "", type: "string", display: R.say, get: () => v, now: () => v,
    validate: (raw) => (typeof raw === "string" ? raw : null),
    set: (raw) => { if (typeof raw !== "string") return { ok: false, error: "bad" }; const prev = v; v = raw; return { ok: true, prev, value: raw, revert: () => { v = prev; } }; },
  };
};

describe("the class table", () => {
  it("names a class for every setting the window holds", () => {
    const missing = R.SETTING_DEFS.map((d) => d.id).filter((id) => !classOf(id));
    expect(missing).toEqual([]);
  });

  it("has no window line that names a setting the window no longer has", () => {
    const window = ["appearance.", "diff.", "terminal.", "rail.", "notifications.", "browser.", "tasks.", "keys.", "plugins.sessionReads.", "clickup.statusSpaces.", "jira.statusUnits."];
    const ids = R.SETTING_DEFS.map((d) => d.id);
    const stale = Object.keys(SETTING_CLASSES)
      .filter((k) => window.some((p) => k.startsWith(p)))
      .filter((k) => (k.includes("*") ? !ids.some((id) => classOf(id) === SETTING_CLASSES[k]) : !ids.includes(k)));
    expect(stale).toEqual([]);
  });

  it("a family's star stands for something, never for nothing", () => {
    expect(classOf("rail.place.")).toBeNull();
    expect(classOf("plugin..enabled")).toBeNull();
    expect(classOf("plugin.acme-notes.enabled")?.class).toBe("escalation");
  });
});

describe("the window's verdict on an agent's change", () => {
  const ID = "plugins.sessionReads.repos";

  it("a widening escalation is answered NEEDS_APPROVAL and nothing changes", () => {
    const d = mem(ID, "acme/orbit");
    const r = R.makeSettings([d]).set(ID, "acme/orbit,acme/helm", "chair");
    expect(r).toEqual({ ok: false, error: NEEDS_APPROVAL });
    expect(d.now()).toBe("acme/orbit");
  });

  it("a narrowing escalation applies at once", () => {
    const d = mem(ID, "acme/orbit,acme/helm");
    expect(R.makeSettings([d]).set(ID, "acme/helm", "chair")).toMatchObject({ ok: true, value: "acme/helm" });
  });

  it("a widening the server granted applies, exactly that value", () => {
    const d = mem(ID, "acme/orbit");
    expect(R.makeSettings([d]).set(ID, "acme/orbit,acme/wiki", "chair", true)).toMatchObject({ ok: true, prev: "acme/orbit", value: "acme/orbit,acme/wiki" });
    expect(d.now()).toBe("acme/orbit,acme/wiki");
  });

  it("a low setting applies without a grant", () => {
    const d = mem("diff.syntaxTheme", "auto");
    expect(R.makeSettings([d]).set("diff.syntaxTheme", "github", "chair").ok).toBe(true);
  });
});

describe("agentVerdict", () => {
  it("low applies, escalation asks, narrowing applies, trusted lets an escalation through", () => {
    expect(agentVerdict("diff.wrap", false, true, false)).toBe("apply");
    expect(agentVerdict("launch.mode", "default", "bypassPermissions", false)).toBe("ask");
    expect(agentVerdict("launch.mode", "bypassPermissions", "default", false)).toBe("apply");
    expect(agentVerdict("launch.mode", "default", "bypassPermissions", true)).toBe("apply");
  });

  it("the person's switch is never an agent's to turn on, trusted or not; off applies", () => {
    expect(agentVerdict("agents.changeWithoutAsking", false, true, false)).toBe("refuse");
    expect(agentVerdict("agents.changeWithoutAsking", false, true, true)).toBe("refuse");
    expect(agentVerdict("agents.changeWithoutAsking", true, false, true)).toBe("apply");
  });

  it("a secret and an unknown id are refused", () => {
    expect(agentVerdict("jira.token", "", "x", true)).toBe("refuse");
    expect(agentVerdict("acme.unknown", "", "x", true)).toBe("refuse");
  });

  it("narrowing, per setting", () => {
    const n = (id: string, a: unknown, b: unknown) => classOf(id)!.narrows?.(a, b) ?? false;
    expect(n("launch.deny", ["Bash(rm:*)"], ["Bash(rm:*)", "Bash(curl:*)"])).toBe(true);
    expect(n("launch.deny", ["Bash(rm:*)", "Bash(curl:*)"], ["Bash(rm:*)"])).toBe(false);
    expect(n("seat.powers", "assign", "speak")).toBe(true);
    expect(n("seat.powers", "speak", "nudge")).toBe(false);
    expect(n("hooks.gate", false, true)).toBe(true);
    expect(n("hooks.gate", true, false)).toBe(false);
    expect(n("plugins.master", true, false)).toBe(true);
    expect(n("lantern.watchMinutes", 30, 60)).toBe(true);
    expect(n("lantern.watchMinutes", 60, 30)).toBe(false);
    expect(n("seat.wakeHours", 4, 8)).toBe(true);
    const b = (limit: number, model = "") => ({ root: "", model, period: "day", limit });
    expect(n("budgets", [b(20)], [b(10)])).toBe(true);
    expect(n("budgets", [b(20)], [b(10), b(5, "claude-opus")])).toBe(true);
    expect(n("budgets", [b(20)], [b(30)])).toBe(false);
    expect(n("budgets", [b(20)], [])).toBe(false);
    expect(n("seat.model", "a", "b")).toBe(false);
    expect(n("orchestration.policy", {}, {})).toBe(false);
  });
});

describe("what a class row says it is for", () => {
  it("the volume row does not borrow the quiet row's reason: volume can also be raised, and is low because it widens nothing an agent may do", () => {
    const why = classOf("notifications.volume")!.why;
    expect(why).not.toBe(classOf("notifications.quiet")!.why);
    expect(why).toContain("loud");
  });
});

describe("the desktop bridge's doc comments", () => {
  it("setWindowZoom's comment sits on setWindowZoom, not on the translucency helpers inserted above it", async () => {
    const src = await Bun.file(new URL("../src/lib/desktop.ts", import.meta.url)).text();
    const doc = src.indexOf("Resolves to the factor applied");
    const fn = src.indexOf("export async function setWindowZoom(");
    const between = src.slice(src.indexOf("*/", doc), fn);
    expect(doc).toBeGreaterThan(0);
    expect(between).not.toContain("export ");
  });
});

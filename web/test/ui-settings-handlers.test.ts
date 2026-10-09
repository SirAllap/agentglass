/*
 * settings.get / settings.list / settings.set as a window runs them.
 *
 * The window has no way to send an answer back until /control/result exists, so
 * `runControl` hands the answer to an `onResult` callback; these tests are what
 * that seam must keep doing. A change from a frame is the same change a row
 * makes: it lands in the pref store and leaves a chip.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { ControlCmd } from "../../shared/types.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());
// settings.list reads every def, the appearance ones off the root element.
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });

const { controlReply } = await import("../src/lib/uiActions.ts");
const { settings, shownChange } = await import("../src/lib/settingsRegistry.ts");

const noCtx = {} as never;
const ui = (id: string, args: Record<string, unknown> = {}) => ({ cmd: "ui", do: id, args }) as unknown as ControlCmd;
const run = (c: ControlCmd) => controlReply(c, noCtx);

beforeEach(() => { store.clear(); for (const c of settings.changes()) settings.dismiss(c.handle); });

describe("settings.set from a frame", () => {
  it("changes the setting the row would, answers with what it replaced, and leaves a chip", () => {
    const r = run(ui("settings.set", { id: "diff.wrap", value: true }));
    expect(store.get("agentglass.diff.wrap")).toBe("1");
    expect(r).toMatchObject({ ok: true, applied: true, value: { ok: true, id: "diff.wrap", prev: false, value: true, undo: expect.any(String) } });
    expect(shownChange(settings.changes())?.id).toBe("diff.wrap");
  });

  it("an invalid value, or a setting that is not exposed, is not applied and shows no chip", () => {
    for (const c of [ui("settings.set", { id: "terminal.fontSize", value: 99 }), ui("settings.set", { id: "notifications.sound", value: true })]) {
      expect(run(c)).toEqual({ ok: false, applied: false, error: expect.any(String) });
    }
    expect(store.size).toBe(0);
    expect(shownChange(settings.changes())).toBeNull();
  });

  it("the undo handle in the answer takes it back", () => {
    const undo = (run(ui("settings.set", { id: "terminal.cursor", value: "bar" })).value as { undo: string }).undo;
    expect(settings.get("terminal.cursor")).toMatchObject({ value: "bar" });
    expect(settings.undo(undo)).toBe(true);
    expect(settings.get("terminal.cursor")).toMatchObject({ value: "block" });
  });

  it("a write of the value it already has is applied and has nothing to undo", () => {
    const r = run(ui("settings.set", { id: "diff.wrap", value: false }));
    expect(r).toMatchObject({ ok: true, applied: true, value: { unchanged: true, undo: "" } });
    expect(shownChange(settings.changes())).toBeNull();
  });
});

describe("settings.get and settings.list", () => {
  it("answer with the stored value and the exposed list", () => {
    store.set("agentglass-term-size", "17");
    expect(run(ui("settings.get", { id: "terminal.fontSize" }))).toEqual({ ok: true, applied: true, value: { ok: true, id: "terminal.fontSize", value: 17, display: "17" } });
    const list = run(ui("settings.list")).value as { id: string }[];
    expect(list.some((x) => x.id === "diff.wrap")).toBe(true);
  });

  it("a setting that is not exposed is a refusal, not an answer", () => {
    expect(run(ui("settings.get", { id: "notifications.sound" }))).toEqual({ ok: false, applied: false, error: "not exposed" });
  });

  it("a read has no side effect: no chip, nothing stored", () => {
    run(ui("settings.get", { id: "diff.wrap" }));
    run(ui("settings.list"));
    expect(store.size).toBe(0);
    expect(shownChange(settings.changes())).toBeNull();
  });
});

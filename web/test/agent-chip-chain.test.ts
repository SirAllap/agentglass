/*
 * A burst of changes by one agent left one chip per change, one after another.
 *
 * Measured: twelve theme changes in twenty seconds, and the chip was still up
 * four and a half minutes later — each dismissed chip showed the previous one
 * for a fresh minute, and Undo on an old one put back an old value. Two rules
 * now: a newer write to a setting retires the older chips for that setting,
 * and a chip's minute counts from the change.
 */
import { describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
stubGlobal("location", { origin: "http://127.0.0.1:1", hostname: "127.0.0.1", search: "", href: "http://127.0.0.1:1/" });
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 });
stubGlobal("window", new EventTarget());

const { chipLeftMs, CHIP_MS } = await import("../src/lib/quietPresent.ts");
const { makeSettings, shownChange } = await import("../src/lib/settingsRegistry.ts");
type SettingDef = import("../src/lib/settingsRegistry.ts").SettingDef;

const mem = (id: string): SettingDef => {
  let v = "a";
  return {
    id, page: "t", section: "t", label: id, level: 1, default: "a", type: "string", validate: (r: unknown) => (typeof r === "string" ? r : null),
    get: () => v, display: (x: unknown) => String(x),
    set: (raw: unknown) => { const prev = v; v = String(raw); return { ok: true, prev, value: v, revert: () => { v = prev; } }; },
  } as unknown as SettingDef;
};

describe("the chip chain", () => {
  it("keeps one chip per setting after a burst, the newest", () => {
    const s = makeSettings([mem("x.one"), mem("x.two")]);
    for (const v of ["b", "c", "d", "e"]) s.set("x.one", v, "agent");
    s.set("x.two", "z", "agent");
    const shown = s.changes().filter((c) => c.shown);
    expect(shown.map((c) => [c.id, c.value])).toEqual([["x.one", "e"], ["x.two", "z"]]);
  });

  it("undoing the newest does not offer a stale undo of the same setting", () => {
    const s = makeSettings([mem("x.one")]);
    s.set("x.one", "b", "agent");
    const r = s.set("x.one", "c", "agent");
    if (!r.ok) throw new Error("set failed");
    s.undo(r.undo);
    expect(shownChange(s.changes())).toBeNull();
  });

  it("counts a chip's minute from the change", () => {
    expect(chipLeftMs(1_000, 1_000)).toBe(CHIP_MS);
    expect(chipLeftMs(1_000, 1_000 + CHIP_MS - 5)).toBe(5);
    expect(chipLeftMs(1_000, 1_000 + 4 * CHIP_MS)).toBe(0);
  });

  it("the chip arms its timer from that, not from a full minute", async () => {
    const chip = await Bun.file(new URL("../src/components/AgentChangeChip.tsx", import.meta.url)).text();
    expect(chip).toContain("chipLeftMs(changedAt, Date.now())");
    expect(chip).not.toContain("settings.dismiss(handle), CHIP_MS)");
  });
});

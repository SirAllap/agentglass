/*
 * What the Terminal strip shows, left to right: the project chip, the tabs of
 * the project you are in and of the projects kept open (each kept one under its
 * own label), the numbers Alt and the prefix reveal, and how many windows need
 * you. Pure decisions over the windows tmux reported; the strip only draws them.
 */
import { describe, expect, test } from "bun:test";
import type { TmuxWindow } from "../../shared/types.ts";
import { buildGroups } from "../src/lib/tabGroups.ts";
import { stripZones } from "../src/lib/stripZones.ts";

const win = (index: number, name: string, repo: string, over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  id: `@${index}`, index, name, active: false, flags: "", repo: `/home/dev/code/${repo}`, ...over,
});

// orbit 3, billing 2, platform 1: three projects, tmux order interleaved.
const fleet = [
  win(1, "api", "orbit"), win(2, "invoices", "billing"), win(3, "web", "orbit"),
  win(4, "infra", "platform"), win(5, "ledger", "billing"), win(6, "docs", "orbit", { status: "waiting" }),
];
const zones = (over: Partial<Parameters<typeof stripZones>[0]> = {}) =>
  stripZones({ groups: buildGroups(fleet, []), current: "orbit", kept: new Set(), ...over });
const names = (z: ReturnType<typeof zones>) => z.items.map((i) => (i.kind === "tab" ? i.window.name : `[${i.name}]`));

describe("project chip", () => {
  test("names the current project and counts its windows", () => {
    expect(zones().chip).toEqual({ key: "orbit", name: "orbit", count: 3, locked: false });
  });
  test("carries the session lock", () => {
    expect(zones({ locked: true }).chip!.locked).toBe(true);
  });
  test("an unknown current project falls back to the first group instead of an empty strip", () => {
    expect(zones({ current: "nope" }).chip!.key).toBe("orbit");
  });
  test("no windows, no chip", () => {
    const z = stripZones({ groups: [], current: null, kept: new Set() });
    expect(z.chip).toBeNull();
    expect(z.items).toEqual([]);
  });
});

describe("tabs", () => {
  test("only the current project's windows, in strip order, with no label", () => {
    const z = zones();
    expect(names(z)).toEqual(["api", "web", "docs"]);
    expect(z.flat).toBe(false);
  });
  test("a kept project shows under its label, in group order", () => {
    expect(names(zones({ kept: new Set(["billing"]) }))).toEqual(["api", "web", "docs", "[billing]", "invoices", "ledger"]);
  });
  test("a kept project that comes first sits first, the current one in place", () => {
    const z = zones({ current: "billing", kept: new Set(["orbit"]) });
    expect(names(z)).toEqual(["[orbit]", "api", "web", "docs", "invoices", "ledger"]);
  });
  test("a kept key that is also the current project is not labelled twice", () => {
    expect(names(zones({ kept: new Set(["orbit"]) }))).toEqual(["api", "web", "docs"]);
  });
  test("a kept key with no windows draws nothing", () => {
    expect(names(zones({ kept: new Set(["ghost"]) }))).toEqual(["api", "web", "docs"]);
  });
  test("every tab says which project it belongs to", () => {
    const tabs = zones({ kept: new Set(["billing"]) }).items.flatMap((i) => (i.kind === "tab" ? [i.project] : []));
    expect(tabs).toEqual(["orbit", "orbit", "orbit", "billing", "billing"]);
  });
});

describe("flat form", () => {
  const one = [win(1, "bash", "orbit"), win(2, "tests", "orbit")];
  test("one project: flat, no label even if it is listed as kept", () => {
    const z = stripZones({ groups: buildGroups(one, []), current: "orbit", kept: new Set(["orbit"]) });
    expect(z.flat).toBe(true);
    expect(names(z)).toEqual(["bash", "tests"]);
  });
  test("two projects: not flat, even with nothing kept", () => {
    expect(zones().flat).toBe(false);
  });
});

describe("numbers", () => {
  const many = Array.from({ length: 12 }, (_, i) => win(i + 1, `w${i + 1}`, "orbit"));
  test("the first nine tabs, in strip order, from 1", () => {
    const z = stripZones({ groups: buildGroups(many, []), current: "orbit", kept: new Set() });
    expect([...z.numbers.entries()]).toEqual(Array.from({ length: 9 }, (_, i) => [`@${i + 1}`, i + 1]));
    const tabs = z.items.flatMap((i) => (i.kind === "tab" ? [i] : []));
    expect(tabs.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null]);
  });
  test("a window folded out of the strip has no number, so the key cannot point at it", () => {
    const z = zones();
    expect(z.numbers.has("@2")).toBe(false);
    expect(z.numbers.get("@6")).toBe(3);
  });
  test("labels take no number", () => {
    expect(zones({ kept: new Set(["billing"]) }).numbers.get("@2")).toBe(4);
  });
});

describe("need-you count", () => {
  test("counts blocked windows in every project, shown or folded", () => {
    const fl = [...fleet, win(7, "pay", "billing", { status: "waiting" }), win(8, "x", "platform", { status: "error" })];
    expect(stripZones({ groups: buildGroups(fl, []), current: "orbit", kept: new Set() }).needYou).toBe(2);
  });
  test("zero when nothing waits", () => {
    expect(stripZones({ groups: buildGroups([win(1, "a", "orbit", { status: "working" })], []), current: "orbit", kept: new Set() }).needYou).toBe(0);
  });
});

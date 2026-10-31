/*
 * Every pin is in every menu, grouped by repository, so there is no per-pin
 * "show everywhere" switch: it was a filter on a list that no longer filters.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);

const load = async () =>
  (await import(`../src/lib/prPins.ts?t=${Math.random()}`)) as typeof import("../src/lib/prPins.ts");

const R = "orbit/web";
beforeEach(() => store.clear());

describe("pins", () => {
  it("a full list drops the oldest pin", async () => {
    const m = await load();
    for (let n = 1; n <= m.PIN_MAX; n++) m.togglePin(R, n, `pin ${n}`, n);
    expect(m.pins()).toHaveLength(m.PIN_MAX);
    m.togglePin(R, 99, "one more", 99);
    const numbers = m.pins().map((p) => p.number);
    expect(numbers).toHaveLength(m.PIN_MAX);
    expect(numbers).not.toContain(1);
    expect(numbers).toContain(99);
  });

  it("a pin stored by the version that had the everywhere flag still loads", async () => {
    store.set("agentglass.pr.pins", JSON.stringify([{ repo: R, number: 7, title: "old", at: 1, global: true }]));
    expect((await load()).pins().map((p) => p.number)).toEqual([7]);
  });
});

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const list = code(await Bun.file(new URL("../src/components/PinList.tsx", import.meta.url)).text());
const menu = (() => {
  const a = panel.indexOf("function PinMenu(");
  return code(panel.slice(a, panel.indexOf("\n}\n", a)));
})();

describe("the pin menu in the panel", () => {
  it("lists every pin through termPins, like the terminal menu", () => {
    expect(code(panel)).toContain("termPins(allPins, repo?.nameWithOwner)");
  });

  it("a foreign pin opens through the jump, a local one in place", () => {
    const a = panel.indexOf("const openPin = useCallback(");
    expect(a).toBeGreaterThan(0);
    const fn = code(panel.slice(a, panel.indexOf("}, [repo, openPr]);", a)));
    expect(fn).toContain("openPr(p.number)");
    expect(fn).toContain("requestPrJump(p.repo, p.number)");
  });

  it("the state is keyed by repo#number and each repository is a group under its own name", () => {
    expect(menu).toContain("pinState.get(`${p.repo}#${p.number}`)");
    expect(list).toContain("states[key]");
    expect(list).toContain("{g.repo}</span>");
  });

  it("no row, no header and no door carries an everywhere switch", () => {
    for (const s of [list, code(panel)]) {
      expect(s).not.toContain("setPinGlobal");
      expect(s).not.toContain("PinEverywhereIcon");
      expect(s).not.toContain("canGlobal");
    }
  });
});

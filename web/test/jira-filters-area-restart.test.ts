/* A board opened from the left bar (an epic, a tab, Assigned to me): a filter set on it comes back after a restart, and a filter
   on one epic never shows on another. The hook is mounted alone and the storage it reads is the one it wrote. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useJiraFilterState } from "../src/components/jira/list/useJiraFilterState.ts";
import { ASSIGNED_VIEW_ID } from "../../shared/providers.ts";

const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
let saved: unknown;
const g = globalThis as { window?: unknown; document?: unknown };
beforeAll(() => { g.document = { activeElement: null, body: null }; g.window = { HTMLIFrameElement: class {}, event: undefined, addEventListener() {}, removeEventListener() {} }; saved = (globalThis as { localStorage?: unknown }).localStorage; (globalThis as { localStorage?: unknown }).localStorage = fakeStorage; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete g.window; delete g.document; (globalThis as { localStorage?: unknown }).localStorage = saved; });

type State = ReturnType<typeof useJiraFilterState>;
const BOARD = "scope:ORBIT|e:";
function boot() {
  let now: State | undefined;
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, addEventListener() {}, removeEventListener() {}, ownerDocument: { nodeType: 9, addEventListener() {}, removeEventListener() {} } } as unknown as Element;
  const root = createRoot(container);
  function Probe({ v, a }: { v: string | null; a: string | null }) { now = useJiraFilterState({ viewId: v, areaId: a, onSelect: () => {}, favourites: [] }); return null; }
  return { show: (v: string | null, a: string | null = null) => act(async () => { root.render(createElement(Probe, { v, a })); }), get: () => now!, close: () => act(async () => { root.unmount(); }) };
}

describe("filters on a board from the left bar survive a restart", () => {
  test("an epic: back after a restart, and not on another epic", async () => {
    store.clear();
    const a = boot();
    await a.show("scope:ORBIT", "ORBIT-1");
    await act(async () => { a.get().applyFilters({ statusPick: ["In Progress"] }); });
    await a.show("scope:ORBIT", "ORBIT-2");
    expect(a.get().filters.statusPick).toEqual([]);
    await act(async () => { a.get().applyFilters({ tagPick: ["backend"] }); });
    await a.show("scope:ORBIT", "ORBIT-1");
    expect(a.get().filters.statusPick).toEqual(["In Progress"]);
    expect(a.get().filters.tagPick).toEqual([]);
    await a.close();
    const b = boot();
    await b.show("scope:ORBIT", "ORBIT-1");
    expect(b.get().filters.statusPick).toEqual(["In Progress"]);
    await b.show("scope:ORBIT", "ORBIT-2");
    expect(b.get().filters.tagPick).toEqual(["backend"]);
    expect(b.get().filters.statusPick).toEqual([]);
    await b.close();
  });
  test("an epic scope id: back after a restart", async () => {
    store.clear();
    const a = boot();
    await a.show(BOARD + "ORBIT-1", null);
    await act(async () => { a.get().applyFilters({ statusPick: ["Done"] }); });
    await a.close();
    const b = boot();
    await b.show(BOARD + "ORBIT-1", null);
    expect(b.get().filters.statusPick).toEqual(["Done"]);
    await b.close();
  });
  test("a tab: back after a restart once the tab is lit", async () => {
    store.clear();
    const a = boot();
    await a.show("scope:ORBIT");
    await act(async () => { a.get().pickTab(a.get().named[0]!.id); });
    await act(async () => { a.get().applyFilters({ statusPick: ["In Progress"] }); });
    await a.close();
    const b = boot();
    await b.show("scope:ORBIT");
    await act(async () => { b.get().pickTab(b.get().named[0]!.id); });
    expect(b.get().filters.statusPick).toEqual(["In Progress"]);
    await b.close();
  });
  test("the me view: back after a restart", async () => {
    store.clear();
    const a = boot();
    await a.show(ASSIGNED_VIEW_ID);
    await act(async () => { a.get().applyFilters({ statusPick: ["In Progress"] }); });
    await a.close();
    const b = boot();
    await b.show(ASSIGNED_VIEW_ID);
    expect(b.get().filters.statusPick).toEqual(["In Progress"]);
    await b.close();
  });
});

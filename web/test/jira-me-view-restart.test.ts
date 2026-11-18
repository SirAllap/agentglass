/* A restart end to end at the state level: "Assigned to me" with a filter on, the app closed, the app opened again. The hook is
   mounted as the screen mounts it (the site's view id arrives after the first render) and the storage it reads is the one it wrote. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useJiraFilterState } from "../src/components/jira/list/useJiraFilterState.ts";
import { ASSIGNED_VIEW_ID } from "../../shared/providers.ts";

const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
let saved: unknown;
const g = globalThis as { window?: unknown; document?: unknown };
beforeAll(() => { g.document = { activeElement: null, body: null }; g.window = { HTMLIFrameElement: class {}, event: undefined, addEventListener() {}, removeEventListener() {} }; saved = (globalThis as { localStorage?: unknown }).localStorage; (globalThis as { localStorage?: unknown }).localStorage = fakeStorage; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete g.window; delete g.document; (globalThis as { localStorage?: unknown }).localStorage = saved; });

const AREA: { v: string | null } = { v: null };
type State = ReturnType<typeof useJiraFilterState>;
function boot() {
  let now: State | undefined;
  let viewId: string | null = null;
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, addEventListener() {}, removeEventListener() {}, ownerDocument: { nodeType: 9, addEventListener() {}, removeEventListener() {} } } as unknown as Element;
  const root = createRoot(container);
  function Probe({ id }: { id: string | null }) { now = useJiraFilterState({ viewId: id, areaId: AREA.v, onSelect: () => {}, favourites: [] }); return null; }
  const show = (id: string | null) => { viewId = id; return act(async () => { root.render(createElement(Probe, { id })); }); };
  return { show, get: () => now!, view: () => viewId, close: () => act(async () => { root.unmount(); }) };
}


test("me view: query, quick and a toggle come back, Team does not inherit", async () => {
  store.clear();
  const steps = [null, ASSIGNED_VIEW_ID];
  const a = boot();
  for (const id of steps) await a.show(id);
  await act(async () => { a.get().onFilters({ query: "login", quick: ["x"], dueOnly: true } as never); });
  await a.close();
  const b = boot();
  for (const id of steps) await b.show(id);
  expect(b.get().filters.query).toBe("login");
  expect(b.get().filters.dueOnly).toBe(true);
  expect(b.get().filters.quick).toEqual(["x"]);
  await act(async () => { b.get().pickTab("tab:team"); });
  expect(b.get().filters.query).toBe("");
  expect(b.get().filters.dueOnly).toBeFalsy();
  await b.close();
});

for (const [name, first, later] of [["area known at start", "sprints", "sprints"], ["area arrives after the view", null, "sprints"]] as const) {
  test("me view with " + name + ": filters come back", async () => {
    store.clear();
    const run = async (act2: boolean) => {
      AREA.v = first;
      const a = boot();
      await a.show(null); await a.show(ASSIGNED_VIEW_ID);
      if (act2) await act(async () => { a.get().onFilters({ query: "login", dueOnly: true } as never); });
      AREA.v = later; await a.show(ASSIGNED_VIEW_ID);
      return a;
    };
    const a = await run(true); await a.close();
    const b = await run(false);
    expect(b.get().filters.query).toBe("login");
    expect(b.get().filters.dueOnly).toBe(true);
    await b.close();
  });
}

test("me view: a space picked through the toolbar (applyFilters) comes back after a restart", async () => {
  store.clear(); AREA.v = null;
  const steps = [null, ASSIGNED_VIEW_ID];
  const a = boot();
  for (const id of steps) await a.show(id);
  await act(async () => { a.get().applyFilters({ spaces: ["ORBIT"] } as never); });
  expect(a.get().filters.spaces).toEqual(["ORBIT"]);
  await a.close();
  const b = boot();
  for (const id of steps) await b.show(id);
  expect(b.get().filters.spaces).toEqual(["ORBIT"]);
  await b.close();
});

for (const [name, steps] of [["starts on it", [ASSIGNED_VIEW_ID]], ["a site view first", ["jira:space:ORBIT", ASSIGNED_VIEW_ID]], ["lets go of the view while data loads", [ASSIGNED_VIEW_ID, null, ASSIGNED_VIEW_ID]]] as const) {
  test("me view restart, " + name + ": a space comes back", async () => {
    store.clear(); AREA.v = null;
    const a = boot();
    for (const id of steps) await a.show(id);
    await act(async () => { a.get().applyFilters({ spaces: ["ORBIT"] } as never); });
    await a.close();
    const b = boot();
    for (const id of steps) await b.show(id);
    expect(b.get().filters.spaces).toEqual(["ORBIT"]);
    await b.close();
  });
}

for (const [name, first, later] of [["area known at start", "sprints", "sprints"], ["area arrives after the view", null, "sprints"], ["area dropped by the tab", "sprints", null]] as const) {
  test("me view, a space through the toolbar, " + name + ": it comes back", async () => {
    store.clear();
    const run = async (set: boolean) => {
      AREA.v = first;
      const a = boot();
      await a.show(null); await a.show(ASSIGNED_VIEW_ID);
      if (set) await act(async () => { a.get().applyFilters({ spaces: ["ORBIT"] } as never); });
      AREA.v = later; await a.show(ASSIGNED_VIEW_ID);
      return a;
    };
    const a = await run(true); await a.close();
    AREA.v = null;
    const b = await run(false);
    expect(b.get().filters.spaces).toEqual(["ORBIT"]);
    await b.close();
  });
}

test("me view in two panels at once: the hidden one reloading does not wipe what the other kept", async () => {
  store.clear(); AREA.v = null;
  const a = boot(); const b = boot();
  for (const id of [null, ASSIGNED_VIEW_ID]) { await a.show(id); await b.show(id); }
  await act(async () => { a.get().applyFilters({ spaces: ["ORBIT"] } as never); });
  /* the other panel reads its board again: the view lets go for a moment and comes back */
  for (const id of [null, ASSIGNED_VIEW_ID]) await b.show(id);
  await a.close(); await b.close();
  const c = boot();
  for (const id of [null, ASSIGNED_VIEW_ID]) await c.show(id);
  expect(c.get().filters.spaces).toEqual(["ORBIT"]);
  await c.close();
});

test("me view restart with Mine hidden from the strip: the kept space is still applied", async () => {
  store.clear(); AREA.v = null;
  const kept = { spaces: ["ORBIT"], showDone: false };
  store.set("agentglass.jira.viewLayout", JSON.stringify({ order: ["tab:mine", "tab:mine-sprint", "tab:team", "tab:team-sprint"], hidden: ["tab:mine-sprint", "tab:team-sprint", "tab:mine"], filters: {}, kept: { "me:assigned|": kept } }));
  const b = boot();
  for (const id of [null, ASSIGNED_VIEW_ID]) await b.show(id);
  expect(b.get().filters.spaces).toEqual(["ORBIT"]);
  await b.close();
});

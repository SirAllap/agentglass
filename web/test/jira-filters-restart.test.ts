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

type State = ReturnType<typeof useJiraFilterState>;
function boot() {
  let now: State | undefined;
  let viewId: string | null = null;
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, addEventListener() {}, removeEventListener() {}, ownerDocument: { nodeType: 9, addEventListener() {}, removeEventListener() {} } } as unknown as Element;
  const root = createRoot(container);
  function Probe({ id }: { id: string | null }) { now = useJiraFilterState({ viewId: id, areaId: null, onSelect: () => {}, favourites: [] }); return null; }
  const show = (id: string | null) => { viewId = id; return act(async () => { root.render(createElement(Probe, { id })); }); };
  return { show, get: () => now!, view: () => viewId, close: () => act(async () => { root.unmount(); }) };
}

const BOOTS: Record<string, (string | null)[]> = {
  "site answer after the first render": [null, ASSIGNED_VIEW_ID],
  "view known from the first render": [ASSIGNED_VIEW_ID],
  "a reload lets go of the view and the site answers again": [ASSIGNED_VIEW_ID, null, ASSIGNED_VIEW_ID],
  "another list first, then Assigned to me": ["board:1", ASSIGNED_VIEW_ID],
};
describe("a filter on Assigned to me survives closing and opening the app", () => {
  for (const [name, steps] of Object.entries(BOOTS)) {
    test(name + ": Status and Labels come back and the tab is lit", async () => {
      store.clear();
      const a = boot();
      for (const id of steps) await a.show(id);
      await act(async () => { a.get().applyFilters({ statusPick: ["In Progress"], tagPick: ["backend"] }); });
      expect(a.get().filters.statusPick).toEqual(["In Progress"]);
      await a.close();
      const b = boot();
      for (const id of steps) await b.show(id);
      expect(b.get().activeTab).not.toBeNull();
      expect(b.get().filters.statusPick).toEqual(["In Progress"]);
      expect(b.get().filters.tagPick).toEqual(["backend"]);
      await b.close();
    });
  }
});

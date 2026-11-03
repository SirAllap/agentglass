import { test, expect } from "bun:test";
import {
  ALL_SCOPE, filterEvents, filterRows, readScope, resolveScope, rowMatches, scopedSummary, withProject, withSession, withWorker, writeScope,
} from "../src/lib/starboardScope.ts";
import { globalStubs } from "./stubGlobal.ts";
import type { WatchEvent } from "../../shared/types.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const store = new Map<string, string>();
let refusing = false;
const stubGlobal = globalStubs();
stubGlobal("localStorage", {
  getItem: (k: string) => { if (refusing) throw new Error("no"); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (refusing) throw new Error("no"); store.set(k, v); },
  removeItem: (k: string) => { if (refusing) throw new Error("no"); store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
});

const row = (o: Partial<LanternRow> = {}): LanternRow =>
  ({ name: "orbit-api", from: "said", state: "idle", ...o });

const rows: LanternRow[] = [
  row({ name: "orbit-api", project: "acme/orbit", session: "s-orbit-1" }),
  row({ name: "orbit-web", project: "acme/orbit", session: "s-orbit-2" }),
  row({ name: "ledger", project: "acme/ledger", session: "s-ledger" }),
];

const ev = (o: Partial<WatchEvent> = {}): WatchEvent => ({
  id: Math.floor(Math.random() * 1e9),
  source_app: "claude",
  session_id: "s-orbit-1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  provider: "Anthropic",
  is_error: 0,
  error_text: null,
  duration_ms: 40,
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  cost_usd: 0.01,
  summary: null,
  timestamp: 1_000,
  payload: {},
  ...o,
});

test("selecting one project leaves only its sessions", () => {
  const picked = filterRows(rows, { project: "acme/orbit", session: "" });
  expect(picked.map((r) => r.session)).toEqual(["s-orbit-1", "s-orbit-2"]);
  expect(filterRows(rows, { project: "", session: "s-orbit-2" }).map((r) => r.session)).toEqual(["s-orbit-2"]);
});

/* A headless worker has no hooked session: its row is the only handle, and its
   steps live in its own tab (crewworker.ts), not in the event stream. */
const workerRow = (o: Partial<LanternRow> = {}): LanternRow =>
  row({ name: "disk-cleanup-hero", project: "acme/orbit", from: "seen", state: "working", worker: { role: "builder", since: 900 }, ...o });
const withWorkerRow = [...rows, workerRow()];

test("a worker row is the one row a worker pick matches, whatever project is picked", () => {
  const pick = { project: "", session: "", worker: "disk-cleanup-hero" };
  expect(filterRows(withWorkerRow, pick).map((r) => r.name)).toEqual(["disk-cleanup-hero"]);
  expect(filterRows(withWorkerRow, { ...pick, project: "acme/ledger" }).map((r) => r.name)).toEqual(["disk-cleanup-hero"]);
  // A name that belongs to another session is not a worker, and a worker pick never lights a session row.
  expect(rowMatches(rows[0]!, pick)).toBe(false);
});

test("a worker pick does not narrow the event feed, which has none of its steps", () => {
  const events = [ev({ session_id: "s-orbit-1" }), ev({ session_id: "s-ledger" })];
  const picked = { project: "", session: "", worker: "disk-cleanup-hero" };
  expect(filterEvents(events, withWorkerRow, picked).map((e) => e.session_id)).toEqual(["s-orbit-1", "s-ledger"]);
});

test("picking a worker clears the session, and a session pick clears the worker", () => {
  expect(withWorker({ project: "acme/orbit", session: "s-orbit-1" }, "disk-cleanup-hero"))
    .toEqual({ project: "acme/orbit", session: "", worker: "disk-cleanup-hero" });
  expect(withWorker({ project: "", session: "", worker: "disk-cleanup-hero" }, "disk-cleanup-hero"))
    .toEqual({ project: "", session: "" });
  expect(withSession({ project: "", session: "", worker: "disk-cleanup-hero" }, "s-orbit-2"))
    .toEqual({ project: "", session: "s-orbit-2" });
});

test("a worker that left the board falls back to All; one still on it is kept", () => {
  expect(resolveScope({ project: "", session: "", worker: "disk-cleanup-hero" }, rows)).toEqual(ALL_SCOPE);
  const kept = { project: "", session: "", worker: "disk-cleanup-hero" };
  expect(resolveScope(kept, withWorkerRow)).toBe(kept);
  expect(resolveScope(kept, [])).toBe(kept);
  // A session row carrying that name is not the worker: the pick needs the row's own marker.
  expect(resolveScope({ project: "", session: "", worker: "orbit-api" }, rows)).toEqual(ALL_SCOPE);
});

test("selecting one project leaves only the events of its sessions", () => {
  const events = [ev({ session_id: "s-orbit-1" }), ev({ session_id: "s-ledger" }), ev({ session_id: "s-orbit-2" })];
  const picked = filterEvents(events, rows, { project: "acme/orbit", session: "" });
  expect(picked.map((e) => e.session_id)).toEqual(["s-orbit-1", "s-orbit-2"]);
});

test("selecting one session leaves only its events", () => {
  const events = [ev({ session_id: "s-orbit-1" }), ev({ session_id: "s-orbit-2" }), ev({ session_id: "s-ledger" })];
  expect(filterEvents(events, rows, { project: "", session: "s-orbit-2" }).map((e) => e.session_id)).toEqual(["s-orbit-2"]);
  expect(filterEvents(events, rows, { project: "acme/orbit", session: "s-orbit-2" }).map((e) => e.session_id)).toEqual(["s-orbit-2"]);
  // A session outside the chosen project is not silently admitted by its id alone.
  expect(filterEvents(events, rows, { project: "acme/ledger", session: "s-orbit-2" })).toEqual([]);
});

test("a stale id falls back to All; an empty board is the connecting beat, not a stale fleet", () => {
  expect(resolveScope({ project: "acme/gone", session: "" }, rows)).toEqual(ALL_SCOPE);
  expect(resolveScope({ project: "", session: "s-gone" }, rows)).toEqual(ALL_SCOPE);
  expect(resolveScope({ project: "acme/orbit", session: "s-ledger" }, rows)).toEqual(ALL_SCOPE);
  const kept = { project: "acme/orbit", session: "s-orbit-1" };
  expect(resolveScope(kept, rows)).toBe(kept);
  expect(resolveScope(kept, [])).toBe(kept);
});

test("a card picked twice clears; a new project drops the session it no longer contains", () => {
  expect(withSession({ project: "", session: "" }, "s-orbit-1")).toEqual({ project: "", session: "s-orbit-1" });
  expect(withSession({ project: "", session: "s-orbit-1" }, "s-orbit-1")).toEqual({ project: "", session: "" });
  expect(withProject({ project: "", session: "s-orbit-1" }, "acme/ledger")).toEqual({ project: "acme/ledger", session: "" });
});

test("the choice survives a reload, and is dropped when nothing is selected", () => {
  store.clear();
  writeScope({ project: "acme/orbit", session: "s-orbit-1" });
  expect(readScope()).toEqual({ project: "acme/orbit", session: "s-orbit-1" });
  writeScope({ project: "", session: "", worker: "disk-cleanup-hero" });
  expect(readScope()).toEqual({ project: "", session: "", worker: "disk-cleanup-hero" });
  writeScope(ALL_SCOPE);
  expect(store.size).toBe(0);
  expect(readScope()).toEqual(ALL_SCOPE);
});

test("a browser that refuses storage reads as All and a write never throws", () => {
  refusing = true;
  expect(readScope()).toEqual(ALL_SCOPE);
  expect(() => writeScope({ project: "acme/orbit", session: "" })).not.toThrow();
  refusing = false;
});

test("the scoped summary counts only the events it is handed, in /stats' terms", () => {
  const events = [
    ev({ session_id: "s-orbit-1", tool_name: "Bash", duration_ms: 40, cost_usd: 0.02 }),
    ev({ session_id: "s-orbit-1", tool_name: "Bash", hook_event_type: "PostToolUseFailure", is_error: 1, duration_ms: 60, cost_usd: 0.03 }),
    ev({ session_id: "s-orbit-2", tool_name: "Read", duration_ms: 10, cost_usd: 0.01 }),
    ev({ session_id: "s-orbit-2", hook_event_type: "Stop", tool_name: null, duration_ms: null, cost_usd: 0 }),
  ];
  const s = scopedSummary(filterEvents(events, rows, { project: "acme/orbit", session: "" }));
  expect(s.totals).toMatchObject({ events: 4, sessions: 2, tool_calls: 3, tool_errors: 1 });
  expect(s.totals.cost_usd).toBeCloseTo(0.06, 10);
  expect(s.tool_latency.find((t) => t.tool_name === "Bash")).toMatchObject({ calls: 2, timed: 2, errors: 1, p50_ms: 40, p95_ms: 60 });
});

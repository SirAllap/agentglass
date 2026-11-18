/*
 * NEXT CARD — a saved filter's members, claimed once and scouted.
 *
 * Isolated db per file (same pattern as flow.test.ts): the claim table and the
 * real `named_agent` table it reads liveness off both live in a temp sqlite
 * file, so a fake "already running" scout here cannot leak into another test
 * file's count.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JiraResult, JiraTasks } from "../src/jira.ts";
import type { FilterRead } from "../src/jiraFilterSync.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-nextcard-"));
const restore = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AGENTGLASS_DOCTRINE: process.env.AGENTGLASS_DOCTRINE,
  AGENTGLASS_DB: process.env.AGENTGLASS_DB,
};
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DOCTRINE = join(dir, "doctrine");
process.env.AGENTGLASS_DB = join(dir, "nextcard.db");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

const { tickNextCard } = await import("../src/agents/nextCard.ts");
const { putSetting } = await import("../src/preflightStore.ts");
const { db } = await import("../src/db.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const task = (id: string, customId?: string): ProviderTask => ({
  id, customId, title: `card ${++n}`, url: "", status: "Open", statusKind: "open",
  priority: null, due: null, updated: 0, tags: [], list: null, assignees: [],
}) as unknown as ProviderTask;

const filterOk = (jql = "project = X"): JiraResult<FilterRead> => ({ ok: true, data: { id: "10042", name: "f", jql } });
const tasksOk = (tasks: ProviderTask[]): JiraResult<JiraTasks> => ({ ok: true, data: { tasks, truncated: false } });

/** A live-running scout, as `liveClaimed` reads it: a real row, no end. */
function registerLiveAgent(name: string): void {
  db.run(
    `INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at) VALUES (?, 'claude', '/x', 'p', 'w', ?, NULL)`,
    [name, Date.now()],
  );
}

const baseDeps = (over: Partial<Parameters<typeof tickNextCard>[1]> = {}) => ({
  creds: () => ({ site: "x.atlassian.net" }) as never,
  readFilter: async () => filterOk(),
  now: Date.now(),
  ...over,
});

describe("tickNextCard — claim race", () => {
  test("two ticks hitting the same card: only one claim wins, one start", async () => {
    const root = "root-race";
    putSetting(root, "flow.nextCard.enabled", true);
    putSetting(root, "flow.nextCard.filterId", "10042");
    putSetting(root, "flow.nextCard.cap", 2);
    let starts = 0;
    const deps = baseDeps({
      runJql: async () => tasksOk([task("1", "ORBIT-1")]),
      start: async () => { starts++; return { status: 200 } as never; },
    });
    const [a, b] = await Promise.all([tickNextCard(root, deps), tickNextCard(root, deps)]);
    expect(starts, "only one of the two ticks starts the scout").toBe(1);
    expect(a.started.length + b.started.length).toBe(1);
  });
});

describe("tickNextCard — cap", () => {
  test("with the cap already running, a 3rd eligible card waits", async () => {
    const root = "root-cap";
    putSetting(root, "flow.nextCard.enabled", true);
    putSetting(root, "flow.nextCard.filterId", "10042");
    putSetting(root, "flow.nextCard.cap", 2);
    const started: string[] = [];
    const deps = baseDeps({
      runJql: async () => tasksOk([task("1", "ORBIT-1"), task("2", "ORBIT-2")]),
      start: async () => ({ status: 200 } as never),
    });
    const first = await tickNextCard(root, { ...deps, start: async (p) => { started.push(String(p.name)); return { status: 200 } as never; } });
    expect(first.started.length, "cap is 2, two unclaimed cards: both start").toBe(2);
    for (const name of started) registerLiveAgent(name);

    let thirdStarts = 0;
    const second = await tickNextCard(root, baseDeps({
      runJql: async () => tasksOk([task("1", "ORBIT-1"), task("2", "ORBIT-2"), task("3", "ORBIT-3")]),
      start: async () => { thirdStarts++; return { status: 200 } as never; },
    }));
    expect(second.started, "no free slot: the cap holds even for a card nobody claimed yet").toEqual([]);
    expect(thirdStarts).toBe(0);
  });
});

describe("tickNextCard — off switches", () => {
  test("setting off: no read at all", async () => {
    const root = "root-off";
    putSetting(root, "flow.nextCard.enabled", false);
    putSetting(root, "flow.nextCard.filterId", "10042");
    let read = false;
    const r = await tickNextCard(root, baseDeps({ readFilter: async () => { read = true; return filterOk(); } }));
    expect(r.started).toEqual([]);
    expect(read, "the switch is off: the filter is never read").toBe(false);
  });

  test("no filter picked: no read", async () => {
    const root = "root-nofilter";
    putSetting(root, "flow.nextCard.enabled", true);
    putSetting(root, "flow.nextCard.filterId", "");
    let read = false;
    const r = await tickNextCard(root, baseDeps({ readFilter: async () => { read = true; return filterOk(); } }));
    expect(r.started).toEqual([]);
    expect(read).toBe(false);
  });
});

describe("tickNextCard — already-claimed card stays claimed", () => {
  test("a card claimed before, with its scout gone, is not started again", async () => {
    const root = "root-stale";
    putSetting(root, "flow.nextCard.enabled", true);
    putSetting(root, "flow.nextCard.filterId", "10042");
    putSetting(root, "flow.nextCard.cap", 2);
    let starts = 0;
    const once = baseDeps({
      runJql: async () => tasksOk([task("1", "ORBIT-1")]),
      start: async () => { starts++; return { status: 200 } as never; },
    });
    await tickNextCard(root, once); // claims it, scout never gets registered as live (crashed before it could)
    const again = await tickNextCard(root, once);
    expect(starts, "claimed once is claimed forever, whatever became of the scout").toBe(1);
    expect(again.started).toEqual([]);
  });
});

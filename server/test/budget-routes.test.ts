/*
 * Budgets on disk and over the wire.
 *
 * `config.json` is hand-edited, and a budget is a *denominator*. A limit that
 * arrives as the string "40" turns every percentage into NaN; a period nobody
 * recognises would be evaluated as something. Both are the kind of wrong that
 * shows up as a plausible number on a dashboard rather than as an error, which
 * is why every field is checked on the way in and again on the way out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-budget-"));
  const port = 4870 + Math.floor(Math.random() * 20);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, never `...process.env`.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const jsonOf = (r: Response) => r.json() as Promise<Json>;
const set = (budgets: unknown) =>
  fetch(base + "/budgets/set", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgets }),
  });
const get = () => fetch(base + "/budgets").then(jsonOf);

const GOOD = { root: "", model: "", limit: 40, period: "month" };

beforeEach(async () => { await set([]); });

describe("saving one", () => {
  test("round-trips through the config file", async () => {
    const r = await jsonOf(await set([GOOD]));
    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(true);
    expect((await get()).budgets).toEqual([GOOD]);
  });

  test("and lands in config.json beside everything else, not in a file of its own", async () => {
    // One settings file. A second one is a second thing to find, back up and
    // hand-edit, for four fields.
    await set([GOOD]);
    const cfg = JSON.parse(readFileSync(join(dir, "agentglass", "config.json"), "utf8"));
    expect(cfg.budgets).toEqual([GOOD]);
  });

  test("without trampling the settings already in there", async () => {
    // The write is a read-modify-write of a shared file: losing the workspace
    // root to save a budget would be a spectacularly bad trade.
    const path = join(dir, "agentglass", "config.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ root: "/home/x/keepme", chatBypass: true }));
    await set([GOOD]);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.root).toBe("/home/x/keepme");
    expect(cfg.chatBypass).toBe(true);
    expect(cfg.budgets).toEqual([GOOD]);
  });

  test("replacing the whole set, because a row has no identity", async () => {
    // Two budgets can differ only by a limit somebody is halfway through
    // typing, so there is nothing to address a partial update at.
    await set([GOOD, { ...GOOD, root: "/a/b", limit: 10 }]);
    expect((await get()).budgets).toHaveLength(2);
    await set([GOOD]);
    expect((await get()).budgets).toHaveLength(1);
  });
});

describe("refusing one that is not a budget", () => {
  test("a limit that is not a positive number", async () => {
    for (const limit of [0, -1, "40", null, undefined, NaN]) {
      const r = await set([{ ...GOOD, limit }]);
      expect(r.status, String(limit)).toBe(400);
      expect(String((await jsonOf(r)).error)).toContain("limit above zero");
    }
  });

  test("a period nobody recognises", async () => {
    for (const period of ["year", "fortnight", "", 30, null]) {
      const r = await set([{ ...GOOD, period }]);
      expect(r.status, String(period)).toBe(400);
    }
  });

  test("and refuses on the way in rather than dropping it quietly", async () => {
    // readBudgets() skips what it cannot use, so a bad row accepted here would
    // vanish on the next read and look exactly like a save that did nothing.
    await set([GOOD]);
    expect((await set([{ ...GOOD, limit: -1 }])).status).toBe(400);
    expect((await get()).budgets).toEqual([GOOD]);
  });

  test("a body that is not a list", async () => {
    for (const body of [{ budgets: "all of them" }, { budgets: 3 }, {}]) {
      const r = await fetch(base + "/budgets/set", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
  });

  test("and a body that is not JSON", async () => {
    const r = await fetch(base + "/budgets/set", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(r.status).toBe(400);
  });
});

describe("what the panel is told", () => {
  test("every budget comes back with where it stands", async () => {
    await set([{ ...GOOD, limit: 40 }]);
    const r = await get();
    expect(r.status).toHaveLength(1);
    // Nothing has been spent in this scratch database, so it is under.
    expect(r.status[0]).toMatchObject({ spent: 0, pct: 0, level: "ok" });
    // …and it says which days that covers, rather than implying all of them.
    expect(r.status[0].fromDay).toMatch(/^\d{4}-\d{2}-01$/);
  });

  test("and the models it could be attached to, so nobody types an id", async () => {
    const r = await get();
    expect(Array.isArray(r.models)).toBe(true);
  });

  test("a budget that is not usable is not given a status", async () => {
    // It cannot be saved through the route, but it can be hand-edited in, and a
    // zero limit is a division nobody wants rendered as a percentage.
    const path = join(dir, "agentglass", "config.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ budgets: [{ ...GOOD, limit: 0 }] }));
    const r = await get();
    expect(r.status).toEqual([]);
  });
});

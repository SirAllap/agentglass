/*
 * GET /polaris/items/:number: one pull request's verdict, read from the same list as /polaris/items.
 * No network: the list, jobs and checks are fakes.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "../../shared/polaris.ts";
import { writePolaris } from "../src/config.ts";
import { __resetPolaris, type PolarisIo } from "../src/polaris.ts";
import { polarisRoute } from "../src/polarisRoutes.ts";

const saved = { home: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
const dirs: string[] = [];
const ROOT = "/work/acme/orbit";
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-one-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.AGENTGLASS_ROOT;
  __resetPolaris();
  writePolaris(ROOT, { enabled: true, preset: "custom", doors: structuredClone(PRESETS.guided.doors) });
});
afterAll(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.home], ["AGENTGLASS_ROOT", saved.root]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const repo = { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" };
const row = (number: number) => ({ number, title: `ORBIT-${number} add thing`, author: "ada", state: "OPEN", isDraft: false, labels: [], baseRefName: "main", headRefName: `b${number}`, headSha: "a".repeat(40), url: `https://github.com/acme/orbit/pull/${number}`, mergeable: "MERGEABLE", checks: { failing: [], pending: 0, failure: 0 }, checksLoaded: true });
function io(list: Record<string, unknown>): { i: PolarisIo; lists: number } {
  const o = { lists: 0 };
  const i = { rerunJob: async () => ({ ok: true }), readJobs: async () => null, list: async () => { o.lists++; return list; } } as unknown as PolarisIo;
  return { i, get lists() { return o.lists; } } as never;
}
const get = (path: string, i: PolarisIo, root = ROOT) => polarisRoute("GET", path, new URLSearchParams({ root }), {}, { kind: "agent", name: "w1" }, i);

describe("one pull request", () => {
  test("returns that row only, from one list read", async () => {
    const f = io({ ok: true, repo, prs: [row(7), row(8)], fetchedAt: 1, stale: false, loading: false });
    const r = await get("/polaris/items/8", f.i);
    expect(r?.status).toBe(200);
    expect((r!.body.item as { number: number }).number).toBe(8);
    expect(f.lists).toBe(1);
  });
  test("a number that is not open is 404, not an empty 200", async () => {
    const f = io({ ok: true, repo, prs: [row(7)], fetchedAt: 1, stale: false, loading: false });
    const r = await get("/polaris/items/99", f.i);
    expect(r?.status).toBe(404);
    expect(r?.body.ok).toBe(false);
  });
  test("gh signed out is named, never read as a missing pull request", async () => {
    const f = io({ ok: false, repo, prs: [], needsAuth: true, error: "gh is signed out: run gh auth login", fetchedAt: 0, stale: false, loading: false });
    const r = await get("/polaris/items/7", f.i);
    expect(r?.status).toBe(404);
    expect(r?.body.uncharted).toBe("gh is signed out: run gh auth login");
  });
  test("a bad root is 400", async () => {
    const r = await polarisRoute("GET", "/polaris/items/7", new URLSearchParams({ root: "rel" }), {}, { kind: "agent", name: "w1" });
    expect(r?.status).toBe(400);
  });
  test("a non-numeric id is not this route", async () => {
    const f = io({ ok: true, repo, prs: [row(7)], fetchedAt: 1, stale: false, loading: false });
    expect(await get("/polaris/items/abc", f.i)).toBeNull();
  });
});

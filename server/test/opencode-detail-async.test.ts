// `opencode stats` was a blocking spawn with an 8 s limit on the server's
// only thread, behind a route and behind the usage row the dashboard polls.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeDetail, openCodeDetailFresh, __resetOpenCodeSpend } from "../src/opencodeusage.ts";

const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const source = strip(await Bun.file(new URL("../src/opencodeusage.ts", import.meta.url)).text());
const index = strip(await Bun.file(new URL("../src/index.ts", import.meta.url)).text());
const rows = strip(await Bun.file(new URL("../src/providerusage.ts", import.meta.url)).text());

const dir = mkdtempSync(join(tmpdir(), "agx-ocdetail-"));
const before = process.env.AGENTGLASS_OPENCODE_STATS;
afterAll(() => {
  if (before === undefined) delete process.env.AGENTGLASS_OPENCODE_STATS; else process.env.AGENTGLASS_OPENCODE_STATS = before;
  __resetOpenCodeSpend();
  rmSync(dir, { recursive: true, force: true });
});

test("nothing in the module starts the engine on the caller's thread", () => {
  expect(source).not.toContain("spawnSync");
  const at = source.indexOf("export function openCodeDetail(");
  expect(at).toBeGreaterThan(-1);
  const body = source.slice(at, source.indexOf("\n}\n", at));
  // The one that cannot wait never spawns: it reads the kept answer or a fixture, and asks for a run.
  expect(body).not.toContain("Bun.spawn");
  expect(body).toContain("void refreshOpenCodeDetail(days);");
});

test("the awaited read answers what the blocking one did", async () => {
  const file = join(dir, "stats.json");
  writeFileSync(file, JSON.stringify({
    cost: 7.07, steps: 4034,
    models: [{ model: { id: "model-a", providerID: "opencode-go" }, steps: 80, cost: 3.45, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 4 } } }],
    activity: [{ date: "2026-10-31", steps: 3954 }],
  }));
  process.env.AGENTGLASS_OPENCODE_STATS = file;
  __resetOpenCodeSpend();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const fresh = await openCodeDetailFresh(30, true);
  clearInterval(timer);
  expect(fresh).toEqual(openCodeDetail(30, true));
  expect(fresh?.costUsd).toBe(7.07);
  // And it is kept: the caller that cannot wait now has it without a run.
  expect(openCodeDetail(30)).toEqual(fresh);
});

test("the routes and the usage rows wait for it instead of blocking", () => {
  expect(index).toContain('if (pathname === "/usage/opencode") return json(await opencodeUsageFresh());');
  expect(index).toContain("detail: await openCodeDetailFresh(");
  expect(rows).toContain("rows.push(await opencodeUsageFresh());");
});

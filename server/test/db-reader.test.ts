/*
 * The database reader: the widest history reads on a second, read-only
 * connection in a process of its own, so a cold database file is waited for
 * there (measured: 2 to 4.5 s of the server's only thread).
 *
 * What is pinned: the reader's answer equals the server's own for the same
 * question (one copy of each query, two connections), the reader cannot
 * write and never loads the module that can, and a reader that does not
 * answer costs a route its timeout and nothing else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as DB from "../src/db.ts";
import { answer, openReader } from "../src/reader/readerMain.ts";
import { readerArgv, readerEnv, readerPid, readerPricesMatch, readerStats, readVia, startReader, stopReader } from "../src/reader/readerHost.ts";
import { lineSplitter } from "../src/relay/wire.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const SRC = join(import.meta.dir, "../src");
const sources = {
  gate: await Bun.file(join(SRC, "reader/gate.ts")).text(),
  main: await Bun.file(join(SRC, "reader/readerMain.ts")).text(),
  reads: await Bun.file(join(SRC, "reader/reads.ts")).text(),
  host: await Bun.file(join(SRC, "reader/readerHost.ts")).text(),
  entry: await Bun.file(join(SRC, "index.ts")).text(),
};

const ROOT = "/home/dev/code/orbit";
const event = (i: number, over: Record<string, unknown> = {}) => ({
  source_app: "orbit", session_id: `reader-s${i % 3}`, hook_event_type: "PostToolUse",
  tool_name: i % 2 ? "Bash" : "Read", tool_use_id: null, agent_id: null, agent_type: null,
  model_name: i % 2 ? "claude-opus-4-8" : "claude-sonnet-4-5", is_error: i % 5 === 0 ? 1 : 0,
  error_text: null, duration_ms: 40 + i,
  usage: { input_tokens: 100 + i, output_tokens: 20 + i, cache_creation_tokens: i, cache_read_tokens: 3 * i },
  usage_is_cumulative: false, summary: "x", timestamp: Date.now() - 60_000 - i * 1000,
  payload: { project_path: ROOT }, chat: null, ...over,
});

/** Every row, whatever project the shared test process is scoped to. */
const everywhere = { clause: "", args: [] as string[] };
const statsCtx = () => ({ ...DB.statsCtx(), events: everywhere });
const dailyCtx = () => ({ rollup: everywhere, events: everywhere });
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
/** Equal, and when not, the failure names the field: a whole summary's diff says nothing at a glance. */
const same = (there: unknown, here: unknown, what: string) => {
  const a = plain(there), b = plain(here);
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) expect(a[k], `${what}: field ${k}`).toEqual(b[k]);
  }
  expect(a, what).toEqual(b);
};

beforeAll(() => {
  for (let i = 0; i < 24; i++) DB.insertEvent(event(i) as never);
  DB.insertEvent(event(30, { hook_event_type: "PreToolUse", tool_name: "Skill", payload: { project_path: ROOT, tool_input: { skill: "review" } } }) as never);
  DB.insertEvent(event(31, { hook_event_type: "Turn complete", tool_name: null }) as never);
});

describe("one query, two connections, one answer", () => {
  const reader = openReader(DB.dbPath());
  afterAll(() => reader.close());

  test("the statistics summary", () => {
    const ctx = statsCtx();
    for (const args of [[3_600_000, null], [86_400_000, "Europe/Madrid"]] as unknown[][]) {
      const here = plain(DB.readHere("statsSummary", ctx, args));
      expect(here.totals.events).toBeGreaterThanOrEqual(26);
      const there = answer(reader, { id: 1, fn: "statsSummary", ctx, args });
      expect(there.ok).toBe(true);
      same(there.ok && there.data, here, `statsSummary ${JSON.stringify(args)}`);
    }
  });

  test("the daily usage series", () => {
    const ctx = dailyCtx();
    const today = new Date().toISOString().slice(0, 10);
    for (const args of [[null, null], [today, today]] as unknown[][]) {
      const here = plain(DB.readHere("dailyUsage", ctx, args));
      expect(here.length).toBeGreaterThan(0);
      const there = answer(reader, { id: 2, fn: "dailyUsage", ctx, args });
      same(there.ok && there.data, here, `dailyUsage ${JSON.stringify(args)}`);
    }
  });

  test("the sync functions still go through the same code", () => {
    // statsSummary and dailyUsage are the wrappers every other caller uses.
    expect(DB.statsSummary(3_600_000).window_ms).toBe(3_600_000);
    expect(Array.isArray(DB.dailyUsage())).toBe(true);
  });

  test("the reader cannot write, and says so instead of throwing", () => {
    expect(() => reader.run("DELETE FROM events")).toThrow();
    const bad = answer(reader, { id: 3, fn: "dropEverything", ctx: {}, args: [] });
    expect(bad).toEqual({ id: 3, ok: false, error: "unknown read: dropEverything" });
    const broken = answer(reader, { id: 4, fn: "dailyUsage", ctx: { rollup: { clause: " AND nope = 1", args: [] }, events: everywhere }, args: [null, null] });
    expect(broken.ok).toBe(false);
  });
});

describe("what the reader process is made of", () => {
  test("it never loads the module that opens the database for writing", () => {
    for (const [name, text] of Object.entries(sources)) {
      if (name === "entry") continue;
      const imports = text.split("\n").filter((l) => /^\s*import\b|from "/.test(l)).join("\n");
      expect(imports, name).not.toContain("db.ts");
    }
    // The gate runs before anything that could: right after the relay's, ahead of every other import.
    const relayGate = sources.entry.indexOf('import "./relay/gate.ts";');
    const readerGate = sources.entry.indexOf('import "./reader/gate.ts";');
    expect(relayGate).toBeGreaterThan(-1);
    expect(readerGate).toBeGreaterThan(relayGate);
    const between = sources.entry.slice(relayGate, readerGate).split("\n").filter((l) => /^import /.test(l));
    expect(between).toEqual(['import "./relay/gate.ts";', 'import "./broker/gate.ts";']);
    expect(sources.gate).toContain('process.env.AGENTGLASS_DBREADER_CHILD === "1"');
  });

  test("its start line and its environment", () => {
    expect(readerArgv("/home/dev/.bun/bin/bun", "/x/index.ts")).toEqual(["/home/dev/.bun/bin/bun", "--no-env-file", "run", "/x/index.ts"]);
    expect(readerArgv("/opt/app/agentglass-server", "/x/index.ts")).toEqual(["/opt/app/agentglass-server"]);
    const env = readerEnv({ PATH: "/usr/bin", HOME: "/home/dev", TZ: "Europe/Madrid", AGENTGLASS_PRICING: "/home/dev/prices.json", AGENTGLASS_TOKEN: "t" }, "/home/dev/agentglass.db");
    expect(env).toEqual({
      PATH: "/usr/bin", HOME: "/home/dev", TZ: "Europe/Madrid", AGENTGLASS_PRICING: "/home/dev/prices.json",
      AGENTGLASS_DBREADER_CHILD: "1", AGENTGLASS_DBREADER_PATH: "/home/dev/agentglass.db",
    });
  });

  test("a price table that can change at run time keeps priced reads on the server", () => {
    expect(readerPricesMatch({})).toBe(true);
    expect(readerPricesMatch({ AGENTGLASS_PRICING_REFRESH: "1" })).toBe(false);
    expect(readerPricesMatch({ AGENTGLASS_PRICING_REFRESH: "1", AGENTGLASS_PRICING: "/home/dev/prices.json" })).toBe(true);
    expect(sources.entry).toContain('(fn !== "statsSummary" || readerPricesMatch(process.env))');
  });
});

describe("the real process, through the host", () => {
  const until = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return ok();
  };

  test("no reader yet: the route is told to do the read itself", async () => {
    const before = readerStats().fellBack;
    expect(await readVia("dailyUsage", dailyCtx(), [null, null])).toBeNull();
    expect(readerStats().fellBack).toBe(before + 1);
    expect(readerStats().up).toBe(false);
  });

  test("it answers what the server would, and a reader that stops answering is replaced", async () => {
    startReader(DB.dbPath(), () => {});
    try {
      expect(await until(() => readerStats().up, 10_000)).toBe(true);
      const first = readerPid();
      const ctx = dailyCtx();
      same(await readVia("dailyUsage", ctx, [null, null]), DB.readHere("dailyUsage", ctx, [null, null]), "host: dailyUsage");
      const sctx = statsCtx();
      same(await readVia("statsSummary", sctx, [3_600_000, null]), DB.readHere("statsSummary", sctx, [3_600_000, null]), "host: statsSummary, server zone");
      // The reader's own clock is not the server's: the grid must come out the same in a zone named only in ctx.
      const far = { ...sctx, zone: "Pacific/Kiritimati" };
      same(await readVia("statsSummary", far, [3_600_000, null]), DB.readHere("statsSummary", far, [3_600_000, null]), "host: statsSummary, zone from ctx");

      // Frozen, the way a process waiting on a cold disk is: the route gets its null inside the timeout.
      process.kill(first!, "SIGSTOP");
      const t0 = performance.now();
      expect(await readVia("dailyUsage", ctx, [null, null], 300)).toBeNull();
      expect(performance.now() - t0).toBeLessThan(2000);
      // And it comes back as another process that answers.
      expect(await until(() => readerStats().up && readerPid() !== first, 10_000)).toBe(true);
      same(await readVia("dailyUsage", ctx, [null, null]), DB.readHere("dailyUsage", ctx, [null, null]), "host: dailyUsage after the restart");
    } finally {
      const pid = readerPid();
      stopReader();
      if (pid) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
    }
  }, SERVER_BOOT_MS + 30_000);

  test("started by hand, it speaks the wire and ends with its stdin", async () => {
    const child = Bun.spawn(readerArgv(process.execPath, join(SRC, "index.ts")), {
      env: readerEnv(process.env, DB.dbPath()), stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    const lines: string[] = [];
    const split = lineSplitter();
    const dec = new TextDecoder();
    const reading = (async () => { for await (const c of child.stdout as ReadableStream<Uint8Array>) lines.push(...split(dec.decode(c, { stream: true }))); })();
    const ctx = dailyCtx();
    child.stdin.write(JSON.stringify({ id: 7, fn: "dailyUsage", ctx, args: [null, null] }) + "\n");
    child.stdin.flush();
    expect(await until(() => lines.length >= 2, 10_000)).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({ ready: true });
    expect(JSON.parse(lines[1]!)).toEqual({ id: 7, ok: true, data: plain(DB.readHere("dailyUsage", ctx, [null, null])) });
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await reading;
  }, SERVER_BOOT_MS + 15_000);
});

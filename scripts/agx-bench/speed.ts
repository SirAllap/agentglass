#!/usr/bin/env bun
/**
 * agx-bench speed: a cheap MODEL drives the browser CLI through the fixture
 * tasks in fixtures3.ts, and the server grades what happened.
 *
 *   scripts/agx-bench/instance.sh start /tmp/agx-bench
 *   bun scripts/agx-bench/speed.ts --instance /tmp/agx-bench --label baseline --out results.json
 *   scripts/agx-bench/instance.sh stop /tmp/agx-bench
 *
 * Per run it records rounds (tool calls), input and output tokens as the model
 * API counted them, wall-clock seconds, cost and the server's verdict. The
 * `claude` child gets one tool (Bash, limited to `agentglass-browser`), no
 * hooks, no memory, no plugins and no MCP servers, so what it reads is the
 * skill text and the task, nothing else. The skill is the file in THIS tree
 * (`--skill`), and the CLI is this tree's `bin/agentglass-browser`, so a step
 * that edits either is what the next run measures. A step that changes the page
 * side (web/src) needs `make build` and a restarted instance first.
 *
 * A run is stopped when its cost passes --max-run-usd, and the whole command
 * when the total passes --budget: the number printed at the end is what a
 * subscription would have been billed at API prices, so a runaway loop shows up
 * as a stop, not as a surprise.
 *
 *   --task a,b   tasks to run (default all)     --reps N   per task (default 3)
 *   --model M    default haiku                  --budget USD (default 3)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cliEnv } from "./run.ts";
import { startFixtures } from "./fixtures.ts";
import { SPEED_TASKS, type SpeedTask } from "./fixtures3.ts";
import { median } from "./metrics.ts";

const ROOT = resolve(import.meta.dir, "../..");

export type SpeedRun = {
  task: string;
  rep: number;
  rounds: number;
  /** Everything the model read: fresh input plus cache writes plus cache reads. */
  inTokens: number;
  outTokens: number;
  seconds: number;
  usd: number;
  pass: boolean;
  /** The Bash commands, in order: how a failure is read afterwards. */
  commands: string[];
  stopped?: string;
};

/** What the model is told before the skill text. The skill owns how to use the CLI. */
export const HEADER =
  "You operate a web browser through the `agentglass-browser` command, which you run with the Bash tool. " +
  "The reference for it follows. Use no other command. Work until the task is done, then stop and answer " +
  "with the single word DONE or FAILED.";

/** The skill without its front matter. */
export function skillText(path: string): string {
  return readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

type Totals = { rounds: number; inTokens: number; outTokens: number; usd: number; commands: string[] };

/** Fold one stream-json line of `claude -p` into the running totals. Pure, so
 *  the accounting is testable without a model. */
export function foldLine(t: Totals, line: string): void {
  let d: any;
  try { d = JSON.parse(line); } catch { return; }
  if (d.type === "assistant") {
    for (const c of d.message?.content ?? []) {
      if (c.type === "tool_use") {
        t.rounds++;
        if (typeof c.input?.command === "string") t.commands.push(c.input.command);
      }
    }
  } else if (d.type === "result") {
    const u = d.usage ?? {};
    t.inTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    t.outTokens = u.output_tokens ?? 0;
    t.usd = d.total_cost_usd ?? 0;
  }
}

async function runOne(
  task: SpeedTask,
  rep: number,
  o: { model: string; system: string; origin: string; env: Record<string, string>; scratch: string; maxRunUsd: number; timeoutMs: number; id: string },
  beacons: () => Record<string, number>,
  reset: () => Promise<void>,
): Promise<SpeedRun> {
  await reset();
  const env = { ...o.env, AGENTGLASS_PROFILE: o.id };
  const t0 = performance.now();
  const p = Bun.spawn(
    [
      "claude", "-p", task.prompt(o.origin),
      "--model", o.model,
      "--output-format", "stream-json", "--verbose",
      "--tools", "Bash", "--allowedTools", "Bash(agentglass-browser:*)",
      "--append-system-prompt", o.system,
      "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--max-budget-usd", String(o.maxRunUsd),
    ],
    { cwd: o.scratch, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, o.timeoutMs);
  const totals: Totals = { rounds: 0, inTokens: 0, outTokens: 0, usd: 0, commands: [] };
  const err = new Response(p.stderr).text();
  let buf = "";
  for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
    buf += new TextDecoder().decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { foldLine(totals, buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  foldLine(totals, buf);
  await p.exited;
  clearTimeout(timer);
  await err;
  const seconds = (performance.now() - t0) / 1000;
  sweep(o.env);
  return {
    task: task.id, rep, ...totals, seconds: Math.round(seconds * 10) / 10,
    pass: task.pass(beacons()),
    stopped: timedOut ? "timeout" : undefined,
  };
}

/**
 * Leave the instance as the next run expects it. Dropping the run's own
 * identity was not enough: the model names its own (`--as gasket-search`),
 * a popup lands in the default profile, and a model that hits the tab cap
 * opens a lane. Measured: by the third repetition the leftovers had filled
 * the cap, and popup#3 spent 12 rounds against 5 working around it — the
 * harness, not the browser. So every profile but the default is dropped,
 * every lane closed, and every tab still on a fixture page closed (by path:
 * the fixture server's port is new each time, a stale tab's is not).
 */
export function sweep(env: Record<string, string>): void {
  const cli = (...argv: string[]) => {
    const r = Bun.spawnSync(["python3", join(ROOT, "bin", "agentglass-browser"), ...argv], { env, stdout: "pipe", stderr: "ignore" });
    try { return JSON.parse(r.stdout.toString()); } catch { return null; }
  };
  for (const name of (cli("profiles")?.names ?? []) as string[]) {
    if (name !== "default") cli("profiles", "--drop", name, "--force");
  }
  for (const l of (cli("lane", "list")?.lanes ?? []) as Array<{ id: string }>) cli("lane", "close", l.id);
  for (const t of (cli("tabs", "--shared") ?? []) as Array<{ id: string; url: string }>) {
    if (/^http:\/\/127\.0\.0\.1:[0-9]+\/speed\//.test(String(t.url))) cli("closetab", t.id, "--shared");
  }
}

export type Row = { task: string; n: number; passed: number; rounds: number; inK: number; outK: number; seconds: number; usd: number };

/** Median per task of the numbers a step is judged on; success as k of n. */
export function summarize(runs: readonly SpeedRun[]): Row[] {
  const ids = [...new Set(runs.map((r) => r.task))];
  return ids.map((task) => {
    const rs = runs.filter((r) => r.task === task);
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return {
      task, n: rs.length, passed: rs.filter((r) => r.pass).length,
      rounds: median(rs.map((r) => r.rounds)),
      inK: r1(median(rs.map((r) => r.inTokens)) / 1000),
      outK: r1(median(rs.map((r) => r.outTokens)) / 1000),
      seconds: r1(median(rs.map((r) => r.seconds))),
      usd: Math.round(rs.reduce((a, r) => a + r.usd, 0) * 1000) / 1000,
    };
  });
}

export function toMarkdown(label: string, rows: readonly Row[]): string {
  const head = `| ${label} | k/n | rounds | in k | out k | s | $ |\n|---|---|---|---|---|---|---|\n`;
  const body = rows.map((r) => `| ${r.task} | ${r.passed}/${r.n} | ${r.rounds} | ${r.inK} | ${r.outK} | ${r.seconds} | ${r.usd} |`).join("\n");
  const sum = (f: (r: Row) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 10) / 10;
  const total = `\n| **all** | ${sum((r) => r.passed)}/${sum((r) => r.n)} | ${sum((r) => r.rounds)} | ${sum((r) => r.inK)} | ${sum((r) => r.outK)} | ${sum((r) => r.seconds)} | ${Math.round(rows.reduce((a, r) => a + r.usd, 0) * 1000) / 1000} |`;
  return head + body + total + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      instance: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      task: { type: "string" },
      reps: { type: "string", default: "3" },
      model: { type: "string", default: "haiku" },
      skill: { type: "string", default: join(ROOT, "skills", "browser-use", "SKILL.md") },
      budget: { type: "string", default: "3" },
      "max-run-usd": { type: "string", default: "0.4" },
      timeout: { type: "string", default: "240" },
    },
    strict: true,
  });
  if (!values.instance || !values.label || !values.out) throw new Error("--instance DIR --label NAME --out FILE are required");
  const instance = resolve(values.instance);
  const server = `http://127.0.0.1:${readFileSync(join(instance, "port"), "utf8").trim()}`;
  const token = readFileSync(join(instance, "cfg", "agentglass", "token"), "utf8").trim();
  // An allowlist, not the caller's environment: a session that launched this
  // carries its own app's port, token and identity, and the child must not.
  const base: Record<string, string | undefined> = {};
  for (const k of ["HOME", "USER", "LANG", "TERM", "PATH", "SHELL", "TMPDIR"]) base[k] = process.env[k];
  const env = cliEnv({ server, token, instance, reps: 1, arms: [], tasks: [], out: "", as: "" }, base);
  const scratch = mkdtempSync(join(tmpdir(), "agx-speed-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agentglass-browser"), `#!/bin/sh\nexec python3 ${JSON.stringify(join(ROOT, "bin", "agentglass-browser"))} "$@"\n`, { mode: 0o755 });
  env.PATH = `${bin}:${process.env.PATH}`;
  const system = `${HEADER}\n\n${skillText(resolve(values.skill!))}`;
  const wanted = values.task ? values.task.split(",") : SPEED_TASKS.map((t) => t.id);
  const tasks = SPEED_TASKS.filter((t) => wanted.includes(t.id));
  if (tasks.length !== wanted.length) throw new Error(`unknown task in ${values.task}`);
  const fx = startFixtures(0);
  const reps = Number(values.reps);
  const budget = Number(values.budget);
  const runs: SpeedRun[] = [];
  let spent = 0;
  sweep(env);
  try {
    outer: for (let rep = 1; rep <= reps; rep++) {
      for (const task of tasks) {
        if (spent > budget) { console.error(`budget $${budget} reached after $${spent.toFixed(2)}; stopping`); break outer; }
        const r = await runOne(
          task, rep,
          { model: values.model!, system, origin: fx.origin, env, scratch, maxRunUsd: Number(values["max-run-usd"]), timeoutMs: Number(values.timeout) * 1000, id: `spd-${rep}-${task.id}`.slice(0, 24) },
          () => fx.state.beacons,
          async () => { fx.state.beacons = {}; },
        );
        spent += r.usd;
        runs.push(r);
        console.error(`${task.id}#${rep}: ${r.pass ? "pass" : "FAIL"} rounds=${r.rounds} in=${r.inTokens} out=${r.outTokens} ${r.seconds}s $${r.usd.toFixed(3)}${r.stopped ? ` (${r.stopped})` : ""}`);
      }
    }
  } finally {
    fx.server.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
  const rows = summarize(runs);
  writeFileSync(resolve(values.out), JSON.stringify({ label: values.label, model: values.model, spent, rows, runs }, null, 1));
  console.log(toMarkdown(values.label, rows) + `\ncost $${spent.toFixed(2)}`);
}

if (import.meta.main) await main();

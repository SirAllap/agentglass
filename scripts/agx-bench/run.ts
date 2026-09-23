#!/usr/bin/env bun
/**
 * agx-bench: scripted agent tasks against the built-in browser, through the
 * CLI an agent uses, with no model in the loop.
 *
 *   scripts/agx-bench/instance.sh start /tmp/agx-bench        # an isolated app
 *   bun scripts/agx-bench/run.ts --instance /tmp/agx-bench --reps 3
 *   scripts/agx-bench/instance.sh stop /tmp/agx-bench
 *
 * Flags:
 *   --instance DIR   an instance.sh directory: its port, its token, its caches
 *   --server URL     or name a server directly (token from AGENTGLASS_TOKEN)
 *   --reps N         repetitions of every task and arm (default 3)
 *   --arm a,b        arms to run (default baseline)
 *   --task a,b       tasks to run (default all)
 *   --out DIR        where results.json and results.md go (default: a new
 *                    directory under the system temp dir — never the tree)
 *   --as NAME        the browser identity every call carries (default agx-bench)
 *
 * Every call is `python3 bin/agentglass-browser --as NAME <verb> ...`, run as
 * its own process, timed from spawn to exit — the latency an agent's shell
 * sees, process start included — and its stdout and stderr counted in bytes.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runArm, Session, type Exec } from "./bench.ts";
import { freshState, startFixtures, type BenchState } from "./fixtures.ts";
import { buildResults, toMarkdown } from "./report.ts";
import { TASKS } from "./tasks.ts";
import type { Run } from "./metrics.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = join(ROOT, "bin", "agentglass-browser");

export type Options = {
  server: string;
  token?: string;
  instance?: string;
  reps: number;
  arms: string[];
  tasks: string[];
  out: string;
  as: string;
};

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      instance: { type: "string" },
      server: { type: "string" },
      reps: { type: "string", default: "3" },
      arm: { type: "string", default: "baseline" },
      task: { type: "string" },
      out: { type: "string" },
      as: { type: "string", default: "agx-bench" },
    },
    strict: true,
  });
  const instance = values.instance ? resolve(values.instance) : undefined;
  let server = values.server;
  let token = process.env.AGENTGLASS_TOKEN;
  if (instance) {
    server ??= `http://127.0.0.1:${readFileSync(join(instance, "port"), "utf8").trim()}`;
    token = readFileSync(join(instance, "cfg", "agentglass", "token"), "utf8").trim();
  }
  if (!server) throw new Error("name the app: --instance DIR (from instance.sh) or --server URL");
  const reps = Number(values.reps);
  if (!Number.isInteger(reps) || reps < 1) throw new Error(`--reps must be a positive integer, got ${values.reps}`);
  const arms = values.arm!.split(",").filter(Boolean);
  const tasks = values.task ? values.task.split(",").filter(Boolean) : TASKS.map((t) => t.id);
  for (const t of tasks) if (!TASKS.some((x) => x.id === t)) throw new Error(`no task ${t}`);
  for (const a of arms) if (!TASKS.some((x) => a in x.arms)) throw new Error(`no task has an arm ${a}`);
  return {
    server,
    token,
    instance,
    reps,
    arms,
    tasks,
    out: values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), "agx-bench-results-")),
    as: values.as!,
  };
}

/** The CLI's environment: the app it talks to, and — with an instance — that
 *  instance's config and caches, so its tab memory is not the person's. */
export function cliEnv(o: Options, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const k of ["TMUX", "TMUX_PANE", "AGENTGLASS_TOKEN"]) delete env[k];
  env.AGENTGLASS_SERVER = o.server;
  if (o.token) env.AGENTGLASS_TOKEN = o.token;
  if (o.instance) {
    env.XDG_CONFIG_HOME = join(o.instance, "cfg");
    env.XDG_CACHE_HOME = join(o.instance, "cache");
    env.AGENTGLASS_BROWSER_STATE_DIR = join(o.instance, "browser");
  }
  return env;
}

function processExec(env: Record<string, string>): Exec {
  return async (argv) => {
    const p = Bun.spawn(["python3", CLI, ...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exit, stdout, stderr };
  };
}

function commit(): string {
  const sha = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  const dirty = Bun.spawnSync(["git", "-C", ROOT, "status", "--porcelain", "--untracked-files=no"]).stdout.toString().trim();
  return sha + (dirty ? "-dirty" : "");
}

export async function main(argv: string[]) {
  const o = parseOptions(argv);
  const env = cliEnv(o);
  const exec = processExec(env);
  const fx = startFixtures(0);
  const control = {
    state: async (): Promise<BenchState> => structuredClone(fx.state),
    set: async (patch: Partial<BenchState>) => void Object.assign(fx.state, patch),
  };
  const globals = ["--as", o.as];
  const startedAt = new Date().toISOString();
  const loadAtStart = loadavg()[0];
  const runs: Run[] = [];
  try {
    // Warm-up, not measured: the first call of a run makes the identity's tab,
    // which no later rep pays for, and would otherwise land on rep 1 alone.
    const warm = await exec([...globals, "open", fx.origin + "/"]);
    if (warm.exit !== 0) throw new Error(`the browser is not answering: ${(warm.stderr || warm.stdout).trim()}`);
    for (let rep = 1; rep <= o.reps; rep++) {
      for (const task of TASKS.filter((t) => o.tasks.includes(t.id))) {
        for (const arm of o.arms.filter((a) => a in task.arms)) {
          Object.assign(fx.state, freshState());
          const s = new Session(exec, globals, fx.origin, control);
          const r = await runArm(task, arm, rep, s);
          runs.push(r);
          console.error(
            `rep ${rep} ${task.id.padEnd(15)} ${arm.padEnd(10)} ${r.ok ? "ok  " : "FAIL"} ` +
              `${Math.round(r.wallMs)} ms, ${r.steps} steps, ${r.bytes} B${r.ok ? "" : ` — ${r.error}`}`,
          );
        }
      }
    }
  } finally {
    fx.server.stop(true);
  }
  const results = buildResults(
    { startedAt, commit: commit(), reps: o.reps, arms: o.arms, server: o.server,
      host: `${process.platform}-${process.arch}`, load: [loadAtStart, loadavg()[0]] },
    runs,
  );
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  const md = toMarkdown(results);
  writeFileSync(join(o.out, "results.md"), md);
  console.log(md);
  console.log(`results: ${join(o.out, "results.json")}`);
  // A failed task is a result, not a broken run: the baseline is expected to
  // miss what it cannot see today. Only a harness that could not run exits
  // non-zero.
  return 0;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}

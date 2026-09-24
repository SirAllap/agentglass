/**
 * The harness: a task is graded by the fixture server, an arm is a script of
 * CLI calls, and a Session is what an arm talks through — it runs each call,
 * times it, and counts what it printed, which is what an agent would have
 * paid for it in context.
 */
import { runFromCalls, type Call, type Run } from "./metrics.ts";
import type { BenchState } from "./fixtures.ts";

export type Exec = (argv: string[]) => Promise<{ exit: number; stdout: string; stderr: string }>;

export type CliResult = {
  exit: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON when it is JSON, else undefined. */
  json: any;
  ms: number;
};

/** One MCP session: the handshake, then `messages`, answered as JSON-RPC
 *  replies in order. `profile` is AGENTGLASS_MCP_TOOLS. */
export type McpExec = (profile: string, messages: unknown[]) => Promise<{ replies: any[]; stdout: string; stderr: string }>;

export class StepFailed extends Error {}

/** What an arm is handed. Every browser call goes through `cli`, so no arm
 *  can do work the benchmark does not see. */
export class Session {
  readonly calls: Call[] = [];
  edits = 0;

  constructor(
    private readonly exec: Exec,
    /** Flags every call carries before the verb, e.g. `--as agx-bench`. */
    private readonly globals: string[],
    /** Where the fixtures are served, e.g. `http://127.0.0.1:4841`. */
    readonly origin: string,
    private readonly control: {
      state: () => Promise<BenchState>;
      set: (patch: Partial<BenchState>) => Promise<void>;
    },
    private readonly now: () => number = () => performance.now(),
    private readonly mcpExec?: McpExec,
  ) {}

  /**
   * One MCP conversation, counted as ONE call whose bytes are everything the
   * server said — the `tools/list` a client re-reads every turn included,
   * which is the number the MCP profiles exist to shrink.
   */
  async mcp(profile: "full" | "core" | "generic", messages: unknown[]) {
    if (!this.mcpExec) throw new StepFailed("this run has no MCP executor");
    const t0 = this.now();
    const r = await this.mcpExec(profile, messages);
    const ms = this.now() - t0;
    this.calls.push({
      verb: `mcp:${profile}`,
      argv: [profile, `${messages.length} messages`],
      ms,
      exit: 0,
      stdoutBytes: Buffer.byteLength(r.stdout),
      stderrBytes: Buffer.byteLength(r.stderr),
    });
    return r;
  }

  url(path: string) {
    return this.origin + path;
  }

  /**
   * Run one CLI verb. A non-zero exit throws unless `allowFail` — a scripted
   * arm has no judgement to recover with, so a failed step is a failed task.
   */
  async cli(verb: string, args: string[] = [], opts: { allowFail?: boolean } = {}): Promise<CliResult> {
    const argv = [...this.globals, verb, ...args];
    const t0 = this.now();
    const r = await this.exec(argv);
    const ms = this.now() - t0;
    this.calls.push({
      verb,
      argv,
      ms,
      exit: r.exit,
      stdoutBytes: Buffer.byteLength(r.stdout),
      stderrBytes: Buffer.byteLength(r.stderr),
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
    if (r.exit !== 0 && !opts.allowFail) {
      throw new StepFailed(`${verb} ${args.join(" ")} exited ${r.exit}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    return { ...r, json, ms };
  }

  /** Change the fixture outside the browser — the dev loop's code edit. It is
   *  counted as an edit, never as a browser step. */
  async edit(patch: Partial<BenchState>) {
    this.edits++;
    await this.control.set(patch);
  }

  state() {
    return this.control.state();
  }
}

/** An arm: how one approach solves one task. It returns its answer. */
export type Arm = (s: Session) => Promise<unknown>;

export type Task = {
  id: string;
  family: "navigation" | "form" | "devloop" | "measure" | "phase2";
  title: string;
  /** Keyed by arm name. `baseline` is how an agent drives the CLI today; a new
   *  approach adds its own key here and nothing else changes. */
  arms: Record<string, Arm>;
  /** Grade the answer against the fixture server: null when right, else why not. */
  grade: (answer: any, state: BenchState) => string | null;
};

/** A tree node as `observe` returns it. */
export type Node = { e: string; role?: string; name?: string; id?: string; testid?: string };

/**
 * Find one node in an `observe` tree the way an agent reading it would: by
 * role and by name. Two matches is an error, not a guess — an arm that clicks
 * the first of two is measuring luck.
 */
export function pick(tree: Node[] | undefined, role: string, name: string | RegExp): Node {
  const hits = (tree ?? []).filter(
    (n) => n.role === role && (typeof name === "string" ? n.name === name : name.test(n.name ?? "")),
  );
  if (hits.length !== 1) throw new StepFailed(`expected one ${role} named ${name}, found ${hits.length}`);
  return hits[0];
}

/**
 * What an agent holds after a run of looks: the tree of the last full answer
 * with every delta since applied to it — how a caller reads `observe --delta`
 * and the `after` of an act verb's `--observe`. `console` and `network` are
 * what the LAST look reported (a delta's are only the rows new since the look
 * before it). `unlisted` ids are still on the page, past the tree's cap, so
 * their nodes are kept. An arm that uses deltas keeps one of these per page.
 */
export class View {
  tree: Node[] = [];
  url = "";
  title = "";
  console: any[] = [];
  network: any[] = [];
  /** How many answers were full and how many were deltas — so a run can show
   *  the fallback (a navigation answers in full) actually happened. */
  fulls = 0;
  deltas = 0;

  apply(o: any): this {
    if (!o || typeof o !== "object") throw new StepFailed("no observation to apply");
    if (o.delta === true) {
      const gone = new Set<string>(o.removed ?? []);
      const changed = new Map<string, Record<string, unknown>>((o.changed ?? []).map((c: Node) => [c.e, c]));
      this.tree = this.tree
        .filter((n) => !gone.has(n.e))
        .map((n) => {
          const c = changed.get(n.e);
          if (!c) return n;
          const m: Record<string, unknown> = { ...n };
          for (const [k, v] of Object.entries(c)) if (v === null) delete m[k]; else m[k] = v;
          return m as Node;
        })
        .concat(o.added ?? []);
      this.deltas++;
    } else {
      if (!Array.isArray(o.tree)) throw new StepFailed("observe did not return a tree");
      this.tree = o.tree;
      this.fulls++;
    }
    this.url = o.url ?? this.url;
    this.title = o.title ?? this.title;
    this.console = o.console ?? [];
    this.network = o.network ?? [];
    return this;
  }
}

/** The `after` block of an act verb run with `--observe`. A look that failed
 *  after an action that worked is a failed step for a scripted arm. */
export function afterOf(r: CliResult): any {
  const v = r.json;
  if (v?.afterFailed) throw new StepFailed(`the look after ${r.stdout.slice(0, 40)} failed: ${v.afterFailed}`);
  if (!v?.after) throw new StepFailed("--observe returned no `after`");
  return v.after;
}

export async function runArm(
  task: Task,
  armName: string,
  rep: number,
  session: Session,
  timeoutMs = 120_000,
  now: () => number = () => performance.now(),
): Promise<Run> {
  const arm = task.arms[armName];
  if (!arm) throw new Error(`task ${task.id} has no arm ${armName}`);
  const t0 = now();
  let ok = false;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      arm(session),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    error = task.grade(answer, await session.state()) ?? undefined;
    ok = error === undefined;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  return runFromCalls(
    { task: task.id, family: task.family, arm: armName, rep, ok, error, wallMs: now() - t0, edits: session.edits },
    session.calls,
  );
}

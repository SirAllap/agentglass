/**
 * `AGX_LOAD_AGENTS=N bun scripts/loadtest.ts` — does the terminal stay
 * responsive with N agents working at once?
 *
 * The other loadtest modes hammer the panels. This one is the machine as it is
 * on a busy day: N agents, each a tmux pane printing at a steady rate, a
 * transcript .jsonl growing under the projects dir the scanner sweeps, and hook
 * events POSTed to /ingest. A few big transcripts are already on disk at boot,
 * the way a real ~/.claude is. While that runs one more pane is typed into
 * through the real terminal WebSocket and the time until each echo returns is
 * the number that matters.
 *
 * Isolation is total, because this starts a server and a server talks to tmux:
 * config, data, cache, state dir, DB and TMUX_TMPDIR are all under one temp
 * dir, tmux runs on its own `-L agx-load` socket with `-f /dev/null` and no
 * $TMUX, and teardown ends with `kill-server -L`. The transcripts dir is
 * handed to the server through AGENTGLASS_PROJECTS_DIR, its real knob, so
 * nothing reads ~/.claude and no credential is read or needed (the server is
 * started with an empty AGENTGLASS_TOKEN).
 *
 * The load runs in a child process, the measuring in this one, for the reason
 * loadtest.ts gives: a harness that generates load on its own loop measures
 * itself.
 *
 *   AGX_LOAD_AGENTS=20        agents (default 20)
 *   AGX_LOAD_SECONDS=120      measure window; AGX_LOAD_WARMUP_S=15 before it
 *   AGX_LOAD_TX_MB=100        big transcripts on disk at boot, total MB (CI: 20)
 *   AGX_LOAD_OUT=file.json    write the numbers here
 *   AGX_LOAD_BUDGET=1         check scripts/perf-budget.txt, exit 1 if over
 *
 * Off by default, each one a real-use ingredient the plain run lacks:
 *   AGX_LOAD_DB_MB=1000       a DB seeded to this size before the window (loadseed.ts).
 *                             The seed is cached in ~/.cache/agx-load (never /tmp, it is
 *                             RAM) and copied per run; AGX_LOAD_DB_CLEAN=1 deletes it after.
 *   AGX_LOAD_DISK=1           a background writer on the DB's filesystem during the window:
 *                             write+fsync files, create and remove a worktree-sized tree.
 *   AGX_LOAD_TMUX_SLOW=1      every tmux the server runs sleeps AGX_LOAD_TMUX_SLOW_MS (300)
 *                             first, through AGENTGLASS_TMUX_PATH.
 *   AGX_LOAD_REPEAT=3         run the whole thing this many times; median and worst of each.
 *   AGX_LOAD_RELAY=1          the server runs its terminal relay (AGENTGLASS_TERMRELAY=1) and the typed
 *                             pane connects through it, the way the window does. Same run without it is
 *                             the comparison: the echo numbers are the old door's.
 *   AGX_LOAD_PROJECTS=3       the agents are spread over this many invented git repositories made in
 *                             the scratch dir (acme-orbit, acme-comet, ...), each with a few commits and
 *                             AGX_LOAD_WORKTREES (default 2) worktrees on branches of their own. Panes,
 *                             transcripts and hook events point at them, so the server's git, worktree
 *                             and board code runs; a commit and a branch switch land in a random
 *                             checkout every 2-4 s. No repository has a remote, and `gh` on the
 *                             server's PATH is a stub that fails as if offline: nothing leaves the machine.
 *   AGX_LOAD_TABS=30          this many terminal sockets attached at once, each draining a printing
 *                             pane, the way open tabs do (through the relay with AGX_LOAD_RELAY=1).
 *                             Without it four are attached, as before. Echo is still timed on the one
 *                             probe pane. Each tab opens the way the desktop window's does: a desk on a
 *                             checkout (`root=`), one per worktree in turn (needs AGX_LOAD_PROJECTS).
 *                             Measured: 30 tabs by `pane=` (the phone's door) made 30 `agx-phone-…`
 *                             mirror sessions, 12 stalls of 5-8.8 s and git status 20 s server-side;
 *                             the same load by `root=` had 0 stalls and git status 0.73 s.
 *   AGX_LOAD_TABS_PHONE=1     with AGX_LOAD_TABS: attach by `pane=` instead, the phone's door.
 *   AGX_LOAD_SERVER_PROF=dir  the server runs under `bun --cpu-prof --cpu-prof-dir=dir`; at teardown it gets
 *                             SIGTERM and up to 15 s to exit, so Bun writes the profile (a SIGKILL writes none).
 *   AGX_LOAD_PANELS=1         a third process asks for what the window asks for with its panels open:
 *                             the agent board every 5 s and the session list every 30 s (the cadences in
 *                             web/src/lib/lanternStore.ts and App.tsx), git status of every project
 *                             every 10 s, stats every 30 s, the PR list of every project and the week's
 *                             usage every 60 s (those four cadences are this script's round numbers, not
 *                             read from one constant). Each route's latency is reported, with how many
 *                             answers were not 2xx: a refused route is a number here, not a silence.
 *   AGX_LOAD_WINDOW=1         measure the WINDOW, where smoothness is felt: the server serves the built bundle
 *                             (web/dist, `cd web && bun run build` first; AGENTGLASS_WEB_DIR), headless Chrome
 *                             (scripts/cdp.ts) opens the first project as a workspace (the Terminal view has no repo
 *                             picker; a new shell opens in the open project), then the Terminal view and "New shell"
 *                             until AGX_LOAD_WINDOW_TABS shells are live (the report says picked/asked); a printer runs
 *                             in each but the last, which stays quiet and is typed into. On a failed step the page is
 *                             saved (screenshot, text, steps tried) to AGX_LOAD_WINDOW_DEBUG (default .agx-tmp/lw-fail). During the window the page
 *                             records long tasks, frame gaps (p50/p99/max, over 50 and 250 ms), JS heap, and the
 *                             time from a keystroke to its echo in the xterm rows (scripts/loadwindow.ts).
 *                             AGX_LOAD_WINDOW_RENDERER=dom (default) | canvas | auto: echo is readable only in
 *                             the DOM renderer; with canvas or auto the echo is empty and frames are the real ones.
 *                             AGX_LOAD_WINDOW_TABS=6 live shells (default 6).
 *                             AGX_LOAD_WINDOW_ELECTRON=1 measure the REAL Electron shell (electron/main.js, isolated
 *                             config dirs, attached to the load server through AGENTGLASS_PORT) instead of headless
 *                             Chrome; on Hyprland it opens on workspace 5 silent. The report says if frames arrived.
 *   AGX_LOAD_FLOOD=K          K agents print as fast as they can (`yes`) instead of the steady rate; with
 *                             AGX_LOAD_WINDOW=1 the first K window desks flood too. Run with and without it:
 *                             the flood case against the plain one.
 *   bun scripts/loadtest.ts --compare a.json b.json
 *                             two AGX_LOAD_OUT files side by side (the median run of each when they
 *                             hold several): the before/after table.
 * With the DB or the disk option the scratch dir moves from /tmp to ~/.cache/agx-load,
 * so the DB and the writer share the real filesystem.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync, chmodSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildHeavyTranscripts } from "./heavytx.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";
import { LoadWindow, type WindowResult } from "./loadwindow.ts";

const ROOT = resolve(import.meta.dir, "..");
const N = Math.max(1, Number(process.env.AGX_LOAD_AGENTS || 20));
const SECONDS = Math.max(5, Number(process.env.AGX_LOAD_SECONDS || 120));
const RELAY = process.env.AGX_LOAD_RELAY === "1";
const WARMUP_S = Math.max(2, Number(process.env.AGX_LOAD_WARMUP_S || 15));
const TX_MB = Math.max(0, Number(process.env.AGX_LOAD_TX_MB ?? 100));
const SOCK = "agx-load";
const CLK = 100; // sysconf(_SC_CLK_TCK) on Linux

const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((q / 100) * a.length))] ?? 0;
};
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : 0 });
const PROJECTS_N = Math.max(0, Math.floor(Number(process.env.AGX_LOAD_PROJECTS || 0)));
const WORKTREES = Math.max(0, Math.floor(Number(process.env.AGX_LOAD_WORKTREES ?? 2)));
const TABS = Math.max(0, Math.floor(Number(process.env.AGX_LOAD_TABS || 0)));
const PANELS = process.env.AGX_LOAD_PANELS === "1";
const WINDOW = process.env.AGX_LOAD_WINDOW === "1";
const FLOOD = Math.max(0, Math.floor(Number(process.env.AGX_LOAD_FLOOD || 0)));
const WINDOW_ELECTRON = process.env.AGX_LOAD_WINDOW_ELECTRON === "1";
const WINDOW_TABS = Math.max(1, Math.floor(Number(process.env.AGX_LOAD_WINDOW_TABS || 6)));
const WINDOW_RENDERER = (["dom", "canvas", "auto"].includes(process.env.AGX_LOAD_WINDOW_RENDERER || "") ? process.env.AGX_LOAD_WINDOW_RENDERER : "dom") as "dom" | "canvas" | "auto";
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** git for the invented repositories: no global or system config (so no hook, no signing, no
 *  credential helper of the person running this), a made-up author, and never a prompt. */
const gitEnv = (base: Record<string, string | undefined>): Record<string, string | undefined> => ({
  ...base,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Load Test", GIT_AUTHOR_EMAIL: "load@example.invalid",
  GIT_COMMITTER_NAME: "Load Test", GIT_COMMITTER_EMAIL: "load@example.invalid",
});
/** One checkout the churn loop works in, and the two branches it moves between. */
type Churn = { dir: string; a: string; b: string };

// ============================================================================
// WORKER. Re-invoked as `AGX_LOAD_AGENTS_WORKER=1`: the N agents' transcript
// writers and hook-event posters, plus a few attached terminals draining
// output the way open browser tabs do. Nothing here is timed.
// ============================================================================
/** The disk writer: what a test run does to the filesystem the DB lives on. */
async function diskWriter() {
  const dir = process.env.AGX_LOAD_DISK_DIR!;
  const until = Date.now() + Number(process.env.AGX_LOAD_RUN_MS);
  const { openSync, writeSync, fsyncSync, closeSync, mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const chunk = Buffer.alloc(1024 * 1024, 7);
  let round = 0;
  while (Date.now() < until) {
    // 16 MB written and fsynced, the way a build or a test DB does.
    const fd = openSync(join(dir, `big-${round % 3}.bin`), "w");
    for (let i = 0; i < 16; i++) writeSync(fd, chunk);
    fsyncSync(fd); closeSync(fd);
    // A worktree-sized tree: 40 dirs x 50 small files, then gone.
    const tree = join(dir, `tree-${round}`);
    for (let d = 0; d < 40; d++) { mk(join(tree, `d${d}`), { recursive: true }); for (let f = 0; f < 50; f++) wf(join(tree, `d${d}`, `f${f}.txt`), "line\n".repeat(40)); }
    rmSync(tree, { recursive: true, force: true });
    round++;
    await new Promise((r) => setTimeout(r, 300));
  }
  process.exit(0);
}

/** The window's panels, as requests: each route at its cadence, each answer timed. Its own process,
 *  so the agents' writers do not sit on the loop that takes the time. */
async function panelsPoller() {
  const S = process.env.AGX_LOAD_URL!;
  const roots = (process.env.AGX_LOAD_ROOTS || "").split("\n").filter(Boolean);
  const from = Number(process.env.AGX_LOAD_MEASURE_FROM);
  const until = Number(process.env.AGX_LOAD_MEASURE_UNTIL);
  const seen: Record<string, { ms: number[]; bad: number }> = {};
  const hit = async (name: string, path: string, body?: string) => {
    const a = performance.now();
    const ok = await fetch(S + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: S, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body, signal: AbortSignal.timeout(20_000),
    }).then(async (r) => { await r.arrayBuffer(); return r.ok; }).catch(() => false);
    const now = Date.now();
    if (now < from || now > until) return;
    const e = (seen[name] ??= { ms: [], bad: 0 });
    e.ms.push(performance.now() - a);
    if (!ok) e.bad++;
  };
  const every = async (ms: number, offset: number, fn: () => Promise<unknown>) => {
    await sleepMs(offset);
    while (Date.now() < until) { const a = Date.now(); await fn(); await sleepMs(Math.max(50, ms - (Date.now() - a))); }
  };
  const enc = encodeURIComponent;
  // Written as it goes: a loop that overruns the window (the PR list walks every root, each request up to 20 s) is
  // killed with the rest, and a file written only at the end was then never written.
  const dump = () => { const o: Record<string, object> = {}; for (const [k, e] of Object.entries(seen)) o[k] = { ...stats(e.ms), not_ok: e.bad }; writeFileSync(process.env.AGX_LOAD_PANELS_OUT!, JSON.stringify(o)); };
  setInterval(dump, 5_000);
  await Promise.all([
    every(5_000, 0, () => hit("agents board", "/agents/board")),
    every(30_000, 700, () => hit("sessions", "/sessions?limit=200")),
    every(30_000, 1_400, () => hit("stats", "/stats?window=3600000")),
    every(60_000, 2_100, () => hit("usage daily", "/usage/daily?days=7")),
    ...(roots.length ? [
      every(10_000, 2_800, () => hit("git status", "/git/status", JSON.stringify({ paths: roots }))),
      every(60_000, 3_500, async () => { for (const r of roots) await hit("pr list", `/prs/list?root=${enc(r)}&filter=all&state=open`); }),
    ] : []),
  ]);
  dump();
  process.exit(0);
}

async function worker() {
  if (process.env.AGX_LOAD_AGENTS_WORKER === "disk") return diskWriter();
  if (process.env.AGX_LOAD_AGENTS_WORKER === "panels") return panelsPoller();
  const S = process.env.AGX_LOAD_URL!;
  // The transcripts dir. It was AGX_LOAD_PROJECTS until that name became the option above.
  const projects = process.env.AGX_LOAD_TX_DIR!;
  const cwd = process.env.AGX_LOAD_CWD!;
  const cwds = (process.env.AGX_LOAD_CWDS || "").split("\n").filter(Boolean);
  const cwdOf = (i: number) => (cwds.length ? cwds[i % cwds.length]! : cwd);
  const churn: Churn[] = (() => { try { return JSON.parse(process.env.AGX_LOAD_CHURN || "[]") as Churn[]; } catch { return []; } })();
  // What this process did, for the parent's report: a run whose tabs never attached or whose
  // commits all failed must say so rather than look like a quiet machine.
  const tally = { tabs_open: 0, tabs_failed: 0, tab_bytes: 0, churn_commits: 0, churn_switches: 0, churn_errors: 0 };
  const save = () => { if (process.env.AGX_LOAD_WORKER_OUT) try { writeFileSync(process.env.AGX_LOAD_WORKER_OUT, JSON.stringify(tally)); } catch { /* next tick */ } };
  const saver = setInterval(save, 2000);
  const until = Date.now() + Number(process.env.AGX_LOAD_RUN_MS);
  const attach = (process.env.AGX_LOAD_ATTACH_PANES || "").split(",").filter(Boolean);
  const blob = "x".repeat(20 * 1024);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const J = JSON.stringify;

  const post = (body: object) =>
    fetch(`${S}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: J(body), signal: AbortSignal.timeout(8000) }).catch(() => {});

  async function agent(i: number) {
    const sid = `load-sess-${i}`;
    const dir = join(projects, `-tmp-agxload-${i}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sid}.jsonl`);
    const at = cwdOf(i);
    const line = (o: object) => appendFileSync(file, J({ cwd: at, sessionId: sid, timestamp: new Date().toISOString(), ...o }) + "\n");
    line({ type: "user", message: { role: "user", content: `work on ORBIT-${1000 + i}` } });
    let seq = 0;
    // Transcript writer: a tool_use, its result (1-20 KB), a reply with usage,
    // every 0.5-2 s.
    const writer = (async () => {
      while (Date.now() < until) {
        const tid = `tu-${i}-${seq++}`;
        const kb = 1 + Math.floor(Math.random() * 20);
        line({ type: "assistant", message: { id: `m-${tid}`, model: "claude-sonnet-4-5", role: "assistant", content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: "make test" } }], usage: { input_tokens: 900, output_tokens: 120 } } });
        line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: blob.slice(0, kb * 1024) }] } });
        await sleep(500 + Math.random() * 1500);
      }
    })();
    // Hook events: a Pre/Post pair about 3 times a second on average.
    const hooks = (async () => {
      let n = 0;
      while (Date.now() < until) {
        const tid = `hk-${i}-${n++}`;
        const base = { session_id: sid, source_app: "claude-code", payload: { cwd: at, project_path: at, tool_name: "Bash", tool_use_id: tid, tool_input: { command: "ls" } } };
        await post({ ...base, hook_event_type: "PreToolUse", tool_name: "Bash", timestamp: Date.now() });
        await sleep(50 + Math.random() * 300);
        await post({ ...base, hook_event_type: "PostToolUse", tool_name: "Bash", timestamp: Date.now(), payload: { ...base.payload, tool_response: { stdout: "ok" } } });
        await sleep(100 + Math.random() * 500);
      }
    })();
    await Promise.all([writer, hooks]);
  }

  const sockets: WebSocket[] = [];
  const WS = S.replace("http", "ws");
  // The door the window's tabs use: with the relay on, a one-use ticket each and the relay's port.
  const viaRelay = process.env.AGX_LOAD_RELAY === "1";
  // AGX_LOAD_TABS_DESK=1 (set by the parent for AGX_LOAD_TABS unless AGX_LOAD_TABS_PHONE=1): each tab opens the way
  // the desktop does, a desk on a checkout (`root=`), one per worktree in turn. Else it attaches to one agent's pane
  // (`pane=`), the phone's door: the server makes an `agx-phone-…` mirror session for each.
  const desks = process.env.AGX_LOAD_TABS_DESK === "1" ? (process.env.AGX_LOAD_CWDS || "").split("\n").filter(Boolean) : [];
  let tabNo = 0;
  for (const p of attach) {
    const target = desks.length ? `root=${encodeURIComponent(desks[tabNo++ % desks.length]!)}` : `pane=${encodeURIComponent(p)}`;
    let url = `${WS}/terminal/pty?${target}&cols=120&rows=30`;
    if (viaRelay) {
      const tk = await fetch(`${S}/terminal/relay-ticket?n=1`, { method: "POST", headers: { origin: S, "content-type": "application/json" }, body: "{}" })
        .then((r) => r.json() as Promise<{ relay?: boolean; port?: number; tickets?: string[] }>).catch(() => null);
      if (!tk?.relay || !tk.port || !tk.tickets?.[0]) { tally.tabs_failed++; continue; }
      url = `ws://127.0.0.1:${tk.port}/pty?t=${tk.tickets[0]}&${target}&cols=120&rows=30`;
    }
    const ws = new WebSocket(url, viaRelay ? ({ headers: { origin: S } } as never) : undefined);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => { tally.tabs_open++; });
    ws.addEventListener("error", () => { tally.tabs_failed++; });
    ws.addEventListener("message", (ev) => { if (typeof ev.data !== "string") tally.tab_bytes += (ev.data as ArrayBuffer).byteLength; });
    sockets.push(ws);
  }

  // A commit and a branch switch in a random checkout every 2-4 s: what agents at work do to
  // the repositories the server is watching.
  const churnLoop = async () => {
    const env = gitEnv(process.env);
    const git = async (dir: string, ...a: string[]) =>
      (await Bun.spawn(["git", ...a], { cwd: dir, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0;
    const on = new Map<string, string>();
    let n = 0;
    while (Date.now() < until && churn.length) {
      const c = churn[Math.floor(Math.random() * churn.length)]!;
      const next = (on.get(c.dir) ?? c.a) === c.a ? c.b : c.a;
      if (await git(c.dir, "switch", "-q", next)) { on.set(c.dir, next); tally.churn_switches++; } else tally.churn_errors++;
      try { appendFileSync(join(c.dir, "CHANGES.md"), `- change ${++n}\n`); } catch { tally.churn_errors++; }
      if ((await git(c.dir, "add", "CHANGES.md")) && (await git(c.dir, "commit", "-q", "-m", `orbit: change ${n}`))) tally.churn_commits++;
      else tally.churn_errors++;
      await sleep(2000 + Math.random() * 2000);
    }
  };

  await Promise.all([...Array.from({ length: N }, (_, i) => agent(i)), churnLoop()]);
  clearInterval(saver);
  save();
  for (const ws of sockets) try { ws.close(); } catch { /* gone */ }
  process.exit(0);
}

// ============================================================================
// PARENT.
// ============================================================================
function ticks(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(f[11]) + Number(f[12]);
  } catch { return 0; }
}
const status = (pid: number, key: string): number => {
  try { return Number(new RegExp(`${key}:\\s+(\\d+)`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024; } catch { return 0; }
};

/** The relay is a child of the server that carries AGENTGLASS_RELAY_CHILD=1; null when there is none. */
function relayPidOf(serverPid: number): number | null {
  const kids = spawnSync("pgrep", ["-P", String(serverPid)], { encoding: "utf8" }).stdout.split("\n").map(Number).filter(Boolean);
  for (const k of kids) {
    try { if (readFileSync(`/proc/${k}/environ`, "utf8").split("\0").includes("AGENTGLASS_RELAY_CHILD=1")) return k; } catch { /* gone */ }
  }
  return null;
}

/** Invented names only: these become directory and branch names on disk. */
const PROJECT_NAMES = ["orbit", "comet", "atlas", "quasar", "nova", "lumen", "pulsar", "zenith"];

/**
 * N small repositories with W worktrees each, no remote. Returns every checkout (the agents'
 * working directories), the primary checkouts (what the panels ask about) and the churn list.
 */
function makeProjects(codeDir: string, n: number, w: number, base: Record<string, string>): { trees: string[]; roots: string[]; churn: Churn[] } {
  const env = gitEnv(base);
  const git = (dir: string, ...a: string[]) => {
    const r = spawnSync("git", a, { cwd: dir, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} in ${dir}: ${r.stderr || r.stdout}`);
  };
  const trees: string[] = [], roots: string[] = [], churn: Churn[] = [];
  for (let p = 0; p < n; p++) {
    const name = `acme-${PROJECT_NAMES[p % PROJECT_NAMES.length]}${p >= PROJECT_NAMES.length ? `-${Math.floor(p / PROJECT_NAMES.length) + 1}` : ""}`;
    const root = join(codeDir, name);
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    for (let f = 0; f < 30; f++) writeFileSync(join(root, "src", `part-${f}.ts`), `export const part${f} = ${f};\n`.repeat(40));
    writeFileSync(join(root, "CHANGES.md"), `# ${name}\n`);
    git(root, "add", "src", "CHANGES.md");
    git(root, "commit", "-q", "-m", `${name}: first parts`);
    for (let c = 1; c <= 3; c++) {
      appendFileSync(join(root, "src", `part-${c}.ts`), `export const more${c} = ${c};\n`);
      git(root, "add", `src/part-${c}.ts`);
      git(root, "commit", "-q", "-m", `${name}: part ${c} grows`);
    }
    git(root, "branch", "next");
    trees.push(root); roots.push(root);
    churn.push({ dir: root, a: "main", b: "next" });
    for (let j = 1; j <= w; j++) {
      const branch = `feat/ORBIT-${1000 + p * 10 + j}`;
      const wt = join(codeDir, `${name}-wt${j}`);
      git(root, "worktree", "add", "-q", "-b", branch, wt);
      git(root, "branch", `${branch}-alt`, branch);
      trees.push(wt);
      churn.push({ dir: wt, a: branch, b: `${branch}-alt` });
    }
  }
  return { trees, roots, churn };
}

function loadBudget(): Record<string, number> {
  const out: Record<string, number> = {};
  const txt = readFileSync(join(ROOT, "scripts", "perf-budget.txt"), "utf8");
  for (const l of txt.split("\n")) {
    const m = /^\s*([a-z0-9_]+)\s+([0-9.]+)\s*(#.*)?$/.exec(l);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** One keystroke at a time, five a second, timing each echo. The pause is a
 *  setTimeout promise, not `Bun.sleep`: on Bun 1.3.9 a loop that awaited
 *  `Bun.sleep` beside a pending WebSocket echo stopped for good after about 25
 *  turns (measured: 25 samples, then none, no error), while the same loop on
 *  setTimeout ran all 81 of 81. */
async function typeEchoes(
  ws: WebSocket, probe: { pending: (() => void) | null }, flag: { measuring: boolean; stop: boolean },
  echo: number[], onErr: (m: string) => void, onTimeout: () => void,
): Promise<void> {
  let k = 0;
  while (!flag.stop) {
    const a = performance.now();
    const took = await new Promise<number>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      probe.pending = () => { clearTimeout(timer); resolve(performance.now() - a); };
      try { ws.send(JSON.stringify({ t: "in", d: "x" })); } catch { probe.pending = null; onErr(`ws not sendable (readyState ${ws.readyState})`); resolve(-1); return; }
      timer = setTimeout(() => { if (probe.pending) { probe.pending = null; if (flag.measuring) onTimeout(); resolve(5000); } }, 5000);
    });
    if (flag.measuring && took >= 0) echo.push(took);
    if (++k % 20 === 0) { try { ws.send(JSON.stringify({ t: "in", d: "\x15" })); } catch { /* closed */ } }
    await new Promise<void>((r) => setTimeout(r, Math.max(1, 200 - (performance.now() - a))));
  }
}

const DB_MB = Math.max(0, Number(process.env.AGX_LOAD_DB_MB || 0));
const DISK = process.env.AGX_LOAD_DISK === "1";
const TMUX_SLOW = process.env.AGX_LOAD_TMUX_SLOW === "1";
const TMUX_SLOW_MS = Math.max(0, Number(process.env.AGX_LOAD_TMUX_SLOW_MS || 300));
const REPEAT = Math.max(1, Number(process.env.AGX_LOAD_REPEAT || 1));
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agx-load");

async function once(): Promise<{ res: Record<string, any> | null; failed: boolean }> {
  let resOut: Record<string, any> | null = null;
  // Scratch on the real filesystem when the DB or the disk writer is in play;
  // /tmp is RAM here and would hide exactly the waits those options exist for.
  const scratch = DB_MB || DISK ? CACHE : tmpdir();
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(join(scratch, "agx-load-agents-"));
  const home = join(base, "home");
  const projects = join(base, "projects");
  const cwd = join(base, "repo");
  const state = join(home, "state");
  for (const d of [home, projects, cwd, state, join(home, "config"), join(home, "data"), join(home, "cache")]) mkdirSync(d, { recursive: true });
  const tmuxTmp = privateTmuxDir(home);
  // The caller's own AGENTGLASS_* variables are dropped wholesale: inside an
  // agentglass session they carry the live token, its bind address, the
  // desktop's fd and the skill auto-update switch, and none may reach the
  // isolated server (a 0.0.0.0 bind makes it demand a token we must not have).
  const tenv: Record<string, string> = { TMUX_TMPDIR: tmuxTmp };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENTGLASS_") && k !== "TMUX" && k !== "TMUX_TMPDIR") tenv[k] = v;
  const tmux = (...a: string[]) => spawnSync("tmux", ["-L", SOCK, "-f", "/dev/null", ...a], { env: tenv, encoding: "utf8" });

  let server: ReturnType<typeof spawn> | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let diskChild: ReturnType<typeof spawn> | null = null;
  let panelsChild: ReturnType<typeof spawn> | null = null;
  let win: LoadWindow | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    try { child?.kill(); } catch { /* gone */ }
    try { diskChild?.kill("SIGKILL"); } catch { /* gone */ }
    try { panelsChild?.kill("SIGKILL"); } catch { /* gone */ }
    try { win?.close(); } catch { /* gone */ }
    // AGX_LOAD_SERVER_PROF: SIGTERM first and up to 15 s to exit, so Bun writes its --cpu-prof on the way out.
    if (process.env.AGX_LOAD_SERVER_PROF && server?.pid) {
      try { server.kill("SIGTERM"); } catch { /* gone */ }
      for (let i = 0; i < 300 && existsSync(`/proc/${server.pid}`); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    try { server?.kill("SIGKILL"); } catch { /* gone */ }
    tmux("kill-server");
    // Wait for the server to be really gone: one still dying rewrites its
    // state dir after the rm and leaves the temp dir behind.
    for (let i = 0; i < 40 && server?.pid && existsSync(`/proc/${server.pid}`); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    rmSync(base, { recursive: true, force: true });
    if (process.env.AGX_LOAD_DB_CLEAN === "1") rmSync(CACHE, { recursive: true, force: true });
  };
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { cleanup(); process.exit(1); });

  let failed = false;
  try {
    // --- fixtures -----------------------------------------------------------
    let txNote = "none";
    if (TX_MB > 0) {
      const files = Math.max(1, Math.min(4, Math.ceil(TX_MB / 25)));
      const built = buildHeavyTranscripts(projects, { files, fileMb: Math.max(1, Math.round(TX_MB / files)), giantLineMb: 2, giantPerFile: 1, mediumLineKb: 4, cwd });
      txNote = `${(built.bytes / 1_048_576).toFixed(0)}MB in ${built.files.length} files at boot`;
    }

    // --- projects: invented repositories the agents work in -----------------
    const made = PROJECTS_N > 0 ? makeProjects(join(base, "code"), PROJECTS_N, WORKTREES, tenv) : { trees: [], roots: [], churn: [] };
    const cwdFor = (i: number) => (made.trees.length ? made.trees[i % made.trees.length]! : cwd);
    // `gh` as the server will find it: a stub that fails the way a machine with no network does.
    // Nothing here has a remote and the config dir is empty, so nothing would reach GitHub anyway;
    // the stub makes that a property of the run instead of a hope.
    const stubBin = join(base, "stub");
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(join(stubBin, "gh"), "#!/bin/sh\necho 'error connecting to api.github.com (load test stub: offline)' >&2\nexit 1\n");
    chmodSync(join(stubBin, "gh"), 0o755);

    // --- panes: one printing pane per agent, plus one echo probe ------------
    // Each prints a 500-byte line ten times a second (~5 KB/s); every fifth
    // agent also writes a 1 MB burst every 20 s, to push on backpressure.
    // AGX_LOAD_FLOOD=K: the first K agents print flat out instead.
    const printer = (i: number) => i < FLOOD ? `exec yes agent${i}-flood` :
      `s=$(printf 'agent${i}-%.0s' {1..60}); n=0; while :; do printf '%s\\n' "$s"; n=$((n+1)); if [ ${i % 5} = 0 ] && [ $((n % 200)) = 0 ]; then head -c 1000000 /dev/zero | tr '\\0' y; echo; fi; sleep 0.1; done`;
    const first = tmux("new-session", "-d", "-s", "load", "-x", "160", "-y", "40", "-c", cwd, "-n", "probe", "env", "PS1=$ ", "bash", "--norc", "-i");
    if (first.status !== 0) throw new Error(`tmux new-session failed: ${first.stderr}`);
    for (let i = 0; i < N; i++) tmux("new-window", "-d", "-t", "load:", "-c", cwdFor(i), "-n", `agent${i}`, "bash", "--norc", "-c", printer(i));
    const panes = tmux("list-panes", "-a", "-F", "#{pane_id} #{window_name}").stdout.trim().split("\n").map((l) => l.split(" "));
    const probePane = panes.find((p) => p[1] === "probe")?.[0];
    if (!probePane) throw new Error("no probe pane");
    // Four attached sockets as before, or AGX_LOAD_TABS of them, going round the agents' panes
    // again when there are more tabs than agents (two tabs on one pane is two sockets to feed).
    const agentPanes = panes.filter((p) => p[1]?.startsWith("agent")).map((p) => p[0]!);
    const attachPanes = Array.from({ length: TABS > 0 ? TABS : Math.min(N, 4) }, (_, k) => agentPanes[k % agentPanes.length]!);

    // --- the DB: a cached seed, copied in, before the window -----------------
    if (DB_MB > 0) {
      const seed = join(CACHE, `seed-${DB_MB}.db`);
      if (!existsSync(seed)) {
        console.log(`loadtest: seeding ${DB_MB} MB DB once into ${seed} (cached for later runs)`);
        const part = join(CACHE, `seed-${DB_MB}.part.db`);
        rmSync(part, { force: true }); rmSync(`${part}-wal`, { force: true }); rmSync(`${part}-shm`, { force: true });
        const r = spawnSync("bun", [join(ROOT, "scripts", "loadseed.ts"), part, String(DB_MB)], {
          env: { ...tenv, AGENTGLASS_DB: part, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), AGENTGLASS_STATE_DIR: state, TMUX_TMPDIR: privateTmuxDir(home) },
          encoding: "utf8",
        });
        if (r.status !== 0) throw new Error(`seeding failed: ${r.stderr || r.stdout}`);
        console.log(`  ${r.stdout.trim()}`);
        renameSync(part, seed);
        rmSync(`${part}-wal`, { force: true }); rmSync(`${part}-shm`, { force: true });
      }
      copyFileSync(seed, join(home, "load.db"));
    }
    // --- slow tmux: a wrapper the server is told to use ----------------------
    let tmuxPath: string | undefined;
    if (TMUX_SLOW) {
      const real = Bun.which("tmux")!;
      const wrap = join(base, "bin", "tmux");
      mkdirSync(join(base, "bin"), { recursive: true });
      writeFileSync(wrap, `#!/bin/sh\nsleep ${(TMUX_SLOW_MS / 1000).toFixed(3)}\nexec ${real} "$@"\n`);
      chmodSync(wrap, 0o755);
      tmuxPath = wrap;
    }

    // --- server -------------------------------------------------------------
    const probeSock = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probeSock.port;
    probeSock.stop(true);
    const S = `http://127.0.0.1:${port}`;
    const prof = process.env.AGX_LOAD_SERVER_PROF ? ["--cpu-prof", `--cpu-prof-dir=${process.env.AGX_LOAD_SERVER_PROF}`] : [];
    server = spawn("bun", [...prof, join(ROOT, "server", "src", "index.ts")], {
      cwd: base,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...tenv,
        PATH: `${stubBin}:${tenv.PATH ?? ""}`,
        AGENTGLASS_PORT: String(port),
        AGENTGLASS_BIND: "127.0.0.1",
        AGENTGLASS_SKILL_AUTOUPDATE: "0",
        AGENTGLASS_ROOT: "",
        AGENTGLASS_DB: join(home, "load.db"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        AGENTGLASS_STATE_DIR: state,
        TMUX_TMPDIR: privateTmuxDir(home),
        AGENTGLASS_TMUX_SOCKET: SOCK,
        ...(tmuxPath ? { AGENTGLASS_TMUX_PATH: tmuxPath } : {}),
        AGENTGLASS_PROJECTS_DIR: projects,
        AGENTGLASS_SCAN_DISABLED: "0",
        AGENTGLASS_TOKEN: "",
        SHELL: Bun.which("bash") || "/bin/bash",
        AGENTGLASS_DIE_WITH_PARENT: "1",
        ...(RELAY ? { AGENTGLASS_TERMRELAY: "1" } : {}),
        ...(WINDOW ? { AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist") } : {}),
      },
    });
    const pid = server.pid!;
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      try { up = (await fetch(`${S}/health`)).ok; } catch { await Bun.sleep(250); }
    }
    if (!up) throw new Error("server never answered /health");

    // --- load child ---------------------------------------------------------
    const runMs = (WARMUP_S + SECONDS + 5) * 1000;
    child = spawn("bun", [join(ROOT, "scripts", "loadtest.ts")], {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...tenv, AGX_LOAD_AGENTS: String(N), AGX_LOAD_AGENTS_WORKER: "1", AGX_LOAD_URL: S,
        AGX_LOAD_TX_DIR: projects, AGX_LOAD_CWD: cwd, AGX_LOAD_RUN_MS: String(runMs),
        AGX_LOAD_ATTACH_PANES: attachPanes.join(","),
        AGX_LOAD_TABS_DESK: TABS > 0 && process.env.AGX_LOAD_TABS_PHONE !== "1" ? "1" : "0",
        AGX_LOAD_CWDS: made.trees.join("\n"), AGX_LOAD_CHURN: JSON.stringify(made.churn),
        AGX_LOAD_WORKER_OUT: join(base, "worker.json"),
      },
    });
    if (PANELS) {
      const fromAt = Date.now() + WARMUP_S * 1000;
      panelsChild = spawn("bun", [join(ROOT, "scripts", "loadtest.ts")], {
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...tenv, AGX_LOAD_AGENTS: String(N), AGX_LOAD_AGENTS_WORKER: "panels", AGX_LOAD_URL: S,
          AGX_LOAD_ROOTS: made.roots.join("\n"), AGX_LOAD_PANELS_OUT: join(base, "panels.json"),
          AGX_LOAD_MEASURE_FROM: String(fromAt), AGX_LOAD_MEASURE_UNTIL: String(fromAt + SECONDS * 1000),
        },
      });
    }

    // --- probes -------------------------------------------------------------
    const ping: number[] = [];
    const echo: number[] = [];
    let echoTimeouts = 0, echoErr = "";
    // An object, not a `let`: on Bun 1.3.9 a captured `let` kept reading its old
    // value in these loops once they had run ~100 times (every sample dropped
    // as "not measuring" with the flag set), so the flag is a property.
    const flag = { measuring: false, stop: false };
    const pingLoop = (async () => {
      while (!flag.stop) {
        const a = performance.now();
        const ok = await fetch(`${S}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
        if (flag.measuring) ping.push(ok ? performance.now() - a : 5000);
        await new Promise<void>((r) => setTimeout(r, Math.max(1, 100 - (performance.now() - a))));
      }
    })();
    /* The typed pane goes through the door the window would use. With the relay on that is the relay's own
       port and a one-use ticket; a run that asked for the relay and did not get one fails rather than
       measuring the old door under the relay's name. */
    let probeUrl = `${S.replace("http", "ws")}/terminal/pty?pane=${encodeURIComponent(probePane)}&cols=120&rows=30`;
    if (RELAY) {
      const tk = await fetch(`${S}/terminal/relay-ticket?n=1`, { method: "POST", headers: { origin: S, "content-type": "application/json" }, body: "{}" })
        .then((r) => r.json() as Promise<{ relay?: boolean; port?: number; tickets?: string[] }>).catch(() => null);
      if (!tk?.relay || !tk.port || !tk.tickets?.[0]) throw new Error("AGX_LOAD_RELAY=1 but the server gave no relay ticket");
      probeUrl = `ws://127.0.0.1:${tk.port}/pty?t=${tk.tickets[0]}&pane=${encodeURIComponent(probePane)}&cols=120&rows=30`;
    }
    const ws = new WebSocket(probeUrl, RELAY ? ({ headers: { origin: S } } as never) : undefined);
    ws.binaryType = "arraybuffer";
    const probe: { pending: (() => void) | null } = { pending: null };
    ws.addEventListener("message", (ev) => { if (probe.pending && typeof ev.data !== "string") { const r = probe.pending; probe.pending = null; r(); } });
    ws.addEventListener("error", () => { echoErr = "terminal WebSocket error (pane attach refused or unreachable)"; });
    await new Promise<void>((r) => { ws.addEventListener("open", () => r()); setTimeout(r, 5000); });
    const echoLoop = typeEchoes(ws, probe, flag, echo, (m) => { echoErr ||= m; }, () => { echoTimeouts++; });

    // The window opens during the warm-up, as a person opens theirs: its desks and printers are running when the measuring starts.
    if (WINDOW) {
      if (!existsSync(join(ROOT, "web", "dist", "index.html"))) throw new Error("AGX_LOAD_WINDOW=1 needs the built bundle: cd web && bun run build");
      win = new LoadWindow({ url: S, project: made.roots[0] ?? cwd, desks: WINDOW_TABS, flood: FLOOD, renderer: WINDOW_RENDERER, electron: WINDOW_ELECTRON });
      await win.open();
    }
    await Bun.sleep(WARMUP_S * 1000);
    const lw0 = (await fetch(`${S}/api/loopwatch`).then((r) => r.json()).catch(() => null)) as { stalls?: { id: number }[] } | null;
    const sinceId = lw0?.stalls?.at(-1)?.id ?? 0;
   
    if (DISK) {
      const dir = join(base, "disk");
      mkdirSync(dir, { recursive: true });
      diskChild = spawn("bun", [join(ROOT, "scripts", "loadtest.ts")], {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...tenv, AGX_LOAD_AGENTS: String(N), AGX_LOAD_AGENTS_WORKER: "disk", AGX_LOAD_DISK_DIR: dir, AGX_LOAD_RUN_MS: String(SECONDS * 1000) },
      });
    }
    const relayPid = RELAY ? relayPidOf(pid) : null;
    const relayCpu0 = relayPid ? ticks(relayPid) : 0;
    const cpu0 = ticks(pid);
    if (win) await win.begin();
    const t0 = performance.now();
    flag.measuring = true;
    await Bun.sleep(SECONDS * 1000);
    flag.measuring = false;
    const windowRes: WindowResult | null = win ? await win.end().catch((e) => ({ error: String(e) }) as unknown as WindowResult) : null;
    const wall = (performance.now() - t0) / 1000;
    const cpuSec = (ticks(pid) - cpu0) / CLK;
    const hwm = status(pid, "VmHWM");
    const rssNow = status(pid, "VmRSS");
    const relayCpuSec = relayPid ? (ticks(relayPid) - relayCpu0) / CLK : 0;
    const relayHwm = relayPid ? status(relayPid, "VmHWM") : 0;
    flag.stop = true;
    try { ws.close(); } catch { /* gone */ }
    await Promise.race([Promise.all([pingLoop, echoLoop]), Bun.sleep(8000)]);

    const lw = (await fetch(`${S}/api/loopwatch?since=${sinceId}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null)) as
      { stalls: { ms: number; what: string }[]; worstMs: number } | null;
    // The server's own log in the isolated state dir: every stall it wrote.
    const logPath = join(state, "server-stall.log");
    const logMs = existsSync(logPath)
      ? [...readFileSync(logPath, "utf8").matchAll(/server stall ms=(\d+)/g)].map((m) => Number(m[1]))
      : [];
    const stalls = (lw?.stalls ?? []).map((s) => s.ms);
    const byWhat = new Map<string, { n: number; total: number; worst: number }>();
    for (const s of lw?.stalls ?? []) {
      const e = byWhat.get(s.what) ?? { n: 0, total: 0, worst: 0 };
      e.n++; e.total += s.ms; e.worst = Math.max(e.worst, s.ms); byWhat.set(s.what, e);
    }
    const top = [...byWhat].sort((a, b) => b[1].total - a[1].total).slice(0, 6);
    // What the other two processes saw. The panels one writes when its window ends, and one of
    // its requests may still be in flight, so it is given a moment.
    const readJson = (f: string): Record<string, any> | null => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
    let routes: Record<string, any> | null = null;
    if (PANELS) for (let i = 0; i < 100 && !(routes = readJson(join(base, "panels.json"))); i++) await Bun.sleep(250);
    const did = readJson(join(base, "worker.json"));

    const res = {
      options: { db_mb: DB_MB, disk: DISK, tmux_slow_ms: TMUX_SLOW ? TMUX_SLOW_MS : 0, relay: RELAY, projects: PROJECTS_N, worktrees: PROJECTS_N ? WORKTREES : 0, tabs: attachPanes.length, panels: PANELS },
      agents: N, measure_s: Math.round(wall), warmup_s: WARMUP_S, transcripts: txNote,
      loop_stall_server: { count: stalls.length, total_ms: stalls.reduce((a, b) => a + b, 0), ...stats(stalls), worst_ms: lw?.worstMs ?? 0, log_lines_total: logMs.length, log_max_ms: logMs.length ? Math.max(...logMs) : 0 },
      loop_ping: stats(ping),
      echo: { ...stats(echo), timeouts_5s: echoTimeouts, error: echoErr || undefined },
      rss_peak_mb: Math.round(hwm), rss_end_mb: Math.round(rssNow),
      cpu_seconds: Math.round(cpuSec * 10) / 10, cpu_pct_of_one_core: Math.round((cpuSec / wall) * 100),
      relay: relayPid ? { rss_peak_mb: Math.round(relayHwm), cpu_seconds: Math.round(relayCpuSec * 10) / 10 } : null,
      routes: routes ?? undefined,
      window: windowRes ?? undefined,
      flood: FLOOD,
      load: did ?? undefined,
      top_stallers: top.map(([what, e]) => ({ what, ...e })),
    };

    // --- report -------------------------------------------------------------
    const f1 = (x: number) => x.toFixed(1);
    console.log(`loadtest [AGENTS] ${N} agents · ${res.measure_s}s (+${WARMUP_S}s warm-up) · transcripts ${txNote} · relay ${RELAY ? "on" : "off"}${PROJECTS_N ? ` · ${PROJECTS_N} projects x ${WORKTREES} worktrees` : ""} · ${attachPanes.length} tabs${PANELS ? " · panels" : ""}`);
    console.log(`  server loop stalls   n=${stalls.length} total ${res.loop_stall_server.total_ms}ms p50 ${f1(res.loop_stall_server.p50)} p99 ${f1(res.loop_stall_server.p99)} max ${res.loop_stall_server.max}ms (watchdog records stalls over its threshold only; worst since boot ${res.loop_stall_server.worst_ms}ms)`);
    console.log(`  loop ping (100ms)    n=${ping.length} p50 ${f1(res.loop_ping.p50)} p99 ${f1(res.loop_ping.p99)} max ${f1(res.loop_ping.max)}ms`);
    console.log(`  terminal echo        n=${echo.length} p50 ${f1(res.echo.p50)} p95 ${f1(res.echo.p95)} p99 ${f1(res.echo.p99)} max ${f1(res.echo.max)}ms · ${echoTimeouts} over 5s${echoErr ? ` · ${echoErr}` : ""}`);
    console.log(`  server RSS peak ${res.rss_peak_mb}MB (end ${res.rss_end_mb}MB) · CPU ${res.cpu_seconds}s (${res.cpu_pct_of_one_core}% of one core)`);
    if (windowRes) {
      const w = windowRes;
      if (w.error && !w.frames) console.log(`  window  ${w.error}`);
      else {
        console.log(`  window desks ${w.desks.picked}/${w.desks.asked} open (${w.desks.flooding} flooding) · renderer ${w.renderer}${FLOOD ? ` · flood ${FLOOD}` : ""}${w.error ? ` · ${w.error}` : ""}`);
        console.log(`  window target        ${w.target ?? "chrome"}${w.visibility ? ` · page ${w.visibility.start} -> ${w.visibility.end}` : ""}`);
        if (w.frames_note) console.log(`  window WARNING       ${w.frames_note}`);
        console.log(`  window long tasks    n=${w.long_tasks.n} total ${w.long_tasks.total_ms}ms max ${w.long_tasks.max_ms}ms`);
        console.log(`  window frame gaps    n=${w.frames.n} p50 ${f1(w.frames.p50)} p99 ${f1(w.frames.p99)} max ${f1(w.frames.max)}ms · ${w.frames.over_50ms} over 50ms · ${w.frames.over_250ms} over 250ms`);
        console.log(`  window JS heap       ${w.heap_mb ? `${w.heap_mb.start} -> ${w.heap_mb.end}MB` : "not available"}`);
        console.log(`  window keystroke→echo ${w.echo.readable ? `n=${w.echo.n} p50 ${f1(w.echo.p50)} p95 ${f1(w.echo.p95)} p99 ${f1(w.echo.p99)} max ${f1(w.echo.max)}ms · ${w.echo.timeouts_5s} over 5s` : "not readable (the renderer draws pixels; use AGX_LOAD_WINDOW_RENDERER=dom)"}`);
      }
    }
    if (res.relay) console.log(`  relay  RSS peak ${res.relay.rss_peak_mb}MB · CPU ${res.relay.cpu_seconds}s`);
    else if (RELAY) console.log(`  relay  not found under the server: its numbers are missing`);
    if (did) console.log(`  load   tabs ${did.tabs_open} open / ${did.tabs_failed} failed, ${(did.tab_bytes / 1_048_576).toFixed(1)}MB drained · git ${did.churn_commits} commits, ${did.churn_switches} switches, ${did.churn_errors} errors`);
    for (const [name, r] of Object.entries(routes ?? {})) console.log(`  route  ${name.padEnd(13)} n=${String(r.n).padStart(3)} p50 ${f1(r.p50)} p95 ${f1(r.p95)} max ${f1(r.max)}ms${r.not_ok ? ` · ${r.not_ok} not ok` : ""}`);
    if (PANELS && !routes) console.log(`  routes: the panels process wrote nothing`);
    for (const t of top) console.log(`    stall ${String(t[1].total).padStart(6)}ms ${String(t[1].n).padStart(3)}x worst ${t[1].worst}ms  ${t[0]}`);
    resOut = res;

    if (echo.length < 20) { console.log(`✗ loadtest: only ${echo.length} echo samples — the terminal path did not work, nothing proved`); failed = true; }
    if (process.env.AGX_LOAD_BUDGET === "1") {
      const b = loadBudget();
      const checks: [string, number, number | undefined][] = [
        ["loop_stall_max_ms", Math.max(res.loop_stall_server.max, res.loop_ping.max), b.loop_stall_max_ms],
        ["echo_p99_ms", res.echo.p99, b.echo_p99_ms],
        ["rss_peak_mb", res.rss_peak_mb, b.rss_peak_mb],
      ];
      for (const [k, v, lim] of checks) {
        if (lim === undefined) continue;
        const over = v > lim;
        console.log(`  ${over ? "✗" : "✓"} ${k} ${Math.round(v)} / budget ${lim}`);
        if (over) failed = true;
      }
    }
  } catch (e) {
    console.error(`loadtest: ${e instanceof Error ? e.message : e}`);
    failed = true;
  } finally {
    cleanup();
  }
  return { res: resOut, failed };
}


const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** One number per row out of a result file; a file of several runs gives the median run's. */
function rowsOf(file: string): Map<string, number> {
  const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, any> | null;
  const runs: Record<string, any>[] = j && Array.isArray(j.runs) ? j.runs : j ? [j] : [];
  const out = new Map<string, number>();
  const put = (k: string, f: (r: Record<string, any>) => unknown) => {
    const xs = runs.map((r) => { try { return f(r); } catch { return undefined; } }).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (xs.length) out.set(k, med(xs));
  };
  for (const q of ["p50", "p95", "p99", "max"]) put(`echo ${q} ms`, (r) => r.echo[q]);
  put("echo over 5 s", (r) => r.echo.timeouts_5s);
  put("stalls count", (r) => r.loop_stall_server.count);
  put("stalls total ms", (r) => r.loop_stall_server.total_ms);
  put("stall max ms", (r) => Math.max(r.loop_stall_server.max, r.loop_ping.max));
  put("ping p99 ms", (r) => r.loop_ping.p99);
  put("server RSS peak MB", (r) => r.rss_peak_mb);
  put("server CPU s", (r) => r.cpu_seconds);
  put("relay RSS peak MB", (r) => r.relay.rss_peak_mb);
  put("relay CPU s", (r) => r.relay.cpu_seconds);
  const routes = new Set(runs.flatMap((r) => Object.keys(r.routes ?? {})));
  for (const name of routes) put(`${name} p95 ms`, (r) => r.routes[name].p95);
  return out;
}

/** `--compare a.json b.json`: the before/after table. Reads two files and starts nothing. */
export function compareRuns(a: string | undefined, b: string | undefined): never {
  if (!a || !b) { console.error("usage: bun scripts/loadtest.ts --compare before.json after.json"); process.exit(2); }
  const A = rowsOf(a), B = rowsOf(b);
  const f = (x: number | undefined) => (x === undefined ? "-" : x.toFixed(1)).padStart(10);
  console.log(`${"".padEnd(22)}${"before".padStart(10)}${"after".padStart(10)}   change`);
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k), y = B.get(k);
    const change = x === undefined || y === undefined ? "" : x === 0 ? (y === 0 ? "same" : "from 0") : `${y >= x ? "+" : ""}${(((y - x) / x) * 100).toFixed(0)}%`;
    console.log(`${k.padEnd(22)}${f(x)}${f(y)}   ${change}`);
  }
  process.exit(0);
}

export async function runAgents(): Promise<never> {
  if (process.env.AGX_LOAD_AGENTS_WORKER) return worker() as never;
  if (!Bun.which("tmux")) { console.error("loadtest: tmux not found"); process.exit(1); }
  const runs: Record<string, any>[] = [];
  let failed = false;
  for (let i = 0; i < REPEAT; i++) {
    if (REPEAT > 1) console.log(`\n— run ${i + 1} of ${REPEAT} —`);
    const r = await once();
    failed ||= r.failed;
    if (r.res) runs.push(r.res);
  }
  if (REPEAT > 1 && runs.length) {
    const pick = (f: (r: Record<string, any>) => number) => runs.map(f);
    const rows: [string, number[]][] = [
      ["stall max ms", pick((r) => Math.max(r.loop_stall_server.max, r.loop_ping.max))],
      ["ping p99 ms", pick((r) => r.loop_ping.p99)],
      ["echo p95 ms", pick((r) => r.echo.p95)],
      ["echo p99 ms", pick((r) => r.echo.p99)],
      ["echo max ms", pick((r) => r.echo.max)],
      ["RSS peak MB", pick((r) => r.rss_peak_mb)],
      ["CPU s", pick((r) => r.cpu_seconds)],
    ];
    console.log(`\n— ${runs.length} runs: median / worst —`);
    for (const [k, xs] of rows) console.log(`  ${k.padEnd(14)} ${med(xs).toFixed(1).padStart(8)} / ${Math.max(...xs).toFixed(1)}`);
  }
  if (process.env.AGX_LOAD_OUT) writeFileSync(process.env.AGX_LOAD_OUT, JSON.stringify(REPEAT > 1 ? { runs } : runs[0] ?? null, null, 2) + "\n");
  process.exit(failed ? 1 : 0);
}

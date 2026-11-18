/*
 * A booted server for the worker-start tests: fake engines first on PATH, its
 * own tmux socket, a real seat whose token the stub window writes out, and the
 * helpers that talk to it. Nothing here starts an engine that is not a fake.
 *
 * `claude` is two things: asked for `-p`, a version or its login it is the fake
 * engine; started any other way it is the TUI a seat or a legacy worker runs
 * (argv written aside, and for the seat the token it was given). `opencode`
 * answers `debug agent` from the lock it was handed, and a turn is the fake's,
 * or a slow one while the flag file `slow` exists. The `limit` and `work` fakes take a
 * second to say so: a real CLI does, and one that exits before the start has looked
 * is reported as having died at launch, which on a slow runner is every start.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "../tmuxTmp.ts";
import { TMUX_ISOLATED } from "../tmuxIsolated.ts";
import { freePort } from "../freePort.ts";
import { installFakeEngines, readCalls, type FakeCall } from "./fakeEngines.ts";
import type { Policy } from "../../../shared/orchestration.ts";

export const MACHINE = "machine-token-example";
export type Ans = { ok: boolean; error?: string; result?: Record<string, any> };

const OPENCODE_FRAMES = [
  JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_fake0001", part: { type: "step-start" } }),
  JSON.stringify({ type: "text", timestamp: 2, sessionID: "ses_fake0001", part: { type: "text", text: "done" } }),
];

export interface Harness {
  dir: string; base: string; wt: string; logs: string; state: string; seatToken: string;
  /** The key a test holds the desk with, as the app does on /desk/claim. */
  deskKey: string;
  /** Take the desk the way the app does on a server it did not start: the key
   *  comes back down a claim held open, and lasts until the release is called. */
  holdDesk(): Promise<() => void>;
  post(path: string, body: unknown, token: string, extra?: Record<string, string>): Promise<Ans & { status: number }>;
  asSeat(path: string, body: unknown, extra?: Record<string, string>): Promise<Ans & { status: number }>;
  asPerson(path: string, body: unknown, extra?: Record<string, string>): Promise<Ans & { status: number }>;
  /** The person's adoption through the card: ask, approve it, then take the
   *  credential, the same three steps `agentglass-agent adopt` waits through. */
  adoptAsPerson(body: { root: string; pane: string; session?: string; powers?: string }): Promise<Ans & { status: number }>;
  /** A GET with the given token: status and the JSON body when there is one. */
  read(path: string, token: string): Promise<{ status: number; body: Record<string, any> }>;
  listed(): Promise<Record<string, any>[]>;
  row(name: string): Promise<Record<string, any> | undefined>;
  actions(): Promise<{ actor: string; action: string; ok: boolean; detail: string | null }[]>;
  callsOf(engine: "claude" | "opencode" | "hermes"): FakeCall[];
  until<T>(f: () => Promise<T | undefined | false>, ms?: number): Promise<T>;
  /** Replace the global policy's rules, limits and ceiling with these over the defaults. */
  usePolicy(o: { rules?: unknown[]; limits?: Partial<Policy["limits"]>; ceiling?: Partial<Policy["ceiling"]> }): Promise<void>;
  ruleOn(on: boolean): Promise<void>;
  exited(name: string): Promise<Record<string, any>>;
  /** While set, an OpenCode turn runs for a minute: a worker that stays live. */
  slow(on: boolean): void;
  /** How many headless turns this engine's stub was asked for, failing ones included. */
  ran(engine: "opencode" | "claude"): number;
  /** Make an engine's next turns fail the way a rate-limited CLI does: with
   *  nothing done (`limit`), or after a tool call (`work`). Null: back to answering. */
  mode(engine: "opencode" | "claude", how: "limit" | "work" | null): void;
  /** A tab somebody opened by hand in `dir`, running the TUI stub: its pane id. */
  handTab(dir: string, window?: string): Promise<string>;
  /** Close a tab opened by `handTab`, as a relaunch does to the old one. */
  closeTab(pane: string): Promise<void>;
  /** A tab whose TUI is stopped on a permission dialog, as Claude Code draws
   *  one: the pane id, and what answers it (a line read from the pane). */
  dialogTab(dir: string): Promise<{ pane: string; answered(): boolean }>;
  stop(): Promise<void>;
}

export async function startHarness(tag: string): Promise<Harness> {
  const SOCKET = `agx-${tag}-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), `agx-${tag}-`));
  const logs = join(dir, "logs"); mkdirSync(logs);
  const wt = join(dir, "wt"); mkdirSync(wt);
  const fakes = join(dir, "bin"); mkdirSync(fakes);
  const engines = join(dir, "engines"); mkdirSync(engines);
  installFakeEngines(engines, {
    claude: {},
    opencode: { headless: { frames: OPENCODE_FRAMES, stderr: "note: free model, rate may vary" } },
    hermes: { version: { out: "Hermes Agent v0.21.0 (2026.9.1)" } },
  });
  writeFileSync(join(fakes, "hermes"), `#!/bin/sh\nexec "${join(engines, "hermes")}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(fakes, "opencode"), `#!/bin/sh
if [ "$1" = debug ] && [ "$2" = agent ]; then
  exec python3 -c 'import json,os
c=json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])["permission"]
r=[{"permission":"bash","pattern":"*","action":"allow"}]
for k,v in c.items():
    if isinstance(v,str): r.append({"permission":k,"pattern":"*","action":v})
    else: r+=[{"permission":k,"pattern":p,"action":a} for p,a in v.items()]
print(json.dumps({"permission":r}))'
fi
if [ "$1" = run ] && [ -e "${logs}/slow" ]; then sleep 60; exit 0; fi
if [ "$1" = run ]; then
echo x >> "${logs}/ran-opencode"
[ -e "${logs}/mode-opencode" ] && case "$(cat "${logs}/mode-opencode")" in
  limit) sleep 1; printf '%s\\n' 'Error: rate limit reached, try again later' >&2; exit 1 ;;
  work) sleep 1; printf '%s\\n' '{"type":"tool_use","timestamp":3,"sessionID":"ses_fake0001","part":{"type":"tool","tool":"edit","state":{"status":"completed"}}}'; printf '%s\\n' 'Error: rate limit reached, try again later' >&2; exit 1 ;;
esac
fi
if [ "$1" != run ]; then for a in "$@"; do case "$a" in --model|--prompt)
printf '%s\\0' "$@" > "${logs}/tui-opencode-$$.argv"
[ -n "$AGENTGLASS_SEAT" ] && printf '%s' "$AGENTGLASS_TOKEN" > "${logs}/seat-opencode.token"
[ -n "$AGENTGLASS_SEAT" ] && printf '%s' "$OPENCODE_CONFIG_CONTENT" > "${logs}/seat-opencode.lock"
printf '\\033[2J\\033[H\\n  ┃\\n  ┃\\n  ┃\\n  ┃  Build · Fake OpenCode Zen\\n  ╹▀▀▀▀\\n   tab agents  ctrl+p commands\\n'
sleep 300;; esac; done; fi
exec "${join(engines, "opencode")}" "$@"
`, { mode: 0o755 });
  writeFileSync(join(fakes, "claude"), `#!/bin/sh
for a in "$@"; do case "$a" in -p|--print)
echo x >> "${logs}/ran-claude"
[ -e "${logs}/mode-claude" ] && case "$(cat "${logs}/mode-claude")" in
  limit) sleep 1; printf '%s\\n' 'Error: rate limit reached, try again later' >&2; exit 1 ;;
  work) sleep 1; printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_fake0001","name":"Edit","input":{"file_path":"notes.txt"}}]},"session_id":"00000000-0000-4000-8000-000000000001"}'; printf '%s\\n' 'Error: rate limit reached, try again later' >&2; exit 1 ;;
esac
exec "${join(engines, "claude")}" "$@";; --version|--help|auth) exec "${join(engines, "claude")}" "$@";; esac; done
# The TUI form below never matches a case above (no -p/--version/--help/auth
# in a worker's or a seat's real argv), so it was never recorded for a test to
# read back: this records it the same way the generic stub does, without
# taking over the process (the python3 transcript write and the keep-alive
# below still need to run).
"${join(engines, "claude")}" "$@" >/dev/null 2>&1 || true
if [ "$1" = --dialog ]; then
printf '\\033[2J\\033[H'
printf '%s\\n' 'Edit file' ' notes.txt' '' 'Do you want to make this edit to notes.txt?' '❯ 1. Yes' '  2. No' '' 'Esc to cancel'
trap '' INT
read answer
echo x > "${logs}/answered-$(echo "$TMUX_PANE" | tr -d %)"
sleep 300
fi
# A turn in the interactive form is still a turn this machine ran: counted the
# same way, and failing the same ways.
echo x >> "${logs}/ran-claude"
[ -e "${logs}/mode-claude" ] && case "$(cat "${logs}/mode-claude")" in
  limit) sleep 1; printf '%s\\n' 'Error: rate limit reached, try again later' >&2; exit 1 ;;
esac
# The TUI writes the CLI's own transcript, and its own end-of-turn marker with
# it: a worker's turn is read from there, not from an exit (agents/tuiturn.ts).
python3 -c 'import json,os,re,sys
a=sys.argv[1:]
sid=""
for i,x in enumerate(a):
    if x in ("--session-id","--resume") and i+1<len(a): sid=a[i+1]
cwd=os.environ.get("PWD","")
home=os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.environ.get("HOME",""),".claude")
pos=[x for x in a if not x.startswith("-")]
prompt=pos[-1] if pos else ""
try: answer=open("${logs}/tui-answer").read().strip()
except Exception: answer="ok"
if sid:
    p=os.path.join(home,"projects",re.sub(r"[^A-Za-z0-9]","-",cwd),sid+".jsonl")
    os.makedirs(os.path.dirname(p),exist_ok=True)
    rows=[{"type":"user","message":{"role":"user","content":[{"type":"text","text":prompt}]}},
          {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":answer}]}},
          {"type":"system","subtype":"turn_duration","durationMs":1200}]
    with open(p,"a") as f:
        for r in rows: f.write(json.dumps(r)+"\\n")
' "$@"
printf '%s\\0' "$@" > "${logs}/tui-$$.argv"
env | sed -e 's/=.*//' > "${logs}/tui-$$.envnames"
[ -n "$AGENTGLASS_SEAT" ] && printf '%s' "$AGENTGLASS_TOKEN" > "${logs}/seat.token"
printf '\\033[2J\\033[H❯ '
sleep 300
`, { mode: 0o755 });
  chmodSync(join(fakes, "claude"), 0o755);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", new URL("../../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [fakes, "/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":").filter((p) => p.includes("bun") || p.includes("tmux"))].join(":"),
      LANG: process.env.LANG || "C.UTF-8",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "w.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_CHAT_BYPASS: "1",
      AGENTGLASS_TOKEN: MACHINE,
      /* The person's own shell may carry these; a window inherits the server's
         environment, so a worker must be handed its own name or none. */
      AGENTGLASS_PROFILE: "the-person",
      AGENTGLASS_BROWSER_AS: "the-person",
    },
    stdout: "ignore", stderr: "pipe",
  });

  const post: Harness["post"] = async (path, body, token, extra = {}) => {
    const res = await fetch(base + path, {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: base, Authorization: `Bearer ${token}`, ...extra },
    });
    return { ...(await res.json() as Ans), status: res.status };
  };
  const get = async <T,>(path: string): Promise<T> => (await fetch(base + path, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as Promise<T>;
  const until: Harness["until"] = async (f, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await f(); if (v) return v as never; if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(100); }
  };

  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  const opened = await post("/seat/open", { root: dir, powers: "assign" }, MACHINE);
  if (!opened.ok) throw new Error(`the seat did not open: ${JSON.stringify(opened)}`);
  /* A container with no user namespaces cannot run bubblewrap, and OpenCode and a walled Claude are refused as workers without it. The person accepts that here, as Settings would; where bubblewrap works the wall stays on. */
  if (!Bun.which("bwrap") || Bun.spawnSync(["bwrap", "--dev-bind", "/", "/", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    const lifted = await post("/settings/door", { id: "workers.unwalledEngines", value: true }, MACHINE);
    if (!lifted.ok) throw new Error(`could not accept unwalled engines: ${JSON.stringify(lifted)}`);
  }
  for (let i = 0; i < 100 && !existsSync(join(logs, "seat.token")); i++) await Bun.sleep(100);
  const seatToken = readFileSync(join(logs, "seat.token"), "utf8");
  /* The app's own signal on a server it did not start: the key comes down a
     claim held open, and the server reads it only from there. */
  const DESK = "desk-key-the-harness-app-claimed-0123456789abcdef";
  const holdDesk: Harness["holdDesk"] = async () => {
    for (let i = 0; i < 40; i++) {
      const ac = new AbortController();
      const r = await fetch(base + "/desk/claim", {
        method: "POST", headers: { Authorization: `Bearer ${MACHINE}`, "x-agentglass-desk": DESK }, signal: ac.signal,
      });
      if (r.status === 200) {
        /* The claim lives while this response does; keeping the reader is what
           keeps it. */
        const body = r.body!.getReader();
        await body.read();
        return () => { void body.cancel().catch(() => {}); ac.abort(); };
      }
      await r.text();
      ac.abort();
      // A claim freed a beat ago can still be held when the next one arrives.
      await Bun.sleep(50);
    }
    throw new Error("the desk could not be claimed");
  };

  const h: Harness = {
    dir, base, wt, logs, state: `${dir}/state`, seatToken, deskKey: DESK, holdDesk, post, until,
    asSeat: (p, b, x) => post(p, b, seatToken, x),
    asPerson: (p, b, x) => post(p, b, MACHINE, x),
    adoptAsPerson: async (body) => {
      /* The person's own window, which is the desk key: an Origin is a header
         the agent that asks can write, and an adoption card is not its to
         answer. */
      const release = await holdDesk();
      try { return await post("/seat/adopt", body, MACHINE, { "x-agentglass-desk": DESK }); }
      finally { release(); }
    },
    read: async (p, token) => {
      const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
    },
    listed: async () => (await get<{ result: { agents: Record<string, any>[] } }>("/agents/named?all=1")).result.agents,
    row: async (name) => (await h.listed()).find((a) => a.name === name),
    actions: async () => (await get<{ actions: { actor: string; action: string; ok: boolean; detail: string | null }[] }>("/actions?limit=200")).actions,
    callsOf: (engine) => readCalls(engines, engine).filter((c) => !["--version", "version", "providers", "debug", "auth", "status", "--help"].includes(c.argv[0] ?? "")),
    usePolicy: async (o) => {
      const cur = await get<{ policy: Policy }>("/orchestration");
      cur.policy.rules = (o.rules ?? []) as Policy["rules"];
      cur.policy.limits = { maxWorkers: 3, turnMinutes: 30, maxRetries: 1, ...o.limits };
      cur.policy.ceiling = { write: "worktree", network: false, commit: true, docker: false, worktreeOps: true, deny: [], ...o.ceiling };
      // A default wider than the ceiling is refused; a test that narrows the ceiling narrows the default with it.
      for (const k of ["network", "commit", "docker", "worktreeOps"] as const) cur.policy.workerDefault[k] = !!cur.policy.workerDefault[k] && !!cur.policy.ceiling[k];
      const r = await post("/orchestration", { policy: cur.policy }, MACHINE);
      if (!r.ok) throw new Error(`policy refused: ${r.error}`);
    },
    ruleOn: async (on) => {
      await until(async () => {
        const s = await get<{ rules: { ruleId: string; active: boolean }[] }>("/orchestration/state");
        return s.rules.find((r) => r.ruleId === "nights")?.active === on ? true : undefined;
      });
    },
    exited: (name) => until(async () => { const a = await h.row(name); return a?.exitCode !== undefined ? a : undefined; }),
    ran: (engine) => { try { return readFileSync(join(logs, `ran-${engine}`), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } },
    mode: (engine, how) => { if (how) writeFileSync(join(logs, `mode-${engine}`), how); else rmSync(join(logs, `mode-${engine}`), { force: true }); },
    slow: (on) => { if (on) writeFileSync(join(logs, "slow"), ""); else rmSync(join(logs, "slow"), { force: true }); },
    closeTab: async (pane) => {
      await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-pane", "-t", pane], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "ignore", stderr: "ignore" }).exited;
    },
    handTab: async (dir, window) => {
      const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "new-session", "-d", "-P", "-F", "#{pane_id}", "-c", dir, ...(window ? ["-n", window] : []), join(fakes, "claude")],
        { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
      const pane = (await new Response(p.stdout).text()).trim();
      if (await p.exited !== 0 || !pane) throw new Error("the hand-opened tab did not open");
      return pane;
    },
    dialogTab: async (dir) => {
      const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "new-session", "-d", "-P", "-F", "#{pane_id}", "-c", dir, join(fakes, "claude"), "--dialog"],
        { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
      const pane = (await new Response(p.stdout).text()).trim();
      if (await p.exited !== 0 || !pane) throw new Error("the dialog tab did not open");
      return { pane, answered: () => existsSync(join(logs, `answered-${pane.slice(1)}`)) };
    },
    stop: async () => {
      await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore" }).exited;
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** The rule every policy test turns on: builder goes to the free OpenCode model. */
export const nights = (chain: { engine: string; model: string }[] = [{ engine: "opencode", model: "opencode/big-pickle" }], enabled = true) => ({
  id: "nights", name: "Nights", enabled, when: [{ kind: "always" }], workers: { builder: chain },
});

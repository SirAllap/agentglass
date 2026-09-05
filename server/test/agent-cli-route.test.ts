/*
 * THE SIX VERBS, END TO END, THROUGH THE CLI A SCRIPT WOULD RUN.
 *
 * A real server on its own port, an isolated tmux engine, and a `claude` that
 * is a bash script drawing a Claude-shaped screen — the input box, the "esc to
 * interrupt" of a turn in flight — and writing what it was launched with and
 * what it was told to two files. Every assertion is on an EFFECT: the argv the
 * CLI got, the text that reached its stdin, the pane that exists and then does
 * not. The verbs are exercised through bin/agentglass-agent rather than fetch,
 * because a verb that answers "ok" without doing the thing is the failure this
 * repo has had before, and the CLI is what the worker actually calls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const SOCKET = `agx-agentops-${process.pid}`;
const CLI = new URL("../../bin/agentglass-agent", import.meta.url).pathname;
const have = Bun.which("tmux") && Bun.which("python3");

let dir: string, base: string, stubDir: string, wt: string, log: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

/* A Claude with the two things the verbs read: an input box that starts with
   `❯`, and "esc to interrupt" once it has taken a message. It clears the
   screen on submit so the taken text is no longer sitting in the box, which is
   exactly what the real one does and what `__submitVerdict` reads as "sent". */
const STUB = `#!/usr/bin/env bash
# The real one is asked \`--help\` once, to learn whether it takes --name.
case " $* " in *" --help "*) echo "  -n, --name <name>  session name"; exit 0;; esac
printf '%s\\n' "$@" > "$AGX_STUB_LOG.argv"
printf '\\033[2J\\033[H'
printf 'Welcome to the stub\\n\\n❯ '
IFS= read -r line
printf '%s\\n' "$line" > "$AGX_STUB_LOG.prompt"
printf '\\033[2J\\033[H'
printf '⏺ Working on it…\\n  (esc to interrupt)\\n\\n❯ \\n'
sleep 300
`;

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "agx-agent-cli-"));
  stubDir = join(dir, "stub");
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, "claude"), STUB);
  chmodSync(join(stubDir, "claude"), 0o755);
  wt = join(dir, "wt");
  mkdirSync(wt);
  log = join(dir, "stub-log");
  const port = 4930 + Math.floor(Math.random() * 30);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      /* Without a UTF-8 locale tmux prints the TAB in `-P -F` as `_`, and the
         pane/window ids come back as one unreadable token: measured, not
         guessed — "%2_@2". The app always has one; a bare env here did not. */
      LANG: process.env.LANG || "C.UTF-8",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "agents.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_CHAT_BYPASS: "1",
      AGX_STUB_LOG: log,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(async () => {
  if (!have) return;
  await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore" }).exited;
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

type Answer = { ok: boolean; error?: string; result?: Record<string, unknown> & { agents?: Array<Record<string, unknown>>; agent?: Record<string, unknown> } };
async function cli(...args: string[]): Promise<{ code: number; out: Answer }> {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir, AGENTGLASS_SERVER: base },
    stdout: "pipe", stderr: "pipe",
  });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  let out: Answer;
  try { out = JSON.parse(text.trim().split("\n").pop() ?? "{}"); } catch { out = { ok: false, error: `not json: ${text}` }; }
  return { code, out };
}
const panes = async () => {
  const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}\t#{window_name}"], {
    env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "pipe", stderr: "ignore",
  });
  return (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean);
};

const SLOW = 30_000;
describe.skipIf(!have)("bin/agentglass-agent against a live server", () => {
  test("nothing is listed before anything is started, in the worker's shape", async () => {
    const { code, out } = await cli("list");
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.result?.agents).toEqual([]);
  }, SLOW);

  test("a bad name is refused with exit 1", async () => {
    const { code, out } = await cli("start", "no good", "--cwd", wt);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("name");
  }, SLOW);

  test("a checkout outside the open project is refused", async () => {
    const { code, out } = await cli("start", "w0", "--cwd", tmpdir());
    expect(code).toBe(1);
    expect(out.error).toContain("not in the open project");
  }, SLOW);

  test("start seats the CLI in the checkout, in the agents session, and waits until its box is drawn", async () => {
    const { code, out } = await cli("start", "w1", "--cwd", wt, "--yolo", "--remote-control", "w1", "--timeout", "20000", "--", "--model", "sonnet");
    expect(out.error).toBeUndefined();
    expect(code).toBe(0);
    expect(out.result?.state).toBe("ready");
    expect(out.result?.ready).toBe(true);
    const agent = out.result?.agent as Record<string, string>;
    expect(agent.name).toBe("w1");
    expect(agent.cwd).toBe(wt);
    expect(agent.paneId).toMatch(/^%\d+$/);
    expect(agent.windowId).toMatch(/^@\d+$/);
    // The window really exists, in the session named for scripts' agents, named after the agent.
    const rows = await panes();
    expect(rows.some((r) => r.startsWith(`${agent.paneId}\tagents\tw1`))).toBe(true);
    // The CLI got the yolo flag (granted: bypass is on here), the remote-control name, and the pass-through flags.
    const argv = readFileSync(`${log}.argv`, "utf8").split("\n");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv.slice(argv.indexOf("--remote-control"), argv.indexOf("--remote-control") + 2)).toEqual(["--remote-control", "w1"]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "sonnet"]);
  }, SLOW);

  test("the same name again is refused while it runs, and the existing agent is in the answer", async () => {
    const { code, out } = await cli("start", "w1", "--cwd", wt, "--timeout", "0");
    expect(code).toBe(1);
    expect(out.error).toContain("still running");
    expect((out.result?.agent as Record<string, string> | undefined)?.name).toBe("w1");
  }, SLOW);

  test("the raw yolo flag after -- is refused even though bypass is on", async () => {
    const { code, out } = await cli("start", "w2", "--cwd", wt, "--timeout", "0", "--", "--dangerously-skip-permissions");
    expect(code).toBe(1);
    expect(out.error).toContain("Settings");
    expect((await cli("list")).out.result?.agents?.map((a) => a.name)).toEqual(["w1"]);
  }, SLOW);

  test("prompt pastes the text and presses Enter until the CLI takes it — the text reaches its stdin", async () => {
    const text = "Reproduce first: it's the failing test that decides, not the plan";
    const { code, out } = await cli("prompt", "w1", text);
    expect(out.error).toBeUndefined();
    expect(code).toBe(0);
    expect(out.result?.outcome).toBe("sent");
    for (let i = 0; i < 50 && !existsSync(`${log}.prompt`); i++) await Bun.sleep(100);
    expect(readFileSync(`${log}.prompt`, "utf8")).toContain(text);
  }, SLOW);

  test("wait --until working returns once the turn is in flight", async () => {
    const { code, out } = await cli("wait", "w1", "--until", "working", "--timeout", "5000");
    expect(code).toBe(0);
    expect(out.result?.state).toBe("working");
    expect(out.result?.reached).toBe(true);
  }, SLOW);

  test("read shows the screen, and --lines trims it", async () => {
    const { code, out } = await cli("read", "w1", "--lines", "3");
    expect(code).toBe(0);
    expect(out.result?.state).toBe("working");
    expect(String(out.result?.text)).toContain("esc to interrupt");
    expect(String(out.result?.text).split("\n").length).toBeLessThanOrEqual(3);
  }, SLOW);

  test("send-keys presses one named key and refuses anything else", async () => {
    expect((await cli("send-keys", "w1", "enter")).code).toBe(0);
    const bad = await cli("send-keys", "w1", "C-d");
    expect(bad.code).toBe(1);
    expect(bad.out.error).toContain("enter");
  }, SLOW);

  test("list carries the live agent with its pane; a name nobody started is 404", async () => {
    const { out } = await cli("list");
    const w1 = out.result?.agents?.find((a) => a.name === "w1") as Record<string, unknown>;
    expect(w1).toBeDefined();
    expect(String(w1.paneId)).toMatch(/^%\d+$/);
    expect(w1.endedAt).toBeNull();
    const { code, out: none } = await cli("read", "nobody");
    expect(code).toBe(1);
    expect(none.error).toContain("no agent");
  }, SLOW);

  test("stop kills the window; the name leaves the live list and is free to start again", async () => {
    const { code } = await cli("stop", "w1");
    expect(code).toBe(0);
    for (let i = 0; i < 30 && (await panes()).some((r) => r.includes("\tagents\tw1")); i++) await Bun.sleep(100);
    expect((await panes()).some((r) => r.includes("\tagents\tw1"))).toBe(false);
    expect((await cli("list")).out.result?.agents).toEqual([]);
    const all = (await cli("list", "--all")).out.result?.agents ?? [];
    expect(all.map((a) => a.name)).toEqual(["w1"]);
    expect(typeof all[0]?.endedAt).toBe("number");
    const again = await cli("start", "w1", "--cwd", wt, "--timeout", "20000");
    expect(again.out.error).toBeUndefined();
    expect(again.code).toBe(0);
    expect((await cli("list")).out.result?.agents?.map((a) => a.name)).toEqual(["w1"]);
  }, SLOW);

  test("schedule writes a row for later, schedules lists it waiting, unschedule takes it back — through the CLI", async () => {
    const add = await cli("schedule", "night", "--cwd", wt, "--at", "+30m", "--prompt", "run the suite");
    expect(add.out.error).toBeUndefined();
    expect(add.code).toBe(0);
    const sched = add.out.result?.schedule as Record<string, unknown>;
    expect(sched.name).toBe("night");
    expect(Number(sched.due)).toBeGreaterThan(Date.now() + 29 * 60_000);
    const list = await cli("schedules");
    expect(list.code).toBe(0);
    const rows = (list.out.result as { schedules: Record<string, unknown>[] }).schedules;
    expect(rows.map((r) => r.name)).toEqual(["night"]);
    expect(rows[0]!.firedAt).toBeNull();
    const bad = await cli("schedule", "late", "--cwd", wt, "--at", "yesterday");
    expect(bad.code).toBe(1);
    expect(bad.out.error).toContain("when:");
    const gone = await cli("unschedule", String(sched.id));
    expect(gone.code).toBe(0);
    expect((await cli("schedules")).out.result).toEqual({ schedules: [] });
    expect((await cli("unschedule", String(sched.id))).code, "cancelled once, not twice").toBe(1);
  }, SLOW);

  test("an agent whose CLI exits on its own is gone from the list without anybody stopping it", async () => {
    const { out } = await cli("list");
    const w1 = out.result?.agents?.find((a) => a.name === "w1") as Record<string, string>;
    await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-pane", "-t", w1.paneId], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore" }).exited;
    for (let i = 0; i < 30 && (await cli("list")).out.result?.agents?.length; i++) await Bun.sleep(100);
    expect((await cli("list")).out.result?.agents).toEqual([]);
    const w = await cli("wait", "w1");
    expect(w.code).toBe(1);
    expect(w.out.error).toContain("no agent");
  }, SLOW);
});

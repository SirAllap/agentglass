/*
 * POST /terminal/tmux/windows opens a window or a pane running a command the
 * CALLER supplied, and a tmux window inherits the SERVER's environment. So the
 * route is a start path like any other and goes through the browser door:
 *
 *  - an argv whose head is an agent CLI is that agent's tab: the door mints a
 *    credential for it, and the tab is as scoped as one opened by a button;
 *  - any other command is not an agent's: the browser's variables are removed
 *    and the OFF marker is set, so the supplied CLI cannot fall back to the
 *    person's token file;
 *  - a credential minted for an agent (wk_ or st_) may not hand the route an
 *    argv at all. Without that, a worker's own credential was enough to run a
 *    command with the machine token the server was started with.
 *
 * Measured on the environment the pane really has, through a booted server and
 * its own tmux. A pane writes the NAMES in its environment, never a value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR, killServerAndWait } from "./tmuxTmp.ts";
import { startSession, TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { settled } from "./paneSettled.ts";
import { launchPerm } from "../src/launchperm.ts";

const have = !!Bun.which("tmux");
const SOCKET = `agx-window-route-${process.pid}`;
const MACHINE = "mk_machine_for_the_window_route";
const dir = mkdtempSync(join(tmpdir(), "agx-window-route-"));
const bin = join(dir, "bin");
const tokenFile = join(dir, "worker-token");
let proc: ReturnType<typeof Bun.spawn> | null = null, base = "", worker = "";
/* A seat credential is an agent like a worker: the permission ceiling must read
 * `principal`, not the older `worker` field, or a seat can ask for a looser mode
 * than the person's setting and get it. */
const seatFile = join(dir, "seat-token");
let seat = "";

/** A CLI named as an agent table row, which writes down the NAME of every
 *  variable in its environment, and — separately — the token's PREFIX (the part
 *  before the underscore, never the value) and the profile. The argv's second
 *  and third words are where each lands. */
const STUB = `#!/bin/sh
printenv | sed 's/=.*//' > "$1"
tok=\${AGENTGLASS_TOKEN:-}
printf '%s\\n%s\\n' "\${tok%%_*}" "\${AGENTGLASS_PROFILE:-}" > "$2"
sleep 300
`;

/** The server's environment, handed to the tmux server too: a window inherits
 *  the TMUX SERVER's environment, and a tmux server started by this process
 *  would otherwise carry the developer's — which is not the thing being
 *  measured, and not a thing to copy into a file. */
let appEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!have) return;
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), STUB, { mode: 0o755 });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  appEnv = {
    PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":").filter((p) => p.includes("bun") || p.includes("tmux"))].join(":"),
    LANG: process.env.LANG || "C.UTF-8",
    TMUX_TMPDIR: TMUX_TEST_TMPDIR,
    HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
    AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "w.db"),
    AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TMUX_SOCKET: SOCKET,
    AGENTGLASS_TOKEN: MACHINE,
    /* The person's own shell may carry these; a window inherits the server's. */
    AGENTGLASS_PROFILE: "the-person", AGENTGLASS_BROWSER_AS: "the-person",
  };
  /* A worker credential lives in the serving process's memory, so it is minted
     there: the launcher writes it out and then imports the server. */
  const launcher = join(dir, "boot.ts");
  const auth = new URL("../src/auth.ts", import.meta.url).pathname;
  const index = new URL("../src/index.ts", import.meta.url).pathname;
  writeFileSync(launcher, [
    `import { writeFileSync } from "node:fs";`,
    `import { mintSeatToken, mintWorkerToken } from ${JSON.stringify(auth)};`,
    `writeFileSync(${JSON.stringify(tokenFile)}, mintWorkerToken("orbit-window-route"));`,
    `writeFileSync(${JSON.stringify(seatFile)}, mintSeatToken(${JSON.stringify(dir)}, "assign"));`,
    `await import(${JSON.stringify(index)});`,
  ].join("\n"));
  /* The server is here BEFORE the app: born from an environment that carries
     the machine credential, which is the case the app has to clean up. Born
     after it, the app's own client would already be stripped and the test could
     not tell a server it cleaned from one that never held anything. */
  startSession(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "new-session", "-d", "-s", "orbit", "-c", dir, "sleep", "300"],
    { ...appEnv, TMUX: "" });
  proc = Bun.spawn(["bun", "run", launcher], { env: appEnv, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  worker = readFileSync(tokenFile, "utf8").trim();
  seat = readFileSync(seatFile, "utf8").trim();
}, SERVER_BOOT_MS);

afterAll(() => {
  if (have) Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "kill-server"],
    { env: { ...appEnv, TMUX: "" }, stdout: "ignore", stderr: "ignore" });
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const open = (body: Record<string, unknown>, token = MACHINE) =>
  fetch(base + "/terminal/tmux/windows", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base, authorization: `Bearer ${token}` },
    body: JSON.stringify({ session: "orbit", cwd: dir, ...body }),
  });

/** Wait for a file this test wrote to be filled, so nothing is asserted on a race. */
async function filled(path: string): Promise<string> {
  const end = Date.now() + 20_000;
  for (;;) {
    try { const t = readFileSync(path, "utf8"); if (t.trim()) return t; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`nothing was written to ${path}`);
    await Bun.sleep(100);
  }
}

/** A tmux command on this test's own socket, never the developer's. */
function tmuxCmd(args: string[]) {
  return Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, ...args], {
    env: { ...appEnv, TMUX: "" }, stdout: "pipe", stderr: "ignore",
  }).stdout.toString();
}

/** The names in a process's environment, never the values. `/proc` is how a
 *  test sees what a pane really got, rather than what a route said it would. */
function envNamesOf(pid: string): string[] {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((row) => row.split("=")[0] ?? "");
  } catch { return []; }
}

describe("the layout route's own windows", () => {
  test.skipIf(!have)("a credential minted for an agent may not hand it a command, or open a start at all", async () => {
    const marker = join(dir, "agent-ran");
    for (const op of ["new", "split"]) {
      const r = await open({ op, windowId: "@1", title: "out-of-scope", argv: ["sh", "-c", `touch ${marker}`] }, worker);
      expect(r.status, op).toBe(403);
      expect(((await r.json()) as { error: string }).error).toContain("minted for an agent");
    }
    /* No argv is not a way round it: the shell it would open carries the
       server's environment just the same. */
    for (const op of ["new", "split"]) {
      const r = await open({ op, windowId: "@1", title: "out-of-scope" }, worker);
      expect(r.status, `${op} with no argv`).toBe(403);
    }
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test.skipIf(!have)("a command that is not an agent's runs with the browser's variables removed and the OFF marker set", async () => {
    const out = join(dir, "plain.names");
    writeFileSync(out, "");
    const r = await open({ op: "new", title: "orbit-plain", argv: ["sh", "-c", `printenv | sed 's/=.*//' > '${out}'`] });
    expect(r.status).toBe(200);
    const seen = (await filled(out)).split("\n").filter(Boolean);
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) {
      expect(seen, v).not.toContain(v);
    }
    expect(seen).toContain("AGENTGLASS_BROWSER_OFF");
  }, 30_000);

  test.skipIf(!have)("a start with no command is still a start the door covers", async () => {
    const r = await open({ op: "new", title: "orbit-empty" });
    expect(r.status).toBe(200);
    const window = tmuxCmd(["list-windows", "-t", "orbit", "-F", "#{window_name}\t#{window_id}"])
      .split("\n").find((line) => line.startsWith("orbit-empty\t"));
    expect(window).toBeDefined();
    const paneId = window!.split("\t")[1]!;
    const pid = await settled(
      () => tmuxCmd(["list-panes", "-t", `orbit:${paneId}`, "-F", "#{pane_pid}"]).trim(),
      (v) => /^\d+$/.test(v),
    );
    const seen = await settled(() => envNamesOf(pid), (v) => v.length > 1);
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) {
      expect(seen, v).not.toContain(v);
    }
    expect(seen).toContain("AGENTGLASS_BROWSER_OFF");
  }, 30_000);

  test.skipIf(!have)("the tmux server itself holds no browser credential", async () => {
    /* A pane's own `env -u` is not enough: a pane can ask tmux for the SERVER's
       global environment by name. Start a start so the server has been used,
       then ask it what it holds. Names only, never a value. */
    const r = await open({ op: "new", title: "orbit-global", argv: ["sleep", "30"] });
    expect(r.status).toBe(200);
    const names = tmuxCmd(["show-environment", "-g"]).split("\n").filter(Boolean).map((line) => line.split("=")[0]);
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) {
      expect(names, v).not.toContain(v);
    }
  }, 30_000);

  test.skipIf(!have)("a command whose head is an agent CLI is handed that tab's own credential", async () => {
    const out = join(dir, "agent.names");
    const cred = join(dir, "agent.cred");
    writeFileSync(out, "");
    writeFileSync(cred, "");
    const r = await open({ op: "new", title: "orbit-ORBIT-1042", argv: ["claude", out, cred] });
    expect(r.status).toBe(200);
    const seen = (await filled(out)).split("\n").filter(Boolean);
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) expect(seen, v).toContain(v);
    expect(seen).not.toContain("AGENTGLASS_BROWSER_OFF");
    /* The pane's own credential is a worker's, not the machine's: the prefix is
       the part before the underscore, and the value is never read. */
    const [prefix = "", profile = ""] = (await filled(cred)).split("\n");
    expect(prefix).toBe("wk");
    expect(profile).toMatch(/^layout:orbit:@\d+:[^:]+$/);
    expect(profile).not.toContain("orbit-ORBIT-1042");
  }, 30_000);

  test.skipIf(!have)("a split is named from the server's window id, never the caller's title", async () => {
    const target = tmuxCmd(["list-windows", "-t", "orbit", "-F", "#{window_id}"]).split("\n").filter(Boolean)[0]!;
    const out = join(dir, "split.names");
    const cred = join(dir, "split.cred");
    writeFileSync(out, "");
    writeFileSync(cred, "");
    const r = await open({ op: "split", windowId: target, title: "orbit-builder", argv: ["claude", out, cred] });
    expect(r.status).toBe(200);
    await filled(out);
    const [prefix = "", profile = ""] = (await filled(cred)).split("\n");
    expect(prefix).toBe("wk");
    /* The name ends in the tmux server's identity, so a recreated server never
       hands this window's name an old credential. */
    expect(profile.startsWith(`layout:orbit:${target}:`)).toBe(true);
    expect(profile).not.toContain("orbit-builder");
  }, 30_000);
});

/** Ask a fresh pty shell to write down the NAMES in its environment. */
async function ptyEnvNames(token: string, out: string): Promise<string[]> {
  writeFileSync(out, "");
  const url = `ws://127.0.0.1:${new URL(base).port}/terminal/pty?token=${encodeURIComponent(token)}&root=${encodeURIComponent(dir)}&fresh=1&cols=80&rows=24`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("the pty did not open")));
  });
  try {
    ws.send(JSON.stringify({ t: "in", d: `env | sed 's/=.*//' > '${out}'\n` }));
    return (await filled(out)).split("\n").filter(Boolean);
  } finally {
    ws.close();
  }
}

describe("/terminal/pty takes the caller's principal, not a header", () => {
  test.skipIf(!have)("a worker's shell is stripped and marked off", async () => {
    const seen = await ptyEnvNames(worker, join(dir, "worker-pty.names"));
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) {
      expect(seen, v).not.toContain(v);
    }
    expect(seen).toContain("AGENTGLASS_BROWSER_OFF");
  }, 30_000);

  test.skipIf(!have)("the person's own shell keeps the credential it always had", async () => {
    const seen = await ptyEnvNames(MACHINE, join(dir, "person-pty.names"));
    expect(seen).toContain("AGENTGLASS_TOKEN");
    expect(seen).not.toContain("AGENTGLASS_BROWSER_OFF");
  }, 30_000);
});

/** The four names, asserted by NAME only — never a value. */
const FOUR = ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"];

/** What the server on this test's socket holds globally. */
const globalNames = (): string[] =>
  tmuxCmd(["show-environment", "-g"]).split("\n").filter(Boolean).map((line) => line.split("=")[0] ?? "");

/** The engine's pty, held open: with no console and no `fresh` the pty's own
 *  `new-session -A` is the client that may START the server — the case Must 1
 *  is about. */
async function ptyEngine(token: string): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${new URL(base).port}/terminal/pty?token=${encodeURIComponent(token)}&root=${encodeURIComponent(dir)}&cols=80&rows=24`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("the pty did not open")));
  });
  return ws;
}

const runAsync = async (args: string[]) => {
  const r = Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, ...args],
    { env: { ...appEnv, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString() };
};

const shut = async (ws: WebSocket) => {
  ws.close();
  await Bun.sleep(200);
};

describe("a tmux server that dies and comes back", () => {
  test.skipIf(!have)("is started by the app's own pty client holding nothing", async () => {
    const first = await ptyEngine(MACHINE);
    const up = await settled(() => globalNames(), (v) => v.length > 0, 15_000);
    for (const v of FOUR) expect(up, v).not.toContain(v);

    /* Kill it and let the NEXT pty start it, which is the review's sequence:
       the client's environment is what a new server is born with. */
    await shut(first);
    await killServerAndWait(runAsync, SOCKET);
    const second = await ptyEngine(MACHINE);
    const born = await settled(() => globalNames(), (v) => v.length > 0, 15_000);
    for (const v of FOUR) expect(born, v).not.toContain(v);

    /* And a server that came back holding it — a client we did not spawn
       started that one — is swept again rather than remembered as done. */
    await shut(second);
    await killServerAndWait(runAsync, SOCKET);
    Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "new-session", "-d", "-s", "orbit", "-c", dir, "sleep", "300"],
      { env: { ...appEnv, AGENTGLASS_TOKEN: MACHINE }, stdout: "ignore", stderr: "ignore" });
    expect(globalNames()).toContain("AGENTGLASS_TOKEN");

    const third = await ptyEngine(MACHINE);
    const gone = (v: string[]) => FOUR.every((x) => !v.includes(x));
    const swept = await settled(() => globalNames(), gone, 15_000);
    for (const v of FOUR) expect(swept, v).not.toContain(v);
    third.close();
  }, 60_000);
});

describe("the permission ceiling reads the principal", () => {
  test.skipIf(!have)("a seat credential cannot start bypassPermissions, and the four sites ask the principal", async () => {
    /* A seat is refused this door outright (it is a shell behind a GET), so the
       escalation cannot start there at all. */
    const refused = await fetch(`${base}/terminal/pty?token=${encodeURIComponent(seat)}&root=${encodeURIComponent(dir)}`);
    expect(refused.status).toBe(403);

    /* And the ceiling must be the door's answer, not the older `worker` field:
       a seat has a principal and no worker, so reading `worker` called it the
       person and let it through. Measured on the source, because a seat cannot
       reach a frame that would prove it live. */
    const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
    expect(src).toContain("return !!(ws.data as PtyWsData).principal;");
    expect(src).not.toContain("PtyWsData).worker");
    expect((src.match(/agentCaller\(ws\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(launchPerm("bypassPermissions", false, true).mode).not.toBe("bypassPermissions");
  }, 20_000);
});

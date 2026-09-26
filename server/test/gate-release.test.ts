/*
 * The party being held cannot let itself go.
 *
 * The gate is a PreToolUse hook: an agent asks to be stopped, and stays stopped
 * until somebody answers. Everything it is worth rests on the second half, and
 * the second half was not true. The hook that raises the hold runs as this user,
 * so it reads `~/.config/agentglass/token` or finds `AGENTGLASS_TOKEN` in its own
 * environment; `/gate/decide` was behind `trustedCaller`, which admits a caller
 * with no Origin on loopback because that is exactly what a hook is. One `curl`
 * from the agent's own shell released the agent's own call, `actorOf` wrote
 * `local` into the audit row — the same string the desk's button writes — and
 * gate.ts told the model a human had reviewed it.
 *
 * So these run against a real spawned server and are shaped like the attack
 * rather than like a description of it: the request that must fail is a POST
 * carrying the machine token and no Origin header, which is what
 * `curl -H "Authorization: Bearer $AGENTGLASS_TOKEN"` produces and nothing else
 * does. The three that must keep working are the three ways a person actually
 * answers — the packaged shell, a browser on this machine, a paired phone — and
 * they are here because breaking any of them makes the feature worse than the
 * bug did.
 *
 * What this does NOT prove, and no test in this file can: that a determined
 * local process is stopped. `Origin` is a string, and a client that sets it on
 * purpose passes — the last two tests below are, mechanically, that forgery
 * wearing a browser's clothes. The bar this raises is from "the curl you would
 * write anyway" to "a curl written to defeat the gate". See the comment on
 * `mayReleaseAHold` in index.ts, and the scope paragraph in SECURITY.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { DESK_HEADER } from "../src/desk.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "machine-token-for-this-test";

const SERVER_SRC = new URL("../src/index.ts", import.meta.url).pathname;

/** A server with its own scratch HOME, so nothing here can read or write the
 *  developer's real devices, settings or database. */
function serverEnv(dir: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    TMUX_TMPDIR: TMUX_TEST_TMPDIR,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_DATA_HOME: `${dir}/data`,
    XDG_CACHE_HOME: `${dir}/cache`,
    // State (audit log, ledgers, engine conf) jailed too: without this a booted
    // server writes into the developer's real ~/.local/state/agentglass.
    AGENTGLASS_STATE_DIR: `${dir}/state`,
    AGENTGLASS_ROOT: dir,
    AGENTGLASS_DB: join(dir, "gate.db"),
    AGENTGLASS_TOKEN: TOKEN,
    AGENTGLASS_SCAN_DISABLED: "1",
    AGENTGLASS_PORT: String(port),
    ...extra,
  };
}

function spawnServer(dir: string, port: number, extra: Record<string, string> = {}) {
  // Named, never `...process.env` — see gate-actor-route.test.ts. A leaked
  // variable here is a test server reading a real paired-devices file.
  return Bun.spawn(["bun", "run", SERVER_SRC], { env: serverEnv(dir, port, extra), stdout: "ignore", stderr: "pipe" });
}

/**
 * The server as the desktop app starts it: its key down a pipe on fd 3, and
 * AGENTGLASS_DESK_FD naming that descriptor and the pid holding the other end.
 * `key: null` closes the pipe with nothing in it — a desk whose key never came.
 */
const stderrOf = new Map<ChildProcess, () => string>();
function spawnFromDesk(dir: string, port: number, key: string | null): ChildProcess {
  const child = spawn("bun", ["run", SERVER_SRC], {
    env: serverEnv(dir, port, { AGENTGLASS_DESK_FD: `3:${process.pid}` }),
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let said = "";
  child.stderr?.on("data", (c) => { said = (said + c).slice(-8000); });
  stderrOf.set(child, () => said);
  const pipe = child.stdio[3] as Writable;
  pipe.on("error", () => { /* the server went away before reading it */ });
  pipe.end(key === null ? "" : `${key}\n`);
  return child;
}

async function waitFor(base: string, proc?: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  const said = proc ? (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400) : "";
  throw new Error("the server did not come up: " + said);
}

let dir: string, base: string, port = 0, proc: ReturnType<typeof Bun.spawn> | null = null;
let phone = "", tablet = "";
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-gaterelease-"));
  // Minted into the store the server will read. The server loads it once, when
  // it starts, so writing it before the spawn is the ordering requirement.
  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  phone = issueDevice("Pixel 9", "answer").token;
  tablet = issueDevice("an old tablet", "read").token;

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawnServer(dir, port);
  await waitFor(base, proc);
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const as = (cred: string) => ({ authorization: `Bearer ${cred}`, "content-type": "application/json" });

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/**
 * Hold a tool call the way `hooks/gate_event.py` does: a POST that does not
 * come back until somebody answers it, with the hook's own id on it, and no
 * Origin header — because Python's urllib sends none and never will.
 *
 * The promise is returned rather than dropped: what /gate answers when the
 * hold is finally released is the payload the stopped model reads, and one
 * test below is about exactly that.
 */
function hold(id: string, timeoutMs = 30_000, at = base): Promise<Json> {
  const held = fetch(at + "/gate", {
    method: "POST", headers: as(TOKEN),
    body: JSON.stringify({
      id, source_app: "claude", session_id: "s-1", tool_name: "Bash",
      tool_input: { command: "rm -rf build" }, timeout_ms: timeoutMs,
    }),
  }).then((r) => r.json() as Promise<Json>);
  held.catch(() => { /* a test that never releases it is not a failure here */ });
  return held;
}

/** Wait until the server is really holding it, so a refusal below cannot be
 *  "there was nothing to decide". */
async function queued(id: string, at = base): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(at + "/gate/pending", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    if (r.gates.some((g: Json) => g.id === id)) return;
    await Bun.sleep(50);
  }
  throw new Error("the gate never appeared in the pending queue");
}

const isPending = async (id: string, at = base): Promise<boolean> =>
  (await fetch(at + "/gate/pending", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>))
    .gates.some((g: Json) => g.id === id);

/** One decision, with whatever a caller would present: a credential, and an
 *  Origin only if it is the kind of client that sends one. */
const decide = (id: string, cred: string, origin?: string, extra: Record<string, string> = {}, at = base) =>
  fetch(at + "/gate/decide", {
    method: "POST",
    headers: { ...(origin ? { ...as(cred), origin } : as(cred)), ...extra },
    body: JSON.stringify({ id, decision: "allow", reason: "go ahead" }),
  });

describe("the held party cannot release itself", () => {
  test("the machine token from a shell with no Origin is refused, and the call stays held", async () => {
    const id = nextId();
    hold(id);
    await queued(id);

    // The attack, in the shape it actually arrives in. Nothing about this
    // request is malformed — it is the credential the hook itself is given,
    // from the machine the server is running on.
    const r = await decide(id, TOKEN);
    expect(r.status).toBe(403);

    // A bare 403 sends the reader looking for a bug in their client, so the
    // sentence has to name the rule.
    const why = (await r.json()) as Json;
    expect(why.ok).toBe(false);
    expect(why.error).toContain("released by a person");
    expect(why.error).toContain("paired-device");

    // The half that matters more than the status code: nothing moved. A
    // refusal that still resolved the row would be the same bug with a
    // different response.
    expect(await isPending(id)).toBe(true);
  });

  test("a paired phone with the answer grant decides it, carrying no Origin at all", async () => {
    // The companion is a React Native client: it sends a credential and no
    // Origin header, so a rule written only around Origin would have locked the
    // phone out of the one thing a phone is for. The device credential is the
    // proof here — it is minted at the desk, kept as a hash, and is not in any
    // environment an agent inherits.
    const id = nextId();
    const held = hold(id);
    await queued(id);

    const r = await decide(id, phone);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);

    // And the stopped call is genuinely let go, not just marked.
    expect((await held).decision).toBe("allow");
  });

  test("a look-only phone is still refused by the scope rule, not by this one", async () => {
    // The two layers answer different questions and must not be confused: this
    // device may not answer gates at all, and the reply says so in the words
    // the pairing screen uses rather than in the words above.
    const id = nextId();
    hold(id);
    await queued(id);

    const r = await decide(id, tablet);
    expect(r.status).toBe(403);
    const why = (await r.json()) as Json;
    expect(why.scope).toBe("read");
    expect(why.needs).toBe("answer");
    expect(await isPending(id)).toBe(true);
  });

  test("on a server started by hand, the desktop scheme as Origin decides it: no desk is there to hold a key", async () => {
    const id = nextId();
    const held = hold(id);
    await queued(id);

    const r = await decide(id, TOKEN, "agentglass://app");
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);
    expect((await held).decision).toBe("allow");
  });

  test("on a server started by hand, a browser page on this machine decides it", async () => {
    // A browser attaches Origin to every POST, same-origin ones included, so
    // the web UI works through this branch while curl and urllib do not. It is
    // also, mechanically, the forgery: see the desk tests below for the server
    // where that is refused.
    const id = nextId();
    const held = hold(id);
    await queued(id);

    const r = await decide(id, TOKEN, base);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);
    expect((await held).decision).toBe("allow");
  });

  test("a page on a real website is refused, as it always was", async () => {
    const id = nextId();
    hold(id);
    await queued(id);
    const r = await decide(id, TOKEN, "https://example.invalid");
    expect(r.status).toBe(403);
    expect(await isPending(id)).toBe(true);
  });
});

describe("on a server the desktop app started, an Origin no longer lets a hold go", () => {
  /*
   * The forgery the hand-started tests above cannot refuse: `Origin` is a
   * header, and a process that sets the app's own scheme or the page's own
   * origin on purpose passed. Where the desktop app started the server, a
   * release asks for the app's key instead — handed to the server down a pipe
   * and to its renderer through the preload, in no environment and no argv an
   * agent running as this user can read (loadDeskKey in auth.ts).
   */
  const DESK = "desk-key-the-shell-minted-for-this-test-0123456789";
  let dDir = "", dBase = "", dProc: ChildProcess | null = null;
  const deskHeader = { "x-agentglass-desk": DESK };

  beforeAll(async () => {
    dDir = mkdtempSync(join(tmpdir(), "agx-gatedesk-"));
    // The same paired phone and look-only tablet as the server above.
    cpSync(join(dir, "agentglass"), join(dDir, "agentglass"), { recursive: true });
    const p = await freePort();
    dBase = `http://127.0.0.1:${p}`;
    dProc = spawnFromDesk(dDir, p, DESK);
    await waitFor(dBase);
  });

  afterAll(() => {
    try { dProc?.kill(); } catch { /* already gone */ }
    try { rmSync(dDir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("the machine token with the app's own scheme as Origin, set by hand, is refused and the call stays held", async () => {
    const id = nextId();
    hold(id, 30_000, dBase);
    await queued(id, dBase);
    const r = await decide(id, TOKEN, "agentglass://app", {}, dBase);
    expect(r.status).toBe(403);
    const why = (await r.json()) as Json;
    expect(why.error).toContain("released by a person");
    expect(why.error).toContain("desktop app");
    expect(await isPending(id, dBase)).toBe(true);
  });

  test("so is the page's own origin, which is the same forgery dressed as a browser", async () => {
    const id = nextId();
    hold(id, 30_000, dBase);
    await queued(id, dBase);
    expect((await decide(id, TOKEN, dBase, {}, dBase)).status).toBe(403);
    expect(await isPending(id, dBase)).toBe(true);
  });

  test("a key that is not the app's is refused", async () => {
    const id = nextId();
    hold(id, 30_000, dBase);
    await queued(id, dBase);
    for (const k of ["", "not-the-desk-key", DESK.slice(0, -1), `${DESK}x`]) {
      const r = await decide(id, TOKEN, "agentglass://app", { "x-agentglass-desk": k }, dBase);
      expect(r.status, JSON.stringify(k)).toBe(403);
    }
    expect(await isPending(id, dBase)).toBe(true);
  });

  test("the app's key lets it go, as the renderer sends it", async () => {
    const id = nextId();
    const held = hold(id, 30_000, dBase);
    await queued(id, dBase);
    const r = await decide(id, TOKEN, "agentglass://app", deskHeader, dBase);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);
    expect((await held).decision).toBe("allow");
  });

  test("a paired phone still decides it, carrying no Origin and no key", async () => {
    const id = nextId();
    const held = hold(id, 30_000, dBase);
    await queued(id, dBase);
    const r = await decide(id, phone, undefined, {}, dBase);
    expect(r.status).toBe(200);
    expect((await held).decision).toBe("allow");
  });

  test("a device written into the store behind the server's back answers nothing, and the desk is told", async () => {
    // The file is 0600 and this user's, so a process that is the user can add
    // a row with a hash of a token it chose. The server loaded the store when
    // it started and changes it only through pairing, so the row is not read.
    const forged = "a-token-the-held-agent-chose-for-itself-0123456789";
    const path = join(dDir, "agentglass", "devices.json");
    const store = JSON.parse(readFileSync(path, "utf8")) as { devices: Record<string, unknown>[] };
    store.devices.push({ id: "f0f0f0f0f0f0f0f0", label: "Pixel 9", scope: "answer", createdAt: Date.now(),
      hash: createHash("sha256").update(forged).digest("hex") });
    writeFileSync(path, JSON.stringify(store, null, 2));

    const id = nextId();
    const held = hold(id, 30_000, dBase);
    await queued(id, dBase);
    const r = await decide(id, forged, undefined, {}, dBase);
    expect(r.status).not.toBe(200);
    expect(await isPending(id, dBase)).toBe(true);
    // The phone paired before is still the phone, and the change was noticed.
    expect((await decide(id, phone, undefined, {}, dBase)).status).toBe(200);
    expect((await held).decision).toBe("allow");
    expect(stderrOf.get(dProc!)?.()).toContain("devices.json changed outside agentglass");
  });

  test("accepting a pairing asks for the key as well, so an agent cannot finish the ceremony itself", async () => {
    // Accepting mints a device, and a device releases holds. The same test as
    // the release for the same reason (see /pair/accept in index.ts).
    const t = (await fetch(dBase + "/pair/ticket", { method: "POST", headers: as(TOKEN), body: "{}" })
      .then((x) => x.json())) as Json;
    expect(t.ok).toBe(true);
    const accept = (extra: Record<string, string>) => fetch(dBase + "/pair/accept", {
      method: "POST", headers: { ...as(TOKEN), origin: "agentglass://app", ...extra },
      body: JSON.stringify({ ticket: t.id, scope: "answer" }),
    });
    expect((await accept({})).status).toBe(403);
    // With the key the rule lets it through to the ticket, which nobody has
    // claimed yet: refused for THAT reason, and not by the rule.
    const r = await accept(deskHeader);
    expect(r.status).not.toBe(403);
    expect(((await r.json()) as Json).error).toContain("not waiting on you");
  });
});

describe("a desk is its pipe and its parent, not a variable", () => {
  test("the key is read before anything else in the server can start a child", () => {
    // Whatever the server spawns while the descriptor is open inherits it, and
    // could read the key before the server does.
    const src = readFileSync(SERVER_SRC, "utf8");
    const imports = src.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.slice(0, 2)).toEqual(['import "./cookieentry.ts";', 'import "./desk.ts";']);
    const desk = readFileSync(new URL("../src/desk.ts", import.meta.url), "utf8");
    expect(desk.split("\n").filter((l) => l.startsWith("import "))).toEqual(['import { closeSync, readFileSync } from "node:fs";']);
    expect(desk).toContain("closeSync(fd)");
  });

  let eDir = "";
  const procs: { kill: () => unknown }[] = [];

  beforeAll(() => {
    eDir = mkdtempSync(join(tmpdir(), "agx-gatedesk-edge-"));
    cpSync(join(dir, "agentglass"), join(eDir, "a", "agentglass"), { recursive: true });
    cpSync(join(dir, "agentglass"), join(eDir, "b", "agentglass"), { recursive: true });
  });

  afterAll(() => {
    for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
    try { rmSync(eDir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("a pipe closed with no key in it still refuses an Origin: the desk is there, its key is not", async () => {
    const p = await freePort();
    const at = `http://127.0.0.1:${p}`;
    procs.push(spawnFromDesk(join(eDir, "a"), p, null));
    await waitFor(at);
    const id = nextId();
    const held = hold(id, 30_000, at);
    await queued(id, at);
    expect((await decide(id, TOKEN, "agentglass://app", {}, at)).status).toBe(403);
    expect((await decide(id, phone, undefined, {}, at)).status).toBe(200);
    expect((await held).decision).toBe("allow");
  });

  test("the variable naming a pid that is not the server's parent is a server started by hand", async () => {
    // Every terminal and agent the app starts inherits the sidecar's
    // environment, variable included. A server started from one of them has
    // another parent and no pipe: it must boot, and not wait on a descriptor.
    const p = await freePort();
    const at = `http://127.0.0.1:${p}`;
    const proc = spawnServer(join(eDir, "b"), p, { AGENTGLASS_DESK_FD: "3:1" });
    procs.push(proc);
    await waitFor(at, proc);
    const id = nextId();
    const held = hold(id, 30_000, at);
    await queued(id, at);
    expect((await decide(id, TOKEN, at, {}, at)).status).toBe(200);
    expect((await held).decision).toBe("allow");
  });
});

describe("the desktop app hands its key to the two ends that use it, and nowhere else", () => {
  // No renderer runs here, so where the key travels is asserted on the source.
  const MAIN = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");
  const PRELOAD = readFileSync(new URL("../../electron/preload.js", import.meta.url), "utf8");
  const API = readFileSync(new URL("../../web/src/lib/api.ts", import.meta.url), "utf8");
  const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  /** From `head` to that function's own closing brace. `open` is what ends the
   *  signature, for one whose parameters carry a type literal of their own. */
  const body = (src: string, head: string, open = "{"): string => {
    const at = src.indexOf(head);
    expect(at, head).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = src.indexOf(open, at) + open.length - 1; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`no end to ${head}`);
  };

  test("minted for each sidecar and sent down fd 3, never into its environment; an adopted server gets the key it is claimed with", () => {
    expect(MAIN).toMatch(/^let deskKey = null;/m);
    const env = code(body(MAIN, "function sidecarEnv("));
    expect(env).not.toContain("deskKey");
    expect(env).toContain("if (DESK_PIPE) env.AGENTGLASS_DESK_FD = `3:${process.pid}`;");
    const boot = code(body(MAIN, "async function ensureServer("));
    // An adopted server was never piped a key: the app claims one for it
    // (desk-claim.test.ts), and a spawn lets any such claim go.
    expect(boot).toContain("if (adopt) { holdAdoptedDesk(port); reportSidecar(null); return true; }");
    expect(boot.indexOf("letDeskGo?.();")).toBeLessThan(boot.indexOf("spawn(cmd"));
    const mint = boot.indexOf('deskKey = DESK_PIPE ? require("crypto").randomBytes(32)');
    expect(mint).toBeGreaterThan(-1);
    // Before the first await: createWindow() has just run, and its preload asks
    // for the key once this task yields.
    const firstAwait = boot.indexOf("await ");
    expect(firstAwait === -1 || mint < firstAwait).toBe(true);
    expect(boot).toContain('stdio: DESK_PIPE ? ["ignore", "ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"]');
    // The listener first: a sidecar that exits unread answers with ECONNRESET.
    const listen = boot.indexOf('desk?.on("error"');
    expect(listen).toBeGreaterThan(-1);
    expect(listen).toBeLessThan(boot.indexOf('if (deskKey) desk?.end(deskKey + "\\n");'));
    // Declared, cleared, set and pushed by the adopted server's claim, minted,
    // piped (twice on one line), pushed on restart, cleared and pushed when an
    // adopted server's desk is taken and the app leaves it, and the IPC line
    // (the channel's name and the answer): a use past these — a file, a variable, a
    // log line — is a change somebody has to look at.
    expect([...code(MAIN).matchAll(/\bdeskKey\b/g)]).toHaveLength(12);
  });

  test("the renderer asks for it from a window's own page, is handed the next one on a restart, and carries it on the two requests that need it", () => {
    expect(MAIN).toContain('ipcMain.on("ag:deskKey", (e) => { e.returnValue = (e.sender.getType() === "window" || isLaneHost(e.sender)) ? deskKey : null; });');
    expect(code(body(MAIN, "async function restartSidecar("))).toContain("{ origin: apiOrigin, token: sidecarUp ? currentToken() : null, deskKey }");
    expect(PRELOAD).toContain('ipcRenderer.sendSync("ag:deskKey")');
    expect(API).toContain(`"${DESK_HEADER}": DESK_KEY`);
    expect(code(body(API, "export function adoptServer(", "): void {"))).toContain('if (next.deskKey !== undefined) DESK_KEY = next.deskKey ?? "";');
    const sent = code(API);
    expect(sent).toContain('fetch(SERVER + "/gate/decide", {\n      method: "POST",\n      headers: authHeaders({ "content-type": "application/json", ...deskHeader() }),');
    expect(sent).toContain('"/pair/accept", { ticket, scope }, deskHeader())');
    /* And the two registrations a browser window makes (who receives an agent's
       asks is as much the app's to say as who releases its gate). The count is
       the point: a fifth use is a change somebody has to look at. */
    expect(sent).toContain('"/browser/ready", { client, on, manager: true }, deskHeader())');
    expect(sent).toContain('"/browser/ready", { client, on, lanes }, deskHeader())');
    expect([...sent.matchAll(/deskHeader\(\)/g)]).toHaveLength(4);
  });
});

describe("the hook's own two paths are untouched", () => {
  test("submitting a hold needs no Origin — that is the agent asking to be held", async () => {
    // The route that is working correctly. An Origin-less POST /gate is the
    // hook, and tightening it would mean nothing is ever held in the first
    // place.
    const id = nextId();
    const held = hold(id);
    await queued(id);
    expect(await isPending(id)).toBe(true);
    await decide(id, phone);
    expect((await held).decision).toBe("allow");
  });

  test("re-attaching after a dropped connection needs no Origin either", async () => {
    /*
     * The failure this pins is silent and total. `gate_event.py` long-polls
     * `/gate/status` when its connection drops, with urllib and therefore with
     * no Origin. A 403 there is not read as a refusal: the retry loop treats
     * any non-404 error as "the connection went away", keeps retrying until its
     * own deadline, and then falls into fail-open. Every held call on the
     * machine would auto-allow while the queue still looked healthy on screen.
     */
    const id = nextId();
    hold(id);
    await queued(id);

    // Long-poll the way the hook does, before anybody has answered.
    const reattached = fetch(base + `/gate/status?id=${encodeURIComponent(id)}`, { headers: as(TOKEN) });
    await decide(id, TOKEN, "agentglass://app");

    const r = await reattached;
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).decision).toBe("allow");
  });

  test("and reading the queue needs no Origin, which is the decision recorded next to those reads", async () => {
    for (const path of ["/gate/pending", "/gate/history?limit=5"]) {
      expect((await fetch(base + path, { headers: as(TOKEN) })).status, path).toBe(200);
    }
  });
});

describe("the budget brake has an off switch", () => {
  /*
   * `/budgets/set` is where the budget-to-gate brake is armed: over the limit,
   * `budgetHoldFor` puts a reason on the hold and, fail-closed, is what turns
   * an unanswered call into a denial. Every other write family could already be
   * turned off with one variable; this one could not, which made raising your
   * own ceiling the least guarded write in the server.
   */
  let bDir: string, bBase: string, bProc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    bDir = mkdtempSync(join(tmpdir(), "agx-budgetoff-"));
    const p = await freePort();
    bBase = `http://127.0.0.1:${p}`;
    bProc = spawnServer(bDir, p, { AGENTGLASS_BUDGET_WRITE_DISABLED: "1" });
    await waitFor(bBase, bProc);
  });

  afterAll(() => {
    try { bProc?.kill(); } catch { /* already gone */ }
    try { rmSync(bDir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("with the switch on, a budget write is refused and says which variable did it", async () => {
    const r = await fetch(bBase + "/budgets/set", {
      method: "POST", headers: as(TOKEN),
      body: JSON.stringify({ budgets: [{ root: "", model: "", limit: 9999, period: "month" }] }),
    });
    expect(r.status).toBe(403);
    const why = (await r.json()) as Json;
    expect(why.ok).toBe(false);
    expect(why.error).toContain("AGENTGLASS_BUDGET_WRITE_DISABLED");

    // Refused before the body is even parsed, and nothing was stored.
    const after = await fetch(bBase + "/budgets", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    expect(after.budgets).toEqual([]);
  });
});

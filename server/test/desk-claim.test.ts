// A server the desktop app adopts, rather than starts, gets the desk key by a
// claim the app holds open.
//
// What was wrong: the key only ever reached a server down the pipe the app
// hands the sidecar it spawns (desk.ts). A server that was already running —
// one started by hand with a token, a sidecar left by an earlier launch — was
// adopted with no key, so registering a browser host and releasing a held call
// fell back to the Origin rule there, and any holder of the machine token that
// set `Origin: agentglass://app` passed both.
//
// The claim is what closes it: the machine token itself, with no Origin, from a
// direct loopback socket, may name the key once, and it holds for as long as
// that connection stays open. Every caller that can claim could already forge
// the Origin, so a hostile claim gains nothing it did not have; an honest one
// shuts the forgery for as long as the app runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const require = createRequire(import.meta.url);
const shell = require("../../electron/server-probe.js") as {
  holdDesk(port: number, opts: {
    token: () => string | null; key: string; onChange: (key: string | null) => void;
    retryMs?: number; host?: string; onTaken?: () => void;
  }): () => void;
};

const TOKEN = "orbit-claim-token-0123456789abcdef";
const KEY = "desk-key-the-shell-minted-0123456789abcdefgh";
const APP = "agentglass://app";
const SERVER_SRC = new URL("../src/index.ts", import.meta.url).pathname;

type Json = Record<string, any>;

function env(dir: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  // Named, never `...process.env`: a leaked variable is a test server reading
  // the developer's own files.
  return {
    PATH: process.env.PATH ?? "",
    TMUX_TMPDIR: TMUX_TEST_TMPDIR,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CACHE_HOME: join(dir, "cache"),
    AGENTGLASS_STATE_DIR: join(dir, "state"),
    CLAUDE_CONFIG_DIR: join(dir, ".claude"),
    AGENTGLASS_ROOT: dir,
    AGENTGLASS_DB: join(dir, "claim.db"),
    AGENTGLASS_TOKEN: TOKEN,
    AGENTGLASS_SCAN_DISABLED: "1",
    AGENTGLASS_PORT: String(port),
    ...extra,
  };
}

async function up(base: string, said: () => string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + said().slice(0, 400));
}

function boot(dir: string, port: number, desk: string | null): ChildProcess {
  const child = desk === null
    ? spawn("bun", ["run", SERVER_SRC], { env: env(dir, port), stdio: ["ignore", "ignore", "pipe"] })
    : spawn("bun", ["run", SERVER_SRC], {
      env: env(dir, port, { AGENTGLASS_DESK_FD: `3:${process.pid}` }),
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
  if (desk !== null) {
    const pipe = child.stdio[3] as Writable;
    pipe.on("error", () => { /* it went away before reading */ });
    pipe.end(`${desk}\n`);
  }
  return child;
}

const bearer = { authorization: `Bearer ${TOKEN}` };

/** What a machine-token holder forging the app's Origin sends to take the browser. */
const register = (base: string, headers: Record<string, string> = {}) =>
  fetch(base + "/browser/ready", {
    method: "POST",
    headers: { ...bearer, origin: APP, "content-type": "application/json", ...headers },
    body: JSON.stringify({ client: "orbit-window", on: false }),
  });

/** A claim, opened and left open; `close()` drops it. */
async function claim(base: string, headers: Record<string, string>) {
  const ac = new AbortController();
  const r = await fetch(base + "/desk/claim", { method: "POST", headers, signal: ac.signal });
  let first = "";
  if (r.status === 200) {
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    first = new TextDecoder().decode(value);
  } else {
    await r.text();
  }
  return { status: r.status, first, close: () => ac.abort() };
}

/** Until the server has seen the claim's connection go. */
async function until(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("a server the app did not start", () => {
  let dir = "", base = "", port = 0, proc: ChildProcess | null = null, said = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-claim-"));
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = boot(dir, port, null);
    proc.stderr?.on("data", (c) => { said = (said + c).slice(-8000); });
    await up(base, () => said);
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("before any claim, the Origin rule stands: a forged Origin registers (the ceiling being closed)", async () => {
    expect((await register(base)).status).toBe(200);
  });

  test("a claim from a page — anything carrying an Origin — is refused", async () => {
    const c = await claim(base, { ...bearer, origin: APP, "x-agentglass-desk": KEY });
    expect(c.status).toBe(403);
    expect((await register(base)).status).toBe(200);
  });

  test("a claim without the token is refused", async () => {
    const c = await claim(base, { "x-agentglass-desk": KEY });
    expect(c.status).toBe(401);
  });

  test("a claim with no key, or a short one, is refused", async () => {
    expect((await claim(base, bearer)).status).toBe(400);
    expect((await claim(base, { ...bearer, "x-agentglass-desk": "short" })).status).toBe(400);
  });

  test("while the app holds its claim, the forged Origin is refused and the key is what passes", async () => {
    const c = await claim(base, { ...bearer, "x-agentglass-desk": KEY });
    try {
      expect(c.status).toBe(200);
      expect(c.first).toContain("held");
      const forged = await register(base);
      expect(forged.status).toBe(403);
      expect(((await forged.json()) as Json).error).toContain("desktop app");
      for (const k of ["not-the-key", KEY.slice(0, -1), `${KEY}x`]) {
        expect((await register(base, { "x-agentglass-desk": k })).status, k).toBe(403);
      }
      expect((await register(base, { "x-agentglass-desk": KEY })).status).toBe(200);
    } finally { c.close(); }
  });

  test("a second claim while one is held is refused, and does not replace it", async () => {
    const c = await claim(base, { ...bearer, "x-agentglass-desk": KEY });
    try {
      const other = "a-second-claimant-key-0123456789abcdefghij";
      const again = await claim(base, { ...bearer, "x-agentglass-desk": other });
      expect(again.status).toBe(409);
      expect((await register(base, { "x-agentglass-desk": other })).status).toBe(403);
      expect((await register(base, { "x-agentglass-desk": KEY })).status).toBe(200);
    } finally { c.close(); }
  });

  test("when the claim's connection goes, the claim goes with it", async () => {
    const c = await claim(base, { ...bearer, "x-agentglass-desk": KEY });
    expect(c.status).toBe(200);
    c.close();
    expect(await until(async () => (await register(base)).status === 200)).toBe(true);
    const next = await claim(base, { ...bearer, "x-agentglass-desk": KEY });
    try { expect(next.status).toBe(200); } finally { next.close(); }
  });

  test("the shell's holder proves the server, claims, and hands the key over", async () => {
    const seen: (string | null)[] = [];
    const stop = shell.holdDesk(port, { token: () => TOKEN, key: KEY, onChange: (k) => seen.push(k) });
    try {
      expect(await until(async () => seen.includes(KEY))).toBe(true);
      expect((await register(base)).status).toBe(403);
      expect((await register(base, { "x-agentglass-desk": KEY })).status).toBe(200);
    } finally { stop(); }
    expect(await until(async () => (await register(base)).status === 200)).toBe(true);
  });

  test("the shell's holder, beaten to the claim, hands over no key and takes it once the other lets go", async () => {
    const other = await claim(base, { ...bearer, "x-agentglass-desk": "someone-else-got-here-first-0123456789ab" });
    expect(other.status).toBe(200);
    const seen: (string | null)[] = [];
    const stop = shell.holdDesk(port, { token: () => TOKEN, key: KEY, onChange: (k) => seen.push(k), retryMs: 100 });
    try {
      expect(await until(async () => seen.length > 0)).toBe(true);
      expect(seen[0]).toBeNull();
      other.close();
      expect(await until(async () => seen.includes(KEY))).toBe(true);
    } finally { stop(); }
  });

  test("a shell that would rather leave than wait is told once that the desk is taken, and stops claiming", async () => {
    const other = await claim(base, { ...bearer, "x-agentglass-desk": "someone-else-got-here-first-0123456789ab" });
    expect(other.status).toBe(200);
    const seen: (string | null)[] = [];
    let taken = 0;
    const stop = shell.holdDesk(port, { token: () => TOKEN, key: KEY, onChange: (k) => seen.push(k), onTaken: () => { taken++; }, retryMs: 50 });
    try {
      expect(await until(async () => taken > 0)).toBe(true);
      other.close();
      await Bun.sleep(400);
      // Released by the other holder, and still not claimed: it left.
      expect(taken).toBe(1);
      expect(seen.includes(KEY)).toBe(false);
    } finally { stop(); other.close(); }
  });
});

describe("a server the app started", () => {
  let dir = "", base = "", port = 0, proc: ChildProcess | null = null, said = "";
  const PIPED = "desk-key-down-the-pipe-0123456789abcdefghij";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-claim-desk-"));
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = boot(dir, port, PIPED);
    proc.stderr?.on("data", (c) => { said = (said + c).slice(-8000); });
    await up(base, () => said);
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("already has its key, and a claim cannot replace it", async () => {
    const c = await claim(base, { ...bearer, "x-agentglass-desk": KEY });
    expect(c.status).toBe(409);
    expect((await register(base, { "x-agentglass-desk": KEY })).status).toBe(403);
    expect((await register(base, { "x-agentglass-desk": PIPED })).status).toBe(200);
  });
});

describe("a squatter on an adopted port", () => {
  test("is proved before every claim, and is sent neither the token nor the key", async () => {
    const seen: { auth: string | null; desk: string | null; path: string }[] = [];
    const srv = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ auth: req.headers.get("authorization"), desk: req.headers.get("x-agentglass-desk"), path: new URL(req.url).pathname });
        return Response.json({ ok: true, service: "agentglass", clients: 0 });
      },
    });
    const got: (string | null)[] = [];
    const stop = shell.holdDesk(srv.port!, { token: () => TOKEN, key: KEY, onChange: (k) => got.push(k), retryMs: 50 });
    try {
      expect(await until(async () => seen.length >= 2)).toBe(true);
      for (const r of seen) {
        expect(r.path).toBe("/health");
        expect(r.auth).toBeNull();
        expect(r.desk).toBeNull();
      }
      expect(got.every((k) => k === null)).toBe(true);
    } finally { stop(); srv.stop(true); }
  });
});

// main.js is the Electron entry point and cannot be imported under bun, and the
// route's caller rule has shapes (a paired device, a plugin, a seat) this file
// does not boot, so those are asserted against source.
const MAIN = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
const INDEX = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const DESKTOP = await Bun.file(new URL("../../web/src/lib/desktop.ts", import.meta.url)).text();
const own = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no end to ${head}`);
};

describe("the wiring", () => {
  test("only the machine token itself, with no Origin, on a direct loopback socket, may claim", () => {
    const route = own(INDEX, 'if (pathname === "/desk/claim" && req.method === "POST") {');
    expect(route).toContain('const direct = peer.source === "socket" && !!clientIp && isLoopback(clientIp);');
    expect(route).toContain('if (caller?.kind !== "machine" || caller.principal || req.headers.get("origin") || !direct) {');
    expect(route).toContain('req.signal.addEventListener("abort", drop, { once: true });');
  });

  test("a held desk, piped or claimed, is what both desk-only gates ask about", () => {
    expect(own(INDEX, "function mayHostBrowser(")).toContain("if (deskHeld()) return deskKeyOk(req);");
    expect(own(INDEX, "function mayReleaseAHold(")).toContain("if (deskHeld()) return deskKeyOk(req);");
  });

  test("the app holds the claim on the server it adopted, only while that server is its server", () => {
    const hold = own(MAIN, "function holdAdoptedDesk(");
    expect(hold).toContain("letDeskGo = holdDesk(port, {");
    expect(hold).toContain("if (sidecar || SERVER_PORT !== port) return;");
    expect(own(MAIN, "function stopSidecar(")).toContain("letDeskGo?.();");
  });

  test("an adopted server whose desk another process holds is left: the app starts its own on a free port", () => {
    expect(own(MAIN, "function holdAdoptedDesk(")).toContain("onTaken: () => { if (!sidecar && SERVER_PORT === port) void leaveTakenServer(); },");
    const leave = own(MAIN, "async function leaveTakenServer(");
    expect(leave).toContain('states.indexOf("free")');
    expect(leave).toContain("await ensureServer(false);");
    expect(leave).not.toContain("holdAdoptedDesk(");
  });

  test("a key taken or lost does not reconnect every socket in the window", () => {
    expect(own(DESKTOP, "export function followServerChanges(")).toContain(
      'if (p.origin !== undefined || p.token !== undefined) window.dispatchEvent(new CustomEvent("agentglass:server-changed"));');
  });
});

/*
 * End to end: a real server, behind a proxy that behaves the way `tailscale
 * serve` was measured to behave.
 *
 * The blocker this pins. tailscaled terminates TLS and re-dials 127.0.0.1, so
 * the server believed every client on the tailnet was the desk. Through the
 * HTTPS name, with no token at all:
 *
 *   /health   -> 200
 *   /ingest   -> 400   ** past the auth gate, inside the handler **
 *   /sessions -> 401
 *
 * A 400 is the schema complaining. The request was already in. The tokenless
 * LOCAL_SINKS exemption ("only from this machine") covered the whole tailnet,
 * the device list was empty for those phones because noteClient drops loopback
 * on purpose, and Block was dead because isSelf() called them this machine.
 *
 * ingest-origin.test.ts says the other half of this could not be reached from
 * a test, because proving the refusal needs a second non-loopback address and
 * CI has none. That is no longer true: a proxy needs no address of its own, it
 * only needs to say who it is speaking for — and saying it is now not enough.
 *
 * What the proxy here replicates is what was actually measured off tailscaled,
 * not what its documentation implies:
 *   * X-Forwarded-For is REPLACED, never appended. Two forged entries went in
 *     and one bare peer address came out.
 *   * Tailscale-User-Login / -Name / -Profile-Pic are replaced too.
 *   * Tailscale-Headers-Info is added as a marker.
 *   * X-Real-IP and Tailscale-Headers are passed through UNTOUCHED, so a
 *     tailnet client sets those itself. The last test here is about that.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "test-machine-token-not-a-real-one";
/** Not this machine's own tailnet address, so it is a device and not "self". */
const PHONE = "100.101.102.103";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
let proxy: ReturnType<typeof Bun.serve> | null = null;
let via: string;

// A second server, deliberately WITHOUT the preload seam.
//
// The seam tells the first server "the test runner's uid is the proxy's uid",
// which is what lets a test proxy stand in for tailscaled at all — and it also
// means that inside that server every loopback caller from this uid counts as
// a proxy, so the one thing it cannot prove is that a forger is turned away.
// This one trusts the real tailscaled uid (0), so the forging test below is
// the genuine article: same headers, same loopback socket, wrong uid.
let plainDir: string, plain: string, plainProc: ReturnType<typeof Bun.spawn> | null = null;

/** The forger test is about a uid mismatch, so it needs /proc to read uids
 *  from and a non-root runner to be a mismatch. Root in a container is not a
 *  meaningful "other user" here. */
const canProveForgery = process.platform === "linux" && (process.getuid?.() ?? 0) !== 0;

/**
 * A stand-in for tailscaled: it dials the server from loopback and says who it
 * is speaking for, exactly the way serve does.
 *
 * `claim` is what the far-side client tried to put in its own headers, kept so
 * one test can prove a client cannot smuggle a value past a proxy that
 * overwrites — and another can prove the server ignores the headers tailscaled
 * does NOT overwrite.
 */
function startProxy(target: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const h = new Headers(req.headers);
      const speakingFor = h.get("x-test-speaking-for") || PHONE;
      h.delete("x-test-speaking-for");
      h.set("x-forwarded-for", speakingFor); // replaced, never appended
      h.set("x-forwarded-proto", "https");
      h.set("tailscale-headers-info", "https://tailscale.com/s/serve-headers");
      h.set("tailscale-user-login", "owner@example.com");
      h.delete("host");
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(target + u.pathname + u.search, { method: req.method, headers: h, body });
    },
  });
}

/** Spawn a server, optionally with the uid seam preloaded, and wait for it. */
async function spawnServer(at: string, port: number, seam: boolean) {
  const src = new URL("../src/index.ts", import.meta.url).pathname;
  const preload = new URL("./fixtures/trust-test-proxy.ts", import.meta.url).pathname;
  // `--preload` goes after `run`, not before it: `bun --preload X run Y` prints
  // the usage banner and exits, which surfaces here only as a beforeAll timeout.
  const argv = seam ? ["bun", "run", "--preload", preload, src] : ["bun", "run", src];
  const p = Bun.spawn(argv, {
    // A named environment, never `...process.env`: `bun test` shares one
    // process across files, so the parent's environment is whatever every
    // suite before this one happened to leave on it.
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: at,
      AGENTGLASS_ROOT: at,
      AGENTGLASS_DB: join(at, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // Without this the gate is skipped entirely and every assertion below
      // would pass for the wrong reason.
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return p;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`server on ${port} did not start`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-serve-proxy-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = await spawnServer(dir, port, true);
  proxy = startProxy(base);
  via = `http://127.0.0.1:${proxy.port}`;

  plainDir = mkdtempSync(join(tmpdir(), "agx-serve-plain-"));
  const plainPort = await freePort();
  plain = `http://127.0.0.1:${plainPort}`;
  plainProc = await spawnServer(plainDir, plainPort, false);
});

afterAll(() => {
  proxy?.stop(true);
  proc?.kill();
  plainProc?.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

const post = (at: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(at + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const event = (app: string) => ({
  source_app: app,
  session_id: `${app}-session`,
  hook_event_type: "PreToolUse",
  payload: {},
});

// --- the hole ---------------------------------------------------------------

test("through the proxy with no token, /ingest is refused", async () => {
  // This is the whole blocker in one line. It used to answer 400 — the schema
  // complaining, from inside the handler, having already been let in.
  const r = await post(via, "/ingest", event("through-the-proxy"));
  expect(r.status).toBe(401);
});

test("through the proxy with no token, the OTel sinks are refused too", async () => {
  for (const p of ["/v1/traces", "/otlp/v1/traces", "/v1/logs", "/otlp/v1/logs"]) {
    const r = await post(via, p, { resourceSpans: [] });
    expect(r.status, p).toBe(401);
  }
});

test("through the proxy with no token, /sessions is refused", async () => {
  // The control that was already correct, kept so a passing suite means the
  // gate is working rather than the server being down.
  const r = await post(via, "/sessions", {});
  expect(r.status).toBe(401);
});

test("a client cannot smuggle loopback past the proxy", async () => {
  // Two shapes at once. `x-forwarded-for` is what tailscaled overwrites, so
  // the client's value never survives; `x-real-ip` is one it passes through
  // untouched, so the client's value DOES arrive — and must be ignored, which
  // is why the server never reads it.
  const r = await post(via, "/ingest", event("smuggler"), {
    "x-forwarded-for": "127.0.0.1",
    "x-real-ip": "127.0.0.1",
    "tailscale-headers": "127.0.0.1",
  });
  expect(r.status).toBe(401);
});

test("a local process cannot become someone else by forging the proxy's headers", async () => {
  // Against the server with NO seam, so this is the real check: the uid that
  // owns the connecting socket. Measured on the machine this was written for —
  // through a genuine `tailscale serve` the socket is uid 0, and the identical
  // headers sent straight at the port came off uid 1000. A process cannot
  // choose the uid the kernel records against its own socket.
  //
  // The forger is therefore still just a loopback process: it keeps loopback's
  // tokenless intake (no privilege gained, none lost) and it does not get to
  // wear another address.
  if (!canProveForgery) return;
  const r = await post(plain, "/ingest", event("liar"), {
    "x-forwarded-for": "203.0.113.9",
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    "tailscale-user-login": "attacker@evil.example",
    "x-real-ip": "203.0.113.9",
  });
  expect(r.status).toBe(200);
  const rows = await devices(plain);
  expect(rows.some((d) => d.address === "203.0.113.9"), "a forged address reached the device list").toBe(false);
});

// --- what must keep working -------------------------------------------------

test("straight from loopback with no token, /ingest still succeeds", async () => {
  // His hooks. They cannot carry a secret, which is the entire reason the
  // exemption exists; breaking this breaks every user's dashboard.
  const r = await post(base, "/ingest", event("a-local-hook"));
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true });
});

test("an off-box sender that carries the token still gets in", async () => {
  const r = await post(via, "/ingest", event("off-box"), { authorization: `Bearer ${TOKEN}` });
  expect(r.status).toBe(200);
});

// --- the device list, and Block --------------------------------------------

interface Row { address: string; live: number; blocked: boolean; self?: boolean }

async function devices(at: string = base): Promise<Row[]> {
  const r = await fetch(at + "/remote/status", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { devices: Row[] }).devices;
}

test("a device connecting through the proxy appears in the device list", async () => {
  // It never did. noteClient drops loopback deliberately — "loopback is the
  // desk itself" — and every phone behind serve arrived as loopback, so the
  // panel showed nothing and there was no row to press Block on.
  await post(via, "/ingest", event("phone"), { authorization: `Bearer ${TOKEN}` });
  const row = (await devices()).find((d) => d.address === PHONE);
  expect(row, `${PHONE} is not in the device list`).toBeDefined();
  expect(row!.self, "a tailnet phone was mistaken for this machine").toBeFalsy();
});

test("Block actually blocks a device that arrives through the proxy", async () => {
  const r = await post(base, "/remote/device", { address: PHONE, blocked: true }, {
    authorization: `Bearer ${TOKEN}`,
  });
  expect(r.status).toBe(200);

  // Refused before the token is even considered — the point of an address
  // block is that it lands on the next packet, and the device already holds a
  // credential, which is exactly why it needs stopping by address.
  const after = await post(via, "/ingest", event("phone-again"), { authorization: `Bearer ${TOKEN}` });
  expect(after.status).toBe(403);

  // And the desk is untouched by it.
  expect((await post(base, "/ingest", event("desk-after-block"))).status).toBe(200);

  // A different device on the same tailnet is untouched too: this blocked an
  // address, not "everything behind the proxy".
  const other = await post(via, "/ingest", event("other-phone"), {
    authorization: `Bearer ${TOKEN}`,
    "x-test-speaking-for": "100.101.102.104",
  });
  expect(other.status).toBe(200);

  // Put it back, so the row can be unblocked as well as blocked.
  expect((await post(base, "/remote/device", { address: PHONE, blocked: false }, {
    authorization: `Bearer ${TOKEN}`,
  })).status).toBe(200);
  expect((await post(via, "/ingest", event("phone-restored"), {
    authorization: `Bearer ${TOKEN}`,
  })).status).toBe(200);
});

test("only the desk may disconnect a device, even over the proxy", async () => {
  // Before the fix a phone behind serve looked like loopback here, so it could
  // have cut off the laptop next to it.
  const r = await post(via, "/remote/device", { address: "100.101.102.104", blocked: true }, {
    authorization: `Bearer ${TOKEN}`,
  });
  expect(r.status).toBe(403);
});

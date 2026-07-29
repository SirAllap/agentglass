/*
 * The whole point, end to end: an event arrives, and a phone hears about it.
 *
 * `deliver()` already reached a webhook, a connected desktop client and
 * notify-send. None of them reaches a device with its screen off, and the
 * phone's socket closes with the screen on purpose — so the case the companion
 * exists for was the one case nothing covered.
 *
 * Run against a real server in its own process, with a real HTTP server
 * standing in for the push service. Nothing is stubbed inside the server: the
 * event goes in through `/ingest`, and the assertion is on what arrives at the
 * far end. The only thing this cannot prove is that FCM would have relayed it,
 * which is not this repository's code.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64uEncode, b64uDecode } from "../src/push.ts";

const AUTH = b64uEncode(new Uint8Array(16).fill(0x11));

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
let svc: { seen: { headers: Record<string, string>; body: Uint8Array }[]; url: string; stop: () => void; status: number };

/**
 * A subscription this test holds the private half of, so it can read what the
 * server sent — which is the only way to check the *contents* rather than just
 * that something ciphertext-shaped went out.
 */
let device: { p256dh: string; publicRaw: Uint8Array; privateKey: CryptoKey };

async function makeDevice() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { p256dh: b64uEncode(publicRaw), publicRaw, privateKey: pair.privateKey };
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8,
  ));
}

/**
 * The browser's side of RFC 8291, near enough: unwrap the aes128gcm record and
 * hand back what the service worker's `event.data` would say.
 *
 * That the encryption itself is correct is settled elsewhere — push-encrypt.
 * test.ts pins it byte-for-byte against `http_ece`, the library `web-push`
 * uses. This exists to read the plaintext back out, because the thing worth
 * asserting here is what the service worker will find inside: a notification
 * needs a title and a body, and an alert that arrives carrying neither is a
 * push that buzzes a phone with nothing to show.
 */
async function decrypt(body: Uint8Array, auth: string): Promise<string> {
  const salt = body.slice(0, 16);
  const idLen = body[20]!;
  const senderPublicRaw = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const senderPublic = await crypto.subtle.importKey(
    "raw", senderPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: senderPublic }, device.privateKey, 256,
  ));
  const enc = new TextEncoder();
  const authInfo = new Uint8Array([
    ...enc.encode("WebPush: info"), 0, ...device.publicRaw, ...senderPublicRaw,
  ]);
  const ikm = await hkdf(shared, b64uDecode(auth), authInfo, 32);
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext,
  ));
  // The trailing byte is RFC 8188's padding delimiter, not content.
  return new TextDecoder().decode(padded.slice(0, -1));
}

/** A push service that records, and can be told to answer differently. */
function fakeService() {
  const seen: { headers: Record<string, string>; body: Uint8Array }[] = [];
  const state = { status: 201 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      seen.push({ headers, body: new Uint8Array(await req.arrayBuffer()) });
      return new Response("", { status: state.status });
    },
  });
  return {
    seen, url: `http://127.0.0.1:${server.port}/push/device`,
    stop: () => server.stop(true),
    get status() { return state.status; },
    set status(v: number) { state.status = v; },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-alert-"));
  device = await makeDevice();
  svc = fakeService();
  const port = 4700 + Math.floor(Math.random() * 250);
  base = `http://127.0.0.1:${port}`;
  // A named environment, not `...process.env` — see push-routes.test.ts. And
  // NOT NODE_ENV=test: the whole point is to exercise the real delivery path,
  // which a test run deliberately switches off so a suite can never put an
  // approval prompt on somebody's desktop or post to their Slack.
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  await fetch(base + "/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: { endpoint: svc.url, keys: { p256dh: device.p256dh, auth: AUTH } },
      label: "Pixel",
    }),
  });
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { svc?.stop(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** An event of the kind that stops an agent dead. */
const permissionRequest = (session: string) => ({
  source_app: "claude-code",
  session_id: session,
  hook_event_type: "PermissionRequest",
  // Inside the payload, which is where a hook actually puts it — `normalize()`
  // reads `payload.tool_name` and ignores a top-level one. Put it at the top
  // level and the alert still fires, just without saying which tool, so the
  // wrong shape here would have quietly weakened the assertion below rather
  // than failed.
  payload: { tool_name: "Bash", message: "wants to run rm -rf build" },
});

async function ingest(event: unknown) {
  const res = await fetch(base + "/ingest", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  return res;
}

/** Delivery is fire-and-forget on purpose, so wait for it rather than assume. */
async function waitForPush(atLeast: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (svc.seen.length >= atLeast) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("an agent stops, and the phone hears", () => {
  it("pushes when something is waiting on a human", async () => {
    expect((await ingest(permissionRequest("s-alert-1"))).ok).toBe(true);
    expect(await waitForPush(1)).toBe(true);

    const got = svc.seen[0]!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers["authorization"]).toMatch(/^vapid t=/);
    // A held gate is worth waking a locked phone for.
    expect(got.headers["urgency"]).toBe("high");
    expect(Number(got.headers["ttl"])).toBeGreaterThan(0);
  });

  it("sends the notification encrypted, not as text on the wire", async () => {
    // The push service is a relay and is not trusted with the contents: it
    // learns that this machine sent something to this device, and nothing else.
    const body = new TextDecoder().decode(svc.seen[0]!.body);
    expect(body).not.toContain("rm -rf build");
    expect(body).not.toContain("Approval");
    expect(svc.seen[0]!.body.length).toBeGreaterThan(86);
  });

  it("carries a notification the service worker can actually show", async () => {
    // Encrypted is not the same as useful. The service worker reads
    // `event.data.json()` and needs a title and a body to build a notification
    // from; anything else buzzes a phone with nothing on it, and — because the
    // wire is ciphertext either way — every check above would still pass.
    const text = await decrypt(svc.seen[0]!.body, AUTH);
    const msg = JSON.parse(text) as { title?: string; body?: string; at?: number; urgency?: number };
    expect(typeof msg.title).toBe("string");
    expect(typeof msg.body).toBe("string");
    expect(msg.title).toContain("Approval needed");
    // And it says which agent, so a phone on a lock screen is enough to decide.
    expect(msg.body).toContain("claude-code:");
    expect(msg.body).toContain("Bash");
    // A timestamp, so the worker can tell a fresh alert from one the service
    // held while the phone was offline — TTL is 12h, so this is not theoretical.
    expect(msg.at).toBeGreaterThan(0);
    // And the urgency inside the payload, not only in the header. The header
    // is for the push service, which decides whether to wake the radio; this
    // is for the service worker, which decides whether the notification stays
    // on screen until it is dealt with. Only one of the two can read the body.
    expect(msg.urgency).toBe(2);
  });

  it("records that the device actually received it", async () => {
    const { devices } = await (await fetch(base + "/push/devices")).json() as {
      devices: { label: string; lastOkAt: number | null }[];
    };
    const pixel = devices.find((d) => d.label === "Pixel");
    expect(pixel?.lastOkAt).toBeGreaterThan(0);
  });
});

describe("a device that has gone away", () => {
  it("is forgotten when the push service says it is gone, and only then", async () => {
    // 429 is the service being busy. Pruning on it would silently unsubscribe a
    // working phone, and nobody would find out until a gate went unanswered.
    svc.status = 429;
    const before = svc.seen.length;
    await ingest(permissionRequest("s-alert-busy"));
    expect(await waitForPush(before + 1)).toBe(true);
    let devices = (await (await fetch(base + "/push/devices")).json() as { devices: unknown[] }).devices;
    expect(devices).toHaveLength(1);

    // 410 is the service saying that subscription no longer exists.
    svc.status = 410;
    const before2 = svc.seen.length;
    await ingest(permissionRequest("s-alert-gone"));
    expect(await waitForPush(before2 + 1)).toBe(true);
    // The prune happens after the response, so give it a moment to land.
    for (let i = 0; i < 50; i++) {
      devices = (await (await fetch(base + "/push/devices")).json() as { devices: unknown[] }).devices;
      if (!devices.length) break;
      await Bun.sleep(50);
    }
    expect(devices).toHaveLength(0);
  });

  it("stops sending once there is nobody to send to", async () => {
    const before = svc.seen.length;
    await ingest(permissionRequest("s-alert-after"));
    await Bun.sleep(600);
    expect(svc.seen.length).toBe(before);
  });
});

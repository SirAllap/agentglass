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
    stdout: "ignore", stderr: "pipe",
  });
  // Say so when it does not come up. This used to break out of the loop and
  // carry on, so a server that had died at boot showed as nine assertion
  // failures about connection refused and nothing about the actual cause.
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) { up = true; break; } } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!up) {
    const err = await new Response(proc.stderr as ReadableStream).text();
    throw new Error("the server did not come up: " + err.slice(0, 600));
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

/**
 * Delivery is fire-and-forget on purpose, so wait for it rather than assume.
 *
 * Under bun's own 5s test timeout, deliberately. Matching it meant a push that
 * never arrived killed the whole run rather than failing one test — and every
 * test after it then reported a connection refused to a server the runner had
 * already torn down, which says nothing about the one thing that was wrong.
 */
async function waitForPush(atLeast: number, ms = 3000): Promise<boolean> {
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

/** An event of the kind that happens all day and stops nothing. */
const toolError = (session: string) => ({
  source_app: "claude-code",
  session_id: session,
  hook_event_type: "PostToolUse",
  payload: {
    tool_name: "Bash",
    // A shape `detectError` actually recognises. The first version of this
    // fixture paired a stderr string with `interrupted: false`, which is not a
    // failure by any of its rules — so no alert fired, no push arrived, and the
    // test sat waiting for one that was never coming.
    tool_response: { stdout: "", stderr: "grep: fixtures: No such file or directory", returnCodeInterpretation: "error" },
  },
});

describe("what is worth waking a pocket for", () => {
  it("does not wake the phone for a tool that merely failed", async () => {
    // A failed tool call is *critical* on the desktop and has been on purpose
    // since long before push existed: you are at the machine, and a
    // notification that does not time out is right there. Reusing that same
    // number to decide whether to wake a radio and pin a lock-screen
    // notification meant a failed grep on one of eight agents lit up a phone
    // in a pocket with something that would not go away. That is how somebody
    // learns to swipe the whole app away, and then the gate goes unanswered
    // too.
    const before = svc.seen.length;
    expect((await ingest(toolError("s-err-1"))).ok).toBe(true);
    expect(await waitForPush(before + 1)).toBe(true);

    const got = svc.seen[before]!;
    expect(got.headers["urgency"]).toBe("normal");
    const msg = JSON.parse(await decrypt(got.body, AUTH)) as { title?: string; urgency?: number };
    expect(msg.title).toContain("error");
    // Not 2: the worker reads this to decide whether the notification waits
    // for you, and this one has no reason to.
    expect(msg.urgency).toBe(1);
  });

  it("wakes it for a tool call held at the gate, which is the whole point", async () => {
    // The control-plane hold: the agent is not merely waiting, it is stopped
    // at a `PreToolUse` until a person answers, and the hook's own request is
    // open the entire time. If any alert deserves a locked screen lighting up
    // and staying lit, it is this one — and nothing covered it, which a
    // mutation dropping its wake proved by walking straight through.
    const before = svc.seen.length;
    // Not awaited: /gate holds the connection open until it is decided or
    // times out, which is exactly what the hook does.
    const held = fetch(base + "/gate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_app: "claude-code", session_id: "s-gate-1",
        tool_name: "Bash", tool_input: { command: "rm -rf build" }, timeout_ms: 2000,
      }),
    }).catch(() => null);

    expect(await waitForPush(before + 1)).toBe(true);
    expect(svc.seen[before]!.headers["urgency"]).toBe("high");
    const msg = JSON.parse(await decrypt(svc.seen[before]!.body, AUTH)) as { title?: string; body?: string; urgency?: number };
    expect(msg.urgency).toBe(2);
    expect(msg.title).toContain("Approval needed");
    // And it says what is being asked for, which is what makes it answerable
    // from a lock screen.
    expect(msg.body).toContain("rm -rf build");
    await held;
  });

  it("still wakes it for something an agent is stopped on", async () => {
    // The contrast is the point. Both arrive; only one is worth a locked
    // screen lighting up and staying lit.
    const before = svc.seen.length;
    await ingest(permissionRequest("s-wake-again"));
    expect(await waitForPush(before + 1)).toBe(true);
    expect(svc.seen[before]!.headers["urgency"]).toBe("high");
    const msg = JSON.parse(await decrypt(svc.seen[before]!.body, AUTH)) as { urgency?: number };
    expect(msg.urgency).toBe(2);
  });
});

describe("proving it works, without waiting for an agent to block", () => {
  // Before this existed the only way to find out whether push worked was to
  // walk away and see whether anything arrived — so a silent failure looked
  // exactly like a quiet afternoon, and you learned by missing the one thing
  // the feature is for.

  it("sends a real push down the real path", async () => {
    const before = svc.seen.length;
    const r = await (await fetch(base + "/push/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { ok: boolean; sent: number; failed: number; pruned: number };
    expect(r).toMatchObject({ ok: true, sent: 1, failed: 0, pruned: 0 });
    expect(await waitForPush(before + 1)).toBe(true);

    // The same route an alert takes, not a special case: same encryption, same
    // headers. A test that went a different way could pass while the real one
    // was broken, which would be worse than having no test button.
    const got = svc.seen[before]!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers["authorization"]).toMatch(/^vapid t=/);
    const msg = JSON.parse(await decrypt(got.body, AUTH)) as { title?: string; body?: string; urgency?: number };
    expect(msg.title).toBeTruthy();
    expect(msg.body).toBeTruthy();
    // Not urgency 2: a test must not be the thing that teaches somebody to
    // swipe these away, and one that will not dismiss itself is a poor
    // introduction.
    expect(msg.urgency).not.toBe(2);
  });

  it("says nothing was sent rather than claiming success", async () => {
    // A green tick for a push that reached nobody is the one answer that would
    // make this button worse than useless.
    svc.status = 500;
    const r = await (await fetch(base + "/push/test", { method: "POST", body: "{}" })).json() as
      { ok: boolean; sent: number; failed: number };
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
    svc.status = 201;
  });

  it("tells a device it is no longer registered, rather than merely failing", async () => {
    // The phone branches on this to say "turn it on again", which is the only
    // useful thing to say — the subscription is gone at both ends and no
    // amount of retrying will bring it back. Reported as a plain failure it
    // would read as "the network is having a moment", and somebody would wait.
    svc.status = 410;
    const r = await (await fetch(base + "/push/test", { method: "POST", body: "{}" })).json() as
      { ok: boolean; sent: number; failed: number; pruned: number };
    expect(r).toMatchObject({ ok: false, sent: 0, failed: 0, pruned: 1 });
    expect((await (await fetch(base + "/push/devices")).json() as { devices: unknown[] }).devices).toHaveLength(0);

    // Put it back: the rest of this file is about a device that exists.
    svc.status = 201;
    await fetch(base + "/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: { endpoint: svc.url, keys: { p256dh: device.p256dh, auth: AUTH } },
        label: "Pixel",
      }),
    });
  });

  it("is refused from another origin, like every other write", async () => {
    const res = await fetch(base + "/push/test", {
      method: "POST", headers: { origin: "https://evil.example" }, body: "{}",
    });
    expect(res.ok).toBe(false);
  });

  it("does not send one over GET", async () => {
    const before = svc.seen.length;
    await fetch(base + "/push/test");
    await Bun.sleep(400);
    expect(svc.seen.length).toBe(before);
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

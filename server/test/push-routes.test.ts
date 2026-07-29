/*
 * The four routes a phone needs to start receiving.
 *
 * Driven against a real server on a real port, because what matters here is
 * partly about the HTTP itself: which methods are refused, what a
 * cross-origin POST gets, and — the one worth being careful about — what the
 * device list is allowed to say back.
 *
 * An endpoint is a capability. Anyone holding one can ask a push service to
 * wake that phone, forever, without any further credential. So `/push/devices`
 * answers "how many, and what are they called" and never the endpoint or the
 * keys, and that is asserted rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64uEncode } from "../src/push.ts";

const P256DH = "BAyQHUI8gxyoXifHPCY7oTJyG7nXqExPA4CypnVv1gEzHIhwI03sh4UEwXQUT6SxS2amUWkWBtgXPlW9N-OBVp4";
const AUTH = b64uEncode(new Uint8Array(16).fill(0x11));
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

/**
 * A real server in its own process.
 *
 * Not an in-process import: `bun test` shares one process across files, and
 * importing index.ts would start the real pollers, the real watchers and a
 * listening socket that outlive this file and leak into every suite after it.
 * That is the same shape of bug as a leaked AGENTGLASS_ROOT, and it is much
 * harder to see. A subprocess is also what actually runs in production.
 */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-routes-"));
  const port = 4200 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, not `...process.env`.
    //
    // `bun test` shares one process across files, so the parent's environment
    // is whatever every suite before this one happened to leave on it. Spreading
    // it inherited an AGENTGLASS_TOKEN set by auth-token.test.ts, and every
    // request here came back "unauthorized" — but only in a full run, and only
    // depending on file order. Naming what the child needs makes this test say
    // the same thing however it is invoked.
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
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  const err = await new Response(proc.stderr as ReadableStream).text();
  throw new Error("the server did not come up: " + err.slice(0, 400));
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;

const post = (path: string, body: unknown, origin?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

const postJson = async (path: string, body: unknown, origin?: string): Promise<Json> =>
  (await post(path, body, origin)).json() as Promise<Json>;
const getJson = async (path: string): Promise<Json> =>
  (await fetch(base + path)).json() as Promise<Json>;

describe("getting a key", () => {
  it("hands over the public key, which is the whole point of it", async () => {
    const r = await getJson("/push/key");
    const raw = Buffer.from(String(r.key).replace(/-/g, "+").replace(/_/g, "/"), "base64");
    // Uncompressed P-256. A browser rejects anything else outright, so the
    // shape is the contract.
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
  });

  it("hands over the same key every time", async () => {
    // If this ever changed, every phone already subscribed would go silent and
    // nothing would say so.
    const a = await getJson("/push/key");
    const b = await getJson("/push/key");
    expect(b.key).toBe(a.key);
  });
});

describe("subscribing", () => {
  it("takes a subscription and counts the device", async () => {
    const r = await postJson("/push/subscribe", { subscription: sub("https://push/one"), label: "Pixel" });
    expect(r).toEqual({ ok: true, devices: 1 });
  });

  it("counts one device however many times it subscribes", async () => {
    await post("/push/subscribe", { subscription: sub("https://push/one"), label: "Pixel" });
    const r = await postJson("/push/subscribe", { subscription: sub("https://push/one"), label: "Pixel" });
    expect(r.devices).toBe(1);
  });

  it("refuses one that is missing a key, with a reason", async () => {
    // Storing a half-written subscription would fail to encrypt on every alert
    // afterwards, and look exactly like a phone that is not receiving.
    for (const bad of [
      { subscription: { endpoint: "https://push/x", keys: { p256dh: P256DH } } },
      { subscription: { endpoint: "https://push/x", keys: { auth: AUTH } } },
      { subscription: { keys: { p256dh: P256DH, auth: AUTH } } },
      { subscription: null },
      {},
    ]) {
      const r = await postJson("/push/subscribe", bad);
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/endpoint|keys/);
    }
  });

  it("survives a body that is not JSON at all", async () => {
    const res = await fetch(base + "/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{{{",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).ok).toBe(false);
  });

  it("keeps a label short enough to be a label", async () => {
    await post("/push/subscribe", { subscription: sub("https://push/long"), label: "L".repeat(500) });
    const { devices } = await getJson("/push/devices");
    const found = devices.find((d: { label: string }) => d.label.startsWith("L"));
    expect(found.label.length).toBeLessThanOrEqual(60);
  });
});

describe("what the device list is allowed to say", () => {
  it("never returns an endpoint or a key", async () => {
    // An endpoint is a capability: anyone holding one can ask the push service
    // to wake that phone, forever, with no further credential. This response
    // goes to whatever is asking, so it may only ever be a count and a name.
    await post("/push/subscribe", { subscription: sub("https://push/secret-endpoint"), label: "Pixel" });
    const res = await fetch(base + "/push/devices");
    const text = await res.text();
    expect(text).not.toContain("secret-endpoint");
    expect(text).not.toContain(P256DH);
    expect(text).not.toContain(AUTH);
    const { devices } = JSON.parse(text);
    expect(devices.some((d: { label: string }) => d.label === "Pixel")).toBe(true);
    for (const d of devices) expect(Object.keys(d).sort()).toEqual(["addedAt", "label", "lastOkAt"]);
  });
});

describe("unsubscribing", () => {
  it("forgets the device", async () => {
    await post("/push/subscribe", { subscription: sub("https://push/bye") });
    const before = (await getJson("/push/devices")).devices.length;
    const r = await postJson("/push/unsubscribe", { endpoint: "https://push/bye" });
    expect(r.ok).toBe(true);
    expect(r.devices).toBe(before - 1);
  });

  it("is not an error to forget something twice", async () => {
    // The phone calls this on a subscription the browser has already dropped,
    // which is exactly the case where it no longer exists here either.
    const r = await postJson("/push/unsubscribe", { endpoint: "https://push/never-existed" });
    expect(r.ok).toBe(true);
  });
});

describe("who may write", () => {
  it("refuses a cross-origin POST", async () => {
    // The protection is the gate at the top of the request handler, which
    // covers the whole surface; these routes carry no check of their own,
    // because one there could never fire. This pins that they are in fact
    // behind it — a refactor that moved a route above the gate would let any
    // site the user visited register its own phone against this machine.
    for (const path of ["/push/subscribe", "/push/unsubscribe"]) {
      const res = await post(path, { subscription: sub("https://push/evil") }, "https://evil.example");
      expect(res.ok).toBe(false);
    }
    const { devices } = await getJson("/push/devices");
    expect(devices.length).toBeGreaterThan(0); // still there, none added
  });

  it("does not take a subscription over GET", async () => {
    const res = await fetch(base + "/push/subscribe");
    expect(res.status).toBe(404);
  });
});

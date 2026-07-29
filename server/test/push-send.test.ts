/*
 * Sending, and remembering who to send to.
 *
 * The encryption is checked against another implementation in
 * push-encrypt.test.ts. This is the rest of what has to be right before a
 * phone can buzz: the headers a push service demands, which of its answers
 * mean "forget this device", and a store that survives a restart.
 *
 * The push service here is a real HTTP server on localhost that records what
 * arrives. That proves everything except whether FCM accepts it — which is not
 * this repository's code, and is the one thing a container cannot answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendPush, b64uEncode, type PushSubscription } from "../src/push.ts";
import {
  pushPath, vapidKeys, forgetVapid, subscriptions,
  addSubscription, removeSubscription, markDelivered,
} from "../src/pushstore.ts";

const sub: PushSubscription = {
  endpoint: "",
  keys: {
    p256dh: "BAyQHUI8gxyoXifHPCY7oTJyG7nXqExPA4CypnVv1gEzHIhwI03sh4UEwXQUT6SxS2amUWkWBtgXPlW9N-OBVp4",
    auth: b64uEncode(new Uint8Array(16).fill(0x11)),
  },
};

const vapid = {
  publicKey: "BFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q",
  privateKey: b64uEncode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
};

/** A push service, near enough: it records the request and answers how it is told. */
function fakeService(status = 201) {
  const seen: { headers: Record<string, string>; body: Uint8Array }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      seen.push({ headers, body: new Uint8Array(await req.arrayBuffer()) });
      return new Response("", { status });
    },
  });
  return { seen, url: `http://127.0.0.1:${server.port}/push/abc`, stop: () => server.stop(true) };
}

describe("what actually goes over the wire", () => {
  it("carries the headers a push service refuses to work without", async () => {
    const svc = fakeService();
    try {
      const r = await sendPush({ ...sub, endpoint: svc.url }, new TextEncoder().encode("hi"), vapid);
      expect(r.ok).toBe(true);
      const [got] = svc.seen;
      expect(got).toBeDefined();
      // Without either of these the service answers 400 and says nothing useful.
      expect(got!.headers["content-encoding"]).toBe("aes128gcm");
      expect(got!.headers["content-type"]).toBe("application/octet-stream");
      // The token, and the key that pins the subscription to this server.
      expect(got!.headers["authorization"]).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      expect(got!.headers["authorization"]).toContain(vapid.publicKey);
    } finally { svc.stop(); }
  });

  it("asks the service to hold it for a phone that is asleep", async () => {
    // TTL 0 means "deliver now or drop it", which is exactly wrong for the case
    // this whole feature exists for: a locked phone in a pocket.
    const svc = fakeService();
    try {
      await sendPush({ ...sub, endpoint: svc.url }, new TextEncoder().encode("hi"), vapid);
      expect(Number(svc.seen[0]!.headers["ttl"])).toBeGreaterThan(0);
      expect(svc.seen[0]!.headers["urgency"]).toBe("high");
      await sendPush({ ...sub, endpoint: svc.url }, new TextEncoder().encode("hi"), vapid,
        { ttlSeconds: 60, urgency: "low" });
      expect(svc.seen[1]!.headers["ttl"]).toBe("60");
      expect(svc.seen[1]!.headers["urgency"]).toBe("low");
    } finally { svc.stop(); }
  });

  it("sends the encrypted body and never the plaintext", async () => {
    const svc = fakeService();
    try {
      const secret = "rm -rf /very/secret/path";
      await sendPush({ ...sub, endpoint: svc.url }, new TextEncoder().encode(secret), vapid);
      const body = svc.seen[0]!.body;
      expect(new TextDecoder().decode(body)).not.toContain(secret);
      // Header (86) + the message + its delimiter + a 16-byte tag.
      expect(body.length).toBe(86 + secret.length + 1 + 16);
    } finally { svc.stop(); }
  });
});

describe("which answers mean forget this phone", () => {
  it("treats 404 and 410 as gone, and nothing else", async () => {
    // A 429 or a 503 is the service being busy. Dropping a subscription over
    // one would silently unsubscribe a phone that was working perfectly, and
    // nobody would find out until the next gate went unanswered.
    for (const [status, gone] of [[404, true], [410, true], [429, false], [500, false], [503, false]] as const) {
      const svc = fakeService(status);
      try {
        const r = await sendPush({ ...sub, endpoint: svc.url }, new TextEncoder().encode("x"), vapid);
        expect(r.status).toBe(status);
        expect(r.gone).toBe(gone);
        expect(r.ok).toBe(false);
      } finally { svc.stop(); }
    }
  });

  it("does not throw when nothing answers at all", async () => {
    // The caller is an alert path. A push service that is unreachable must not
    // take down the notification that was also going to the desktop.
    const r = await sendPush(
      { ...sub, endpoint: "http://127.0.0.1:1/nowhere" }, new TextEncoder().encode("x"), vapid,
    );
    expect(r.ok).toBe(false);
    // Status 0, not a made-up number: nothing came back, and a caller must not
    // be able to reason about a response that does not exist.
    expect(r.status).toBe(0);
    expect(r.gone).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("the store", () => {
  let dir: string | null = null;
  const scratch = () => {
    dir = mkdtempSync(join(tmpdir(), "agx-push-"));
    process.env.XDG_CONFIG_HOME = dir;
    forgetVapid();
    return dir;
  };
  afterEach(() => {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } dir = null; }
    delete process.env.XDG_CONFIG_HOME;
    forgetVapid();
  });

  it("keeps one entry per device, however many times it subscribes", async () => {
    // A browser hands back the same endpoint for the same subscription. Without
    // this, one phone becomes four rows and gets four buzzes for one gate.
    scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" }, "Pixel");
    addSubscription({ ...sub, endpoint: "https://push/one" }, "Pixel");
    addSubscription({ ...sub, endpoint: "https://push/two" });
    expect(subscriptions().map((s) => s.endpoint)).toEqual(["https://push/one", "https://push/two"]);
  });

  it("moves a device to the end when it re-subscribes", async () => {
    // Not cosmetic: re-adding removes and re-appends, and that is what makes
    // the dedupe above a replace rather than a silent no-op. The newest label
    // and keys are the ones that win.
    scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" }, "old name");
    addSubscription({ ...sub, endpoint: "https://push/two" });
    addSubscription({ ...sub, endpoint: "https://push/one" }, "new name");
    expect(subscriptions().map((s) => s.endpoint)).toEqual(["https://push/two", "https://push/one"]);
    expect(subscriptions().at(-1)!.label).toBe("new name");
  });

  it("keeps what it knows about a device that re-subscribes", async () => {
    // Re-subscribing is not rare: turning the switch on when the browser
    // already holds a subscription posts the same endpoint again, which is
    // what happens whenever this machine has lost its file and the phone has
    // not. Replacing the entry threw the history away, and the device list
    // then read "Added just now · never alerted" for a phone that had been
    // receiving for weeks — a list that resets itself cannot be used to decide
    // which device to forget.
    scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" }, "Pixel", 1_000);
    markDelivered("https://push/one", 2_000);
    addSubscription({ ...sub, endpoint: "https://push/one" }, undefined, 9_000);
    const [only] = subscriptions();
    expect(only!.addedAt).toBe(1_000);
    expect(only!.lastOkAt).toBe(2_000);
    // And the name, which the phone sends on subscribe and not on every call.
    expect(only!.label).toBe("Pixel");
  });

  it("takes the newest keys, because those are the ones that will encrypt", async () => {
    // The rest is carried forward; the keys are not. A browser that rotated
    // them and kept the endpoint would otherwise be encrypted to with the old
    // pair forever, and every push would be quietly undecryptable.
    scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" }, "Pixel");
    addSubscription({ endpoint: "https://push/one", keys: { p256dh: "NEWKEY", auth: "NEWAUTH" } });
    expect(subscriptions()[0]!.keys).toEqual({ p256dh: "NEWKEY", auth: "NEWAUTH" });
  });

  it("survives a restart, which is the whole point of a file", async () => {
    const d = scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" }, "Pixel");
    const onDisk = JSON.parse(readFileSync(join(d, "agentglass", "push.json"), "utf8"));
    expect(onDisk.subs[0].endpoint).toBe("https://push/one");
    expect(onDisk.subs[0].label).toBe("Pixel");
  });

  it("forgets one on request, and leaves the others", async () => {
    scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" });
    addSubscription({ ...sub, endpoint: "https://push/two" });
    expect(removeSubscription("https://push/one").map((s) => s.endpoint)).toEqual(["https://push/two"]);
    expect(subscriptions()).toHaveLength(1);
    // Removing something that was never there is not an error.
    expect(removeSubscription("https://push/nope")).toHaveLength(1);
  });

  it("refuses a subscription that is missing its keys", async () => {
    // A half-written one would be stored, fail to encrypt on every alert, and
    // look like a phone that is simply not receiving.
    scratch();
    addSubscription({ endpoint: "https://push/one", keys: { p256dh: "", auth: "" } });
    addSubscription({ endpoint: "", keys: sub.keys });
    expect(subscriptions()).toHaveLength(0);
  });

  it("reads a corrupt file as empty rather than failing to boot", async () => {
    // This is read on the alert path and on startup. A half-written file — a
    // machine that lost power mid-save — must cost a re-subscribe, which is one
    // tap, not a server that will not come up.
    const d = scratch();
    mkdirSync(join(d, "agentglass"), { recursive: true });
    writeFileSync(join(d, "agentglass", "push.json"), "{ this is not json");
    expect(subscriptions()).toEqual([]);
    // And it recovers: the next write replaces the garbage.
    addSubscription({ ...sub, endpoint: "https://push/one" });
    expect(subscriptions().map((s) => s.endpoint)).toEqual(["https://push/one"]);
  });

  it("reads valid json of the wrong shape as empty", async () => {
    const d = scratch();
    mkdirSync(join(d, "agentglass"), { recursive: true });
    writeFileSync(join(d, "agentglass", "push.json"), "[1,2,3]");
    expect(subscriptions()).toEqual([]);
  });

  it("records when a device last actually received something", async () => {
    scratch();
    addSubscription({ ...sub, endpoint: "https://push/one" });
    markDelivered("https://push/one", 1_700_000_000_000);
    expect(subscriptions()[0]!.lastOkAt).toBe(1_700_000_000_000);
  });
});

describe("the VAPID identity", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } dir = null; }
    delete process.env.XDG_CONFIG_HOME;
    forgetVapid();
  });

  it("is generated once and never again", async () => {
    // A browser pins a subscription to the key that created it. Regenerating
    // invalidates every subscription on every phone at once, and the failure is
    // silent — the service simply stops accepting the token.
    dir = mkdtempSync(join(tmpdir(), "agx-push-"));
    process.env.XDG_CONFIG_HOME = dir;
    forgetVapid();

    const first = await vapidKeys();
    forgetVapid();                        // as if the server restarted
    const second = await vapidKeys();
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });

  it("is generated once even when several callers ask at the same moment", async () => {
    // The phone asks for /push/key while the first alert may already be
    // fanning out, which is exactly the window this used to lose: the `await`
    // on key generation sat between the check and the memo assignment, so both
    // callers generated, both wrote, and the first one was handed a key that
    // was no longer the one on disk. A phone subscribing there is pinned to a
    // key this server will never sign with again — and the push service just
    // stops accepting the token, silently, forever.
    dir = mkdtempSync(join(tmpdir(), "agx-push-"));
    process.env.XDG_CONFIG_HOME = dir;
    forgetVapid();

    const many = await Promise.all(Array.from({ length: 8 }, () => vapidKeys()));
    const keys = new Set(many.map((k) => k.publicKey));
    expect(keys.size).toBe(1);

    // And the one everybody got is the one that was written down. Comparing
    // the callers to each other is not enough: they could all agree on a key
    // that a later write replaced on disk, which is the same failure.
    const onDisk = JSON.parse(readFileSync(join(dir, "agentglass", "push.json"), "utf8"));
    expect(onDisk.vapid.publicKey).toBe(many[0]!.publicKey);
    expect(onDisk.vapid.privateKey).toBe(many[0]!.privateKey);
  });

  it("is written where only this user can read it", async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-push-"));
    process.env.XDG_CONFIG_HOME = dir;
    forgetVapid();
    await vapidKeys();
    const p = join(dir, "agentglass", "push.json");
    expect(existsSync(p)).toBe(true);
    // It holds a signing key. 0600, not whatever the umask happened to be.
    expect(statSync(p).mode & 0o077).toBe(0);
  });

  it("stays out of the real config directory under test", async () => {
    // The same rule the settings file follows. A suite must never read the
    // developer's own subscriptions, and must never write over them.
    delete process.env.XDG_CONFIG_HOME;
    forgetVapid();
    expect(pushPath()).not.toContain(tmpdir());
    // Content, not existence. A machine that already has one — including one
    // left behind by a previous run of this very check with the guard disabled,
    // which is how I found this — would make an existence test pass for the
    // wrong reason forever after.
    const before = existsSync(pushPath()) ? readFileSync(pushPath(), "utf8") : null;
    await vapidKeys();
    const after = existsSync(pushPath()) ? readFileSync(pushPath(), "utf8") : null;
    expect(after).toBe(before);
  });
});

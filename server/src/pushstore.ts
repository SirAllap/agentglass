import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { generateVapidKeys, type PushSubscription, type VapidKeys } from "./push.ts";

/**
 * Where a device's push subscription lives, and the key this server signs with.
 *
 * Its own file rather than config.json, for two reasons. It holds a private
 * key, so it wants 0600 and a config people paste into issues does not. And a
 * subscription is machine state, not a setting — nobody edits one by hand, and
 * losing it should cost a re-subscribe rather than a lost preference.
 *
 * Not the events database either, which is retention-scoped: subscriptions
 * would silently evaporate after eight days and the only symptom would be a
 * phone that quietly stopped buzzing.
 */

export function pushPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agentglass",
    "push.json",
  );
}

/**
 * The same rule the settings file follows: under `bun test`, only the scratch
 * directory is readable or writable. A suite must never read the developer's
 * real subscriptions, and must never overwrite them with fixtures.
 */
const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

/** A subscription, plus what this machine knows about the device it came from. */
export interface StoredSubscription extends PushSubscription {
  /** Whatever the phone called itself. Free text, only ever shown back. */
  label?: string;
  addedAt: number;
  /** When a push to it last succeeded, so a dead one can be recognised. */
  lastOkAt?: number;
}

interface PushFile {
  vapid?: VapidKeys;
  subs?: StoredSubscription[];
}

function read(): PushFile {
  const p = pushPath();
  if (offLimits(p) || !existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as PushFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupt file must not take the server down on boot. The cost of being
    // wrong is a re-subscribe, which is one tap.
    return {};
  }
}

function write(f: PushFile): boolean {
  const p = pushPath();
  if (offLimits(p)) return false;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(f, null, 2) + "\n");
    // It contains a signing key. Best effort: some filesystems will not.
    try { chmodSync(p, 0o600); } catch { /* not every fs has modes */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * This server's VAPID identity, generated once and kept.
 *
 * It has to be stable: a browser pins a subscription to the key that created
 * it, so regenerating invalidates every subscription on every phone at once —
 * and the failure is silent, because the push service simply stops accepting
 * the token. Generating on every boot would look fine in every test and buzz
 * nobody.
 */
/**
 * The *promise* is memoized, not the result, and that is the whole point.
 *
 * Holding the result meant the `await` on key generation sat between the
 * check and the assignment, so two callers arriving together on a fresh
 * install both generated, both wrote, and the first one returned a key that
 * was no longer the one on disk. A phone subscribing in that window is pinned
 * to a key this server will never sign with again — and the failure is exactly
 * the silent one described above: the push service simply stops accepting the
 * token, and nothing anywhere says so.
 *
 * Not theoretical on first use: the phone asks for `/push/key` while the first
 * alert may already be fanning out.
 */
let memo: Promise<VapidKeys> | null = null;
export function vapidKeys(): Promise<VapidKeys> {
  if (!memo) {
    memo = (async () => {
      const f = read();
      if (f.vapid?.publicKey && f.vapid?.privateKey) return f.vapid;
      const fresh = await generateVapidKeys();
      write({ ...f, vapid: fresh });
      return fresh;
    })().catch((e) => {
      // A failure must not be cached, or one bad moment makes push dead for
      // the lifetime of the process.
      memo = null;
      throw e;
    });
  }
  return memo;
}

/** Only for tests, which run several servers in one process. */
export function forgetVapid(): void { memo = null; }

export function subscriptions(): StoredSubscription[] {
  return read().subs ?? [];
}

/**
 * A stable handle for a device, safe to hand to a client.
 *
 * Derived from the endpoint rather than stored, so there is nothing to migrate
 * onto existing files and it survives a restart on its own. And it is one-way:
 * it cannot be turned back into the endpoint, which is the whole reason
 * /push/devices can carry it. An endpoint is a capability — anyone holding one
 * can ask a push service to wake that phone, forever, with no further
 * credential — and this is only a name for one, usable against this server and
 * nowhere else.
 *
 * Sixteen hex characters of SHA-256. Long enough that a collision would take
 * billions of devices; short enough to read in a log.
 */
export function deviceId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

/** Forget a device by its handle. Same as removeSubscription, from the other
 *  end: the caller here never had the endpoint to begin with. */
export function removeDevice(id: string): StoredSubscription[] {
  const f = read();
  const subs = (f.subs ?? []).filter((s) => deviceId(s.endpoint) !== id);
  write({ ...f, subs });
  return subs;
}

/**
 * Remember a device, or update what is known about it.
 *
 * The endpoint is the identity. A browser hands back the same endpoint for the
 * same subscription, and a *new* one when the user clears site data or the push
 * service rotates it — so matching on endpoint is what stops one phone becoming
 * four entries and getting four buzzes for one gate.
 *
 * "Update what is known about it" was a claim this did not honour: a device
 * that re-subscribed was replaced rather than updated, so its history went with
 * it. Re-subscribing is not rare — turning the switch on when the browser
 * already holds a subscription posts the same endpoint again, which happens
 * whenever this machine has lost its file and the phone has not — and the row
 * afterwards read "Added just now · never alerted" for a phone that had been
 * receiving for weeks. A device list that resets itself is a device list nobody
 * can use to decide anything.
 *
 * So the keys are replaced, because those are what encryption needs and the
 * newest ones are the true ones; everything the machine learned about the
 * device is carried forward. A label only when a new one is offered — the
 * phone sends one on subscribe and not on every call.
 */
export function addSubscription(sub: PushSubscription, label?: string, now = Date.now()): StoredSubscription[] {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return subscriptions();
  const f = read();
  const prior = (f.subs ?? []).find((s) => s.endpoint === sub.endpoint);
  const subs = (f.subs ?? []).filter((s) => s.endpoint !== sub.endpoint);
  subs.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ...(label ?? prior?.label ? { label: label ?? prior!.label! } : {}),
    addedAt: prior?.addedAt ?? now,
    ...(prior?.lastOkAt ? { lastOkAt: prior.lastOkAt } : {}),
  });
  write({ ...f, subs });
  return subs;
}

export function removeSubscription(endpoint: string): StoredSubscription[] {
  const f = read();
  const subs = (f.subs ?? []).filter((s) => s.endpoint !== endpoint);
  write({ ...f, subs });
  return subs;
}

export function markDelivered(endpoint: string, now = Date.now()): void {
  const f = read();
  const subs = (f.subs ?? []).map((s) => (s.endpoint === endpoint ? { ...s, lastOkAt: now } : s));
  write({ ...f, subs });
}

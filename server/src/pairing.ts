import { randomBytes, randomInt, createHash, timingSafeEqual, createECDH, hkdfSync, createCipheriv } from "node:crypto";
import { issueDevice, type Scope, type Device } from "./devices.ts";

/**
 * Adding a phone, without ever putting the key on screen.
 *
 * The old flow was one step: the Remote pane drew a QR containing
 * `http://192.168.1.20:5959/?token=<the machine's token>`, the phone scanned
 * it, and that was pairing. Everything wrong with it follows from the same
 * fact — **the QR *was* the credential**:
 *
 *   * A photograph of the screen paired you. So did a screenshot in a chat, a
 *     shared window in a call, or standing behind the desk. There is no way to
 *     scan a code "carefully"; being able to see it is the whole authorisation.
 *   * The machine never learned that anything had happened. Nothing to accept,
 *     nothing to name, nothing to take back.
 *   * What was handed over was the *machine's* token — the same secret the
 *     desk uses — so the phone got a terminal, git write and docker control,
 *     and cutting it off meant rotating for everybody.
 *
 * So the QR carries a **ticket** now: a public handle that on its own is worth
 * nothing. Three things have to be true before a credential exists:
 *
 *   1. **the scanner can see the screen** — it must type a six-digit code that
 *      is only ever displayed at the machine, never transmitted in the QR;
 *   2. **a person at the machine agrees** — the claim shows up in the Remote
 *      pane naming the device and the address it came from, and waits;
 *   3. **the credential is delivered to that claimant and nobody else** — it is
 *      encrypted to a public key the phone generated for this one pairing, and
 *      collected exactly once.
 *
 * (3) is what keeps this honest on a network without TLS, which is the normal
 * case here: the server speaks plain HTTP over the LAN. Anything on that wifi
 * running tcpdump sees every byte of this exchange — the ticket, the code, the
 * public keys — and still cannot read the credential, because it never travels
 * in the clear and the key that unwraps it never leaves the phone.
 *
 * What this does **not** defend against is an active on-path attacker: someone
 * who can rewrite traffic can substitute their own public key, and no amount of
 * handshake fixes that without an authenticated channel. That is a TLS problem,
 * not a pairing problem, and the honest answer is the one the pane already
 * offers — pair over the Tailscale address, which is encrypted end to end.
 *
 * Everything here is in memory. A half-finished pairing that survives a restart
 * is a pairing nobody is watching, and the cost of losing one is scanning
 * again.
 */

/** Two minutes: long enough to walk to the desk, short enough to be worthless
 *  by the time anyone finds the screenshot. */
export const TICKET_TTL_MS = 120_000;

/** Wrong codes before the ticket is dead. Six digits with five guesses is a
 *  1-in-200,000 shot at a target that expires in two minutes; without a cap it
 *  is a million-request script and a certainty. */
export const MAX_ATTEMPTS = 5;

/** Concurrent pairings. More than a handful is not a person adding a phone. */
export const MAX_TICKETS = 4;

export type TicketState = "waiting" | "claimed" | "accepted" | "rejected";

export interface Ticket {
  /** Public handle, in the QR. Knowing it authorises nothing. */
  id: string;
  /** Shown at the machine only. Never in the QR, never in a listing that
   *  leaves this process except to the local pane. */
  code: string;
  createdAt: number;
  expiresAt: number;
  state: TicketState;
  attempts: number;
  /** What the phone called itself, once it has claimed. */
  label?: string;
  /** Its User-Agent and address, so the person accepting knows who is asking. */
  agent?: string;
  ip?: string;
  claimedAt?: number;
  /** SHA-256 of the secret handed back on a successful claim. Only the holder
   *  can collect, so a second party who watched the claim cannot race for the
   *  credential once it is minted. */
  claimHash?: string;
  /** The claimant's ECDH public key (P-256, uncompressed, base64url). */
  pub?: string;
  /** Set once accepted: the credential, encrypted to `pub`. */
  wrapped?: Wrapped;
  device?: Device;
}

/** A credential sealed to one claimant. See sealTo. */
export interface Wrapped {
  /** The server's ephemeral public key for this one delivery, base64url. */
  pub: string;
  iv: string;
  data: string;
}

/** What the local pane is allowed to see: the code, and who is asking. */
export interface PendingView {
  id: string;
  code: string;
  label: string;
  agent: string;
  ip: string;
  claimedAt: number;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");

function sweep(now: number): void {
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id);
}

/**
 * A six-digit code, from the CSPRNG rather than from `Math.random`.
 *
 * `randomInt` is rejection-sampled, so every code is equally likely — a modulo
 * of a random byte string is not, and the bias is exactly the thing an attacker
 * with five guesses would spend them on. Zero-padded: dropping a leading zero
 * would leave nine in ten codes six digits long and one in ten five, which
 * leaks a digit before anybody types anything.
 */
function sixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Start a pairing, at the machine.
 *
 * Null when too many are already in flight. Unclaimed tickets are recycled
 * first — those are QR codes nobody scanned — and a pairing that is *waiting
 * on a person* is never dropped to make room, because that person is looking
 * at it.
 */
export function mintTicket(now = Date.now()): Ticket | null {
  sweep(now);
  if (tickets.size >= MAX_TICKETS) {
    const oldestUnclaimed = [...tickets.values()]
      .filter((t) => t.state === "waiting")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldestUnclaimed) return null;
    tickets.delete(oldestUnclaimed.id);
  }
  const t: Ticket = {
    id: randomBytes(9).toString("base64url"),
    code: sixDigits(),
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
    state: "waiting",
    attempts: 0,
  };
  tickets.set(t.id, t);
  return t;
}

/** The live ticket, if it is still live. Expiry is checked on read as well as
 *  swept, so nothing can be used in the window between sweeps. */
export function getTicket(id: string, now = Date.now()): Ticket | null {
  const t = tickets.get(id);
  if (!t) return null;
  if (t.expiresAt <= now) { tickets.delete(id); return null; }
  return t;
}

/** Forget a ticket, whatever state it is in. */
export function dropTicket(id: string): void {
  tickets.delete(id);
}

export type ClaimResult =
  | { ok: true; secret: string }
  | { ok: false; error: "unknown" | "taken" | "code" | "locked" | "shape"; left?: number };

/**
 * The phone proves it can see the machine's screen.
 *
 * The code is compared in constant time and only ever against a ticket that is
 * still `waiting`: a claimed ticket is locked to whoever claimed it, so a
 * second scanner cannot displace the first by guessing faster.
 *
 * A wrong code costs an attempt whether or not the guess was close, and running
 * out kills the ticket outright rather than merely rejecting the guess — a
 * lockout that leaves the target alive is a rate limit, not a cap.
 */
export function claimTicket(
  id: string,
  code: string,
  opts: { label?: string; agent?: string; ip?: string; pub?: string; now?: number } = {},
): ClaimResult {
  const now = opts.now ?? Date.now();
  const t = getTicket(id, now);
  if (!t) return { ok: false, error: "unknown" };
  if (t.state !== "waiting") return { ok: false, error: "taken" };
  // Rejected before the compare: an unusable key means the credential could
  // not be delivered, and finding that out *after* someone at the desk has
  // accepted is a pairing that fails in the one place it cannot be retried.
  if (!validPub(opts.pub)) return { ok: false, error: "shape" };

  if (!codeMatches(t.code, code)) {
    t.attempts++;
    if (t.attempts >= MAX_ATTEMPTS) { tickets.delete(id); return { ok: false, error: "locked" }; }
    return { ok: false, error: "code", left: MAX_ATTEMPTS - t.attempts };
  }

  const secret = randomBytes(32).toString("base64url");
  t.state = "claimed";
  t.claimedAt = now;
  t.claimHash = createHash("sha256").update(secret).digest("hex");
  t.pub = opts.pub;
  t.label = (opts.label || "").trim().slice(0, 60) || "A device";
  t.agent = (opts.agent || "").slice(0, 300);
  t.ip = opts.ip || "";
  return { ok: true, secret };
}

/** Constant-time over a fixed length, so neither the code nor how much of a
 *  guess was right is readable from how long the answer took. */
function codeMatches(want: string, got: string): boolean {
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from((got || "").trim(), "utf8");
  if (a.length !== b.length) return false; // length is not a secret: it is six
  return timingSafeEqual(a, b);
}

/**
 * An uncompressed P-256 point, and nothing else.
 *
 * 65 bytes starting with 0x04. Anything else is either a mistake or an attempt
 * to feed the key agreement something it should not have; either way it stops
 * here rather than inside a cipher.
 */
export function validPub(pub: string | undefined): pub is string {
  if (!pub) return false;
  let raw: Buffer;
  try { raw = Buffer.from(pub, "base64url"); } catch { return false; }
  return raw.length === 65 && raw[0] === 0x04;
}

/** Claims waiting on a person, oldest first — the order they should be answered. */
export function pending(now = Date.now()): PendingView[] {
  sweep(now);
  return [...tickets.values()]
    .filter((t) => t.state === "claimed")
    .sort((a, b) => (a.claimedAt ?? 0) - (b.claimedAt ?? 0))
    .map((t) => ({
      id: t.id, code: t.code, label: t.label ?? "A device", agent: t.agent ?? "",
      ip: t.ip ?? "", claimedAt: t.claimedAt ?? 0, expiresAt: t.expiresAt,
    }));
}

export type DecideResult =
  | { ok: true; device: Device }
  | { ok: false; error: "unknown" | "notClaimed" };

/**
 * A person at the machine says yes.
 *
 * This is the only place a device credential is ever created, and the only
 * moment the raw token exists on this machine — it is sealed to the claimant
 * immediately and the plaintext is not kept, so nothing else in this process
 * (or in a heap dump of it) holds a working key afterwards.
 *
 * The default scope is deliberately not "everything": see devices.ts. A phone
 * that answers gates does not need the terminal, and the moment to decide that
 * is the moment somebody is already looking at the question.
 */
export function acceptTicket(id: string, scope: Scope = "answer", now = Date.now()): DecideResult {
  const t = getTicket(id, now);
  if (!t) return { ok: false, error: "unknown" };
  if (t.state !== "claimed" || !validPub(t.pub)) return { ok: false, error: "notClaimed" };
  const { device, token } = issueDevice(t.label ?? "A device", scope, now);
  t.wrapped = sealTo(t.pub, t.id, token);
  t.device = device;
  t.state = "accepted";
  return { ok: true, device };
}

/** A person at the machine says no. The ticket is kept, briefly, so the phone
 *  can be told it was refused instead of sitting on a spinner until it times
 *  out — "nothing happened" is the answer that makes people try again. */
export function rejectTicket(id: string, now = Date.now()): boolean {
  const t = getTicket(id, now);
  if (!t || t.state !== "claimed") return false;
  t.state = "rejected";
  return true;
}

export type CollectResult =
  | { state: "claimed" }
  | { state: "accepted"; wrapped: Wrapped; scope: Scope; label: string }
  | { state: "rejected" }
  | { state: "unknown" };

/**
 * The phone picks up what it was given, once.
 *
 * The secret from the claim is what authorises this, compared in constant time
 * against its hash — the ticket id is in the QR and therefore not a secret, so
 * without this anything that saw the QR could poll until a credential appeared
 * and take it before the phone did.
 *
 * A decided ticket is destroyed on collection rather than left to expire. One
 * delivery is all a pairing needs, and a credential that can be fetched twice
 * is a credential two devices can hold.
 */
export function collect(id: string, secret: string, now = Date.now()): CollectResult {
  const t = getTicket(id, now);
  if (!t || !t.claimHash) return { state: "unknown" };
  if (!secretMatches(t.claimHash, secret)) return { state: "unknown" };
  if (t.state === "claimed") return { state: "claimed" };
  if (t.state === "accepted" && t.wrapped && t.device) {
    const out: CollectResult = {
      state: "accepted", wrapped: t.wrapped, scope: t.device.scope, label: t.device.label,
    };
    tickets.delete(id);
    return out;
  }
  if (t.state === "rejected") { tickets.delete(id); return { state: "rejected" }; }
  return { state: "unknown" };
}

function secretMatches(hash: string, secret: string): boolean {
  if (!secret) return false;
  const want = Buffer.from(hash, "hex");
  const got = createHash("sha256").update(secret).digest();
  if (want.length !== got.length) return false;
  return timingSafeEqual(want, got);
}

/**
 * Seal the credential to the key the claimant generated for this pairing.
 *
 * ECDH over P-256 to a key that exists only in that phone, HKDF to a content
 * key, AES-256-GCM over the token. The ticket id is the HKDF salt so two
 * pairings never derive the same key from the same pair of keys, and the info
 * string pins what the key is for — a key derived for one purpose must not be
 * usable for another.
 *
 * The ephemeral server keypair is generated here and dropped when this returns.
 * Nothing on this machine can decrypt the result afterwards, which is the
 * property that makes it safe to hold in memory until the phone polls for it.
 */
export function sealTo(pub: string, ticketId: string, plaintext: string): Wrapped {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const shared = ecdh.computeSecret(Buffer.from(pub, "base64url"));
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.from(ticketId, "utf8"), Buffer.from(INFO, "utf8"), 32),
  );
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
  return { pub: b64(ecdh.getPublicKey()), iv: b64(iv), data: b64(body) };
}

/** Pins the derived key to this protocol and this version of it. */
export const INFO = "agentglass-pair-v1";

/** Only for tests, which need a clean slate between cases. */
export function __resetPairing(): void {
  tickets.clear();
}

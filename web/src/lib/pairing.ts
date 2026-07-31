import { SERVER } from "./api.ts";

/**
 * The phone's half of pairing. The protocol, and why it has this shape, is in
 * `server/src/pairing.ts`; this is the side that holds the key.
 *
 * The one thing worth repeating here is what this file is for: **the credential
 * must never exist in a form anything but this browser can read.** The server
 * seals it to a key generated on this device, for this pairing, and thrown away
 * afterwards. Everything else — the ticket in the QR, the six digits, the
 * public keys — can be read off the wire by anything on the network without
 * getting a working key out of it, which matters because the server speaks
 * plain HTTP over the LAN.
 *
 * So the private key is generated non-extractable and never leaves WebCrypto.
 * There is no code path in this file that could send it anywhere, because
 * there is no code path anywhere that could get it out.
 */

/** Must match INFO in server/src/pairing.ts — a key derived for one purpose
 *  must not be usable for another, which is what the string is doing. */
const INFO = "agentglass-pair-v1";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Plain `ArrayBuffer`, not a view: every WebCrypto argument below wants a
 *  `BufferSource`, and a `Uint8Array` over a possibly-shared buffer is not one
 *  as far as the type system is concerned. */
const unb64url = (s: string): ArrayBuffer => {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
};

/** The same, for text. */
const utf8 = (s: string): ArrayBuffer => {
  const u = enc.encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};

/** The invitation this page was opened with, if any. `?pair=<id>` is what the
 *  QR on the computer encodes; the id alone authorises nothing. */
export function ticketFromUrl(href: string): string | null {
  try {
    const v = new URL(href).searchParams.get("pair");
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Take `?pair=` back out of the address bar once it has been used, so a
 *  reload does not restart a handshake that has already finished. */
export function clearTicketFromUrl(): void {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("pair")) return;
    u.searchParams.delete("pair");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  } catch { /* no history API — the parameter is harmless once spent */ }
}

export interface PairKeys {
  /** Uncompressed P-256 point, base64url. Safe to send; it is a public key. */
  pub: string;
  /** Non-extractable. This is the only thing that can open the credential. */
  priv: CryptoKey;
}

/**
 * Why this browser cannot pair, in words somebody can act on — or null.
 *
 * `crypto.subtle` does not exist outside a *secure context*, which means HTTPS
 * or localhost and nothing else. A phone opening `http://100.64.1.2:4000` from
 * a QR code therefore has no WebCrypto at all, and the whole handshake — the
 * ECDH keypair, the sealed credential — is impossible before it starts.
 *
 * This shipped without the check, and the way it failed is the reason the check
 * is phrased as a *diagnosis* rather than a boolean. Key generation rejected
 * instantly; the `/pair/info` fetch resolved a network round-trip later and put
 * the form back over the failure; and the button then said "still preparing the
 * connection — try again in a second", which is an invitation to tap it forever
 * for a reason that will never change. Every part of that was true-ish and the
 * whole was useless.
 *
 * Not a thing the app can work around. A pure-JS P-256 is not something to
 * hand-roll for a credential, and dropping the sealing would send the token
 * over the same plain HTTP in the clear. So the only honest move is to say what
 * is wrong and what reaches a secure context instead.
 */
export function pairingBlocked(
  ctx: { isSecureContext?: boolean; origin?: string; subtle?: unknown } = {
    isSecureContext: typeof isSecureContext !== "undefined" ? isSecureContext : undefined,
    origin: typeof location !== "undefined" ? location.origin : "",
    subtle: typeof crypto !== "undefined" ? crypto.subtle : undefined,
  },
): string | null {
  if (ctx.subtle) return null;
  const where = ctx.origin ? ` (${ctx.origin})` : "";
  // Named separately because the fix is different: a tailnet already has a
  // certificate available, and a plain LAN address does not.
  const tailnet = /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ctx.origin ?? "");
  return (
    `This page is not a secure context${where}, so the browser gives it no WebCrypto — ` +
    `and pairing cannot encrypt the credential to this device without it. ` +
    (tailnet
      ? `You are on Tailscale already: on the computer run \`tailscale serve --bg <port>\`, then pick ` +
        `the "Tailscale (HTTPS)" address it adds and re-scan.`
      : `Open the cockpit over HTTPS, or reach it as http://localhost through a forwarded port.`)
  );
}

/** A keypair for one pairing, and one pairing only. */
export async function makeKeys(subtle: SubtleCrypto = crypto.subtle): Promise<PairKeys> {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = await subtle.exportKey("raw", kp.publicKey);
  return { pub: b64url(raw), priv: kp.privateKey };
}

export interface Sealed { pub: string; iv: string; data: string }

/**
 * Open what the server sealed.
 *
 * ECDH against the server's ephemeral key, HKDF to a content key with the
 * ticket id as salt, AES-256-GCM. Every parameter has to match the server
 * exactly; GCM's tag means a mismatch throws rather than returning plausible
 * rubbish, which is the behaviour worth having when the alternative is storing
 * a corrupt credential and failing later with an unrelated 401.
 */
export async function unseal(
  sealed: Sealed, priv: CryptoKey, ticketId: string, subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const serverPub = await subtle.importKey(
    "raw", unb64url(sealed.pub), { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverPub }, priv, 256);
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8(ticketId), info: utf8(INFO) },
    ikm, 256,
  );
  const key = await subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(sealed.iv) }, key, unb64url(sealed.data),
  );
  return dec.decode(plain);
}

/**
 * A name for this device, guessed so the field is not empty.
 *
 * Only ever a starting point — the field is editable, and the guess is
 * deliberately the vague kind. "iPhone" is a name somebody will recognise in a
 * list next week; a browser build string is not, and a confidently wrong model
 * is worse than either, because the list it lands in is the one used to decide
 * what to cut off.
 */
export function guessName(ua: string = navigator.userAgent): string {
  if (/\biPhone\b/.test(ua)) return "iPhone";
  if (/\biPad\b/.test(ua)) return "iPad";
  if (/\bAndroid\b/.test(ua)) return "Android phone";
  if (/\bMacintosh\b/.test(ua)) return "Mac";
  if (/\bWindows NT\b/.test(ua)) return "Windows PC";
  return "My device";
}

export type ClaimOutcome =
  | { ok: true; secret: string }
  | { ok: false; error: string; fatal: boolean };

/** Type the code. A wrong one is worth retrying; everything else is not, and
 *  saying so is the difference between "try again" and "go to the computer". */
export async function claim(
  ticket: string, code: string, label: string, pub: string,
): Promise<ClaimOutcome> {
  let r: Response;
  try {
    r = await fetch(SERVER + "/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, code, label, pub }),
    });
  } catch {
    return { ok: false, error: "Could not reach the computer. Check you are on the same network.", fatal: false };
  }
  const j = await r.json().catch(() => ({}) as Record<string, unknown>);
  if (r.ok && (j as { ok?: boolean }).ok) return { ok: true, secret: String((j as { secret?: string }).secret ?? "") };
  const reason = String((j as { reason?: string }).reason ?? "");
  return {
    ok: false,
    error: String((j as { error?: string }).error ?? "That did not work."),
    // Only a wrong code leaves the invitation alive. Everything else has
    // consumed or closed it, and re-typing into a dead ticket is a loop.
    fatal: reason !== "code",
  };
}

export type CollectOutcome =
  | { state: "claimed" }
  | { state: "accepted"; token: string; scope: string; label: string }
  | { state: "rejected" }
  | { state: "unknown" };

/** Ask once whether somebody has decided yet, and unwrap if they said yes. */
export async function collectOnce(
  ticket: string, secret: string, priv: CryptoKey,
): Promise<CollectOutcome> {
  let r: Response;
  try {
    r = await fetch(`${SERVER}/pair/collect?ticket=${encodeURIComponent(ticket)}&secret=${encodeURIComponent(secret)}`);
  } catch {
    return { state: "claimed" }; // a blip while waiting is not a decision
  }
  const j = (await r.json().catch(() => ({}))) as { state?: string; wrapped?: Sealed; scope?: string; label?: string };
  if (j.state === "accepted" && j.wrapped) {
    // If this throws, the credential is not recoverable — the server has
    // already destroyed the ticket. Reported as unknown so the screen offers a
    // fresh start rather than a retry that cannot succeed.
    try {
      const token = await unseal(j.wrapped, priv, ticket);
      return { state: "accepted", token, scope: j.scope ?? "answer", label: j.label ?? "" };
    } catch {
      return { state: "unknown" };
    }
  }
  if (j.state === "rejected") return { state: "rejected" };
  if (j.state === "claimed") return { state: "claimed" };
  return { state: "unknown" };
}

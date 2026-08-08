// Everything about one process that does not fit on a row.
//
// The ports panel answers "what is listening" and, since the ancestry landed,
// "what is holding it". The question after those two is always the same, and a
// row cannot hold it: what is this thing actually running, and what was it
// given? A stray server on 0.0.0.0 was explained on this machine by exactly one
// fact — it had inherited AGENTGLASS_BIND from the terminal that started it —
// and getting to that fact meant three reads of /proc by hand.
//
// ENVIRONMENT VARIABLES ARE THE POINT AND THE PROBLEM. /proc/<pid>/environ is
// where the explanation lives, and it is also where tokens, API keys and
// database passwords live. This panel is reachable from a paired phone. Shipping
// the environment raw would broadcast every secret this user's processes hold to
// any device with read access — the exact opposite of the thing the token work
// was for.
//
// So: keys are always listed, values are masked when the key or the value looks
// like a secret, and unmasking is a separate call that only the desktop shell
// can make. The KEY is usually the whole answer anyway — that AGENTGLASS_BIND
// is set at all explains the stray server; its value is a detail.

import { readFileSync } from "node:fs";
import { ancestryOf, ownedByMe, cwdOf, ageSecOf, type Forebear } from "./machine.ts";

export interface EnvVar {
  key: string;
  /** The value, or null when it is masked. Null is the signal to the UI, not an
   *  empty string — an empty string is a real value a variable can have. */
  value: string | null;
  /** Why it is masked, so the UI can say "looks like a secret" rather than
   *  leaving the reader to guess whether the value is empty. */
  masked: boolean;
}

export interface ProcDetail {
  pid: number;
  /** The kernel's short name. */
  comm: string;
  /** The full command line, which is the thing a row can never show. */
  cmd: string;
  cwd: string | null;
  ageSec: number | null;
  /** Nearest first, the same walk the ports row uses. */
  ancestry: Forebear[];
  env: EnvVar[];
  /** Set when the process is gone or belongs to somebody else. */
  error?: string;
}

/**
 * Keys whose values are secrets often enough to mask by default.
 *
 * Tuned for false positives rather than against them. A wrongly masked PATH
 * costs one click; a wrongly revealed API key is on a phone screen and in a
 * screenshot. `KEY` catches `AWS_SECRET_ACCESS_KEY` and also `SSH_KEY_PATH`,
 * and that trade is deliberate.
 */
/*
 * Tuned against this machine rather than guessed. The first version used bare
 * `SESSION`, `AUTH` and `KEY`, and masked eighteen of a real process's
 * seventy-seven variables — of which two were secrets. `DESKTOP_SESSION=ubuntu`,
 * `XDG_SESSION_TYPE=wayland` and `GDMSESSION` are not credentials, and a panel
 * where everything is dots teaches people to click through the dots.
 *
 * So the session and auth words have to earn it by pairing with something:
 * `SESSION_TOKEN` yes, `XDG_SESSION_CLASS` no.
 */
const SECRET_KEY = new RegExp([
  "TOKEN", "SECRET", "PASSWD", "PASSWORD", "CREDENTIAL", "SIGNATURE",
  "PRIVATE_?KEY", "API_?KEY", "ACCESS_?KEY", "_KEY\\b", "KEY_",
  "AUTHORIZATION", "_AUTH\\b", "_PAT\\b", "_DSN\\b",
  "SESSION_(TOKEN|SECRET|KEY|ID)",
].join("|"), "i");

/**
 * A value that looks like a credential whatever its key is called.
 *
 * The long tail: a token under a name no pattern anticipated, or a variable
 * somebody called `X`. Two shapes, and both want length AND disorder — twenty
 * characters of one alphabet is a filename (`agentglass-electron.desktop` was
 * masked by the first version), while twenty characters mixing case and digits
 * is a key.
 */
const SECRET_VALUE = [
  /^[0-9a-f]{24,}$/i,                                       // hex: a session id, a hash
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/=_.-]{20,}$/, // base64/base62: a token
];

/**
 * Should this pair be hidden until asked for?
 *
 * The path check comes FIRST, before the key, and that ordering is the fix for
 * the other half of the noise: `SSH_AUTH_SOCK`, `XAUTHORITY` and
 * `SESSION_MANAGER` all hold a *path to* something sensitive, and a path is not
 * the credential. Checking the name first masked all three and taught the
 * reader nothing.
 */
export function looksSecret(key: string, value: string): boolean {
  // First, and on the value alone: a URL with userinfo carries its credential
  // inside it and no key pattern will save you. `DATABASE_URL` matches nothing
  // in SECRET_KEY, and `postgres://u:p@host/db` matches nothing in SECRET_VALUE
  // either — the punctuation puts it outside the base64 alphabet. Without this
  // rule it arrived in the clear.
  if (hasUserinfo(value)) return true;
  if (isLocation(value)) return false;
  if (SECRET_KEY.test(key)) return true;
  return SECRET_VALUE.some((re) => re.test(value));
}

/** `scheme://user:pass@host` — the credential is in the string. */
function hasUserinfo(v: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(v);
}

/** A path, a URL or a sentence — none of which are a credential, however the
 *  variable holding them is named. Userinfo is already gone by here. */
function isLocation(v: string): boolean {
  return v.startsWith("/") || v.includes("://") || v.includes(":/") || v.includes(" ");
}

/**
 * Read and split `/proc/<pid>/environ`.
 *
 * NUL-separated, and the last entry is usually followed by a trailing NUL —
 * hence the filter rather than a plain split. A variable with `=` in its value
 * is legal, so only the FIRST `=` separates.
 */
function readEnv(pid: number): EnvVar[] {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return []; }
  const out: EnvVar[] = [];
  for (const pair of raw.split("\0")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const masked = looksSecret(key, value);
    out.push({ key, value: masked ? null : value, masked });
  }
  // Alphabetical: the reader is looking for a name they already have in mind,
  // and the kernel's order is the order they were set, which is nobody's.
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch { return ""; }
}

function commOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return ""; }
}

/**
 * One process, in full.
 *
 * Refuses anything this user does not own, and that is the whole authorisation
 * story: /proc will not describe another account's process anyway, so the check
 * turns a confusing empty answer into an honest one.
 */
export function procDetail(pidIn: unknown): ProcDetail {
  const pid = Number(pidIn);
  const empty = { pid, comm: "", cmd: "", cwd: null, ageSec: null, ancestry: [], env: [] };
  if (!Number.isInteger(pid) || pid <= 0) return { ...empty, error: "not a pid" };
  if (!ownedByMe(pid)) return { ...empty, error: "that process is not yours, or has gone" };
  return {
    pid,
    comm: commOf(pid),
    cmd: cmdlineOf(pid),
    cwd: cwdOf(pid),
    ageSec: ageSecOf(pid),
    ancestry: ancestryOf(pid),
    env: readEnv(pid),
  };
}

/**
 * One masked value, revealed.
 *
 * A separate call rather than a flag on the one above, because the two have
 * different audiences: the panel is for anything that can reach the server, and
 * this is for the desktop shell alone (enforced by the caller — see index.ts).
 * Keeping them apart means the bulk read can never be talked into returning
 * secrets by a query parameter.
 */
export function revealEnv(pidIn: unknown, keyIn: unknown): { ok: boolean; value?: string; error?: string } {
  const pid = Number(pidIn);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: "not a pid" };
  if (typeof keyIn !== "string" || !keyIn) return { ok: false, error: "no key" };
  if (!ownedByMe(pid)) return { ok: false, error: "that process is not yours, or has gone" };
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return { ok: false, error: "it has gone" }; }
  for (const pair of raw.split("\0")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at) === keyIn) return { ok: true, value: pair.slice(at + 1) };
  }
  return { ok: false, error: "no such variable" };
}

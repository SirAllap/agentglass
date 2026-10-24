/**
 * The `accounts` contribution: a plugin tells the app which accounts a provider
 * has on this machine and which one is in use, so the usage popover can show
 * them as chips. The app never reads or writes a credential for this: it holds
 * the list in memory, shows it, and asks the plugin to switch.
 *
 * Because a list like this is exactly where a plugin would be tempted to put a
 * token ("which account is this?"), the validator refuses the whole input when
 * a visible string looks like one, instead of trimming it: a plugin that sent a
 * key once is a plugin to hear about, not one to quietly fix. Fields it does not
 * know are dropped, never copied through.
 *
 * Pure: the server validates what a plugin posts and the window re-checks what
 * it receives with the same function.
 */
import { ACCENTS } from "./palettes.ts";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

/** The providers an account list may name: the same three the usage popover knows. */
export const ACCOUNT_PROVIDERS = ["anthropic", "codex", "antigravity"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
/** At most one holder per provider, so a manifest naming all three is the ceiling. */
export const ACCOUNT_PROVIDERS_MAX = ACCOUNT_PROVIDERS.length;

export const MAX_ACCOUNTS = 8;
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ACCOUNT_LABEL_MAX = 32;
export const ACCOUNT_PLAN_MAX = 24;
export const ACCOUNT_WINDOWS_MAX = 6;
const WINDOW_LABEL_MAX = 16;
/** A week and a bit, in minutes: nothing a provider meters runs longer. */
const WINDOW_MINUTES_MAX = 60 * 24 * 31;

/** The accent words the app already draws (shared/palettes.ts), plus neutral: a word, never a hex. */
export const ACCOUNT_COLOURS = ["neutral", ...ACCENTS.map((a) => a.id)] as readonly string[];
export const ACCOUNT_STORAGE = ["keyring", "file"] as const;
export type AccountStorage = (typeof ACCOUNT_STORAGE)[number];

/**
 * The plugins the app knows as the account manager of a provider. Not a field a
 * plugin sets: `managedBy` is decided by the app from the name the plugin is
 * installed under (accounts.ts), because a claim in the body would let any
 * plugin put "Managed by <a tool people trust>" on the chips. A body that sends
 * it is read as if it had not.
 */
export const ACCOUNT_MANAGERS = ["swapkin"] as const;
export type AccountManager = (typeof ACCOUNT_MANAGERS)[number];

/** One metered window, the shape the core already shows (QuotaWindow in shared/types.ts). */
export interface AccountWindow { label: string; minutes: number; usedPercent: number; resetsAt: string | null }

export interface Account {
  id: string;
  label: string;
  plan: string;
  colour: string;
  active: boolean;
  storage: AccountStorage;
  /** What the plugin measured for this account. Kept on the server only; `accountOut` drops it. */
  reading?: { windows: AccountWindow[] };
}

export interface AccountsInput {
  provider: AccountProvider;
  managedBy?: AccountManager;
  accounts: Account[];
}

/** What the window and the phone are given: the same, without a reading. */
export type AccountOut = Omit<Account, "reading">;
export interface AccountsOut { provider: AccountProvider; plugin: string; managedBy?: AccountManager; accounts: AccountOut[] }

export const accountOut = ({ reading: _reading, ...rest }: Account): AccountOut => rest;

/*
 * What a token looks like in a short visible string. Measured against the
 * shapes a provider hands out: `sk-` prefixes, a JWT's `eyJ`, hex and base64
 * runs, an email (which is who the account belongs to, and not the app's to
 * show). The ceiling: a URL-safe run of 24+ letters and digits with dashes
 * (`ghp_...`) is not caught; the id and label caps are what bound it.
 */
const TOKEN_SHAPED = /\bsk-|\beyJ|[^\s@]+@[^\s@]+|[A-Za-z0-9+/=]{24,}/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_TAG = /[\u0000-\u001f\u007f<>]/;
/** Format (bidi overrides and isolates, zero-width), private-use, surrogate and unassigned code points: invisible or able to make one chip read as another. */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u;

/** A short visible string: bounded, no control character, no tag, nothing token-shaped. Null names the problem. */
function plainText(v: unknown, field: string, max: number, min: number): Err | null {
  if (typeof v !== "string") return { ok: false, error: `${field} must be a string` };
  if (v.length < min || v.length > max) return { ok: false, error: `${field} must be ${min === 0 ? "at most" : `${min}-`}${max} characters` };
  if (CONTROL_OR_TAG.test(v) || INVISIBLE.test(v)) return { ok: false, error: `${field} must be plain text` };
  // Trimmed and compatibility-normalised first, so a fullwidth "＠" or "ｓｋ-" is what it spells.
  if (TOKEN_SHAPED.test(v.trim().normalize("NFKC"))) return { ok: false, error: `${field} looks like a credential or an email, which this list never carries; the whole list was refused` };
  return null;
}

/**
 * A token cut into pieces that each pass `plainText`: an id, a label and a plan
 * of eight to twelve characters apiece. The pieces are the fields with no space
 * in them (a name with words is a name), separators stripped, a piece that
 * repeats or sits inside another one dropped (id and label are often the same
 * word), and what is left joined is judged as one string: 24+ letters and
 * digits that mix both. The ceiling: a plain-word split ("acme" + "work" +
 * ...) with no digit is not caught, and neither is a token cut into only
 * spaced words; the caps on the three fields are what bound it.
 */
function splitToken(...fields: string[]): boolean {
  const pieces = fields.map((f) => f.trim().normalize("NFKC")).filter((f) => f && !/\s/.test(f))
    .map((f) => f.replace(/[-_]/g, "").toLowerCase());
  const own = pieces.filter((p, i) => p && !pieces.some((q, j) => j !== i && (q.includes(p) && (q !== p || j < i))));
  if (own.length < 2) return false;
  const joined = own.join("");
  // Random tokens swap between letters and digits all the time (a 24-character
  // base64 run about six times, hex about eleven); a name with a number in it
  // does so once or twice.
  return /[A-Za-z0-9+/=]{24,}/.test(joined) && (joined.match(/[a-z]\d|\d[a-z]/g)?.length ?? 0) >= 4;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function validateWindow(raw: unknown, at: string): Ok<AccountWindow> | Err {
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  const bad = plainText(raw.label, `${at}.label`, WINDOW_LABEL_MAX, 1);
  if (bad) return bad;
  const { minutes, usedPercent, resetsAt } = raw;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > WINDOW_MINUTES_MAX) return { ok: false, error: `${at}.minutes must be a whole number of minutes` };
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return { ok: false, error: `${at}.usedPercent must be 0-100` };
  if (resetsAt !== null && (typeof resetsAt !== "string" || resetsAt.length > 40 || Number.isNaN(Date.parse(resetsAt)))) return { ok: false, error: `${at}.resetsAt must be an ISO time or null` };
  return { ok: true, value: { label: raw.label as string, minutes, usedPercent: Math.round(usedPercent), resetsAt: resetsAt as string | null } };
}

function validateAccount(raw: unknown, n: number): Ok<Account> | Err {
  const at = `accounts[${n}]`;
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  if (typeof raw.id !== "string" || !ACCOUNT_ID_RE.test(raw.id)) return { ok: false, error: `${at}.id must be 1-32 of a-z, 0-9, - and _, starting with a letter or digit` };
  const idBad = plainText(raw.id, `${at}.id`, 32, 1);
  if (idBad) return idBad;
  const labelBad = plainText(raw.label, `${at}.label`, ACCOUNT_LABEL_MAX, 1);
  if (labelBad) return labelBad;
  const planBad = plainText(raw.plan, `${at}.plan`, ACCOUNT_PLAN_MAX, 0);
  if (planBad) return planBad;
  if (splitToken(raw.id as string, raw.label as string, raw.plan as string)) return { ok: false, error: `${at}: id, label and plan together look like one credential cut in pieces, which this list never carries; the whole list was refused` };
  if (typeof raw.colour !== "string" || !ACCOUNT_COLOURS.includes(raw.colour)) return { ok: false, error: `${at}.colour must be one of ${ACCOUNT_COLOURS.join(", ")}` };
  if (typeof raw.active !== "boolean") return { ok: false, error: `${at}.active must be true or false` };
  if (typeof raw.storage !== "string" || !(ACCOUNT_STORAGE as readonly string[]).includes(raw.storage)) return { ok: false, error: `${at}.storage must be keyring or file` };
  const out: Account = { id: raw.id, label: (raw.label as string).trim(), plan: (raw.plan as string).trim(), colour: raw.colour, active: raw.active, storage: raw.storage as AccountStorage };
  if (!out.label) return { ok: false, error: `${at}.label is empty` };
  if (raw.reading !== undefined) {
    if (!isRecord(raw.reading) || !Array.isArray(raw.reading.windows) || raw.reading.windows.length > ACCOUNT_WINDOWS_MAX) return { ok: false, error: `${at}.reading.windows must be a list of at most ${ACCOUNT_WINDOWS_MAX}` };
    const windows: AccountWindow[] = [];
    const labels = new Set<string>();
    for (const [i, w] of raw.reading.windows.entries()) {
      const r = validateWindow(w, `${at}.reading.windows[${i}]`);
      if (!r.ok) return r;
      // Rows are keyed by the window's label on both screens.
      if (labels.has(r.value.label.toLowerCase())) return { ok: false, error: `${at}.reading.windows repeats the label "${r.value.label}"` };
      labels.add(r.value.label.toLowerCase());
      windows.push(r.value);
    }
    out.reading = { windows };
  }
  return { ok: true, value: out };
}

/** Whether a provider word is one of the three. */
export const isAccountProvider = (v: unknown): v is AccountProvider => typeof v === "string" && (ACCOUNT_PROVIDERS as readonly string[]).includes(v);

/**
 * What a plugin posts as the accounts of one provider. Whole or nothing: the
 * first problem refuses the input and nothing from it is kept.
 */
export function validateAccounts(raw: unknown): Ok<AccountsInput> | Err {
  if (!isRecord(raw)) return { ok: false, error: "accounts must be an object with a provider and a list" };
  if (!isAccountProvider(raw.provider)) return { ok: false, error: `provider must be one of ${ACCOUNT_PROVIDERS.join(", ")}` };
  if (!Array.isArray(raw.accounts) || raw.accounts.length > MAX_ACCOUNTS) return { ok: false, error: `accounts must be a list of at most ${MAX_ACCOUNTS}` };
  const accounts: Account[] = [];
  const seen = new Set<string>();
  const labels = new Set<string>();
  for (const [n, a] of raw.accounts.entries()) {
    const r = validateAccount(a, n);
    if (!r.ok) return r;
    if (seen.has(r.value.id)) return { ok: false, error: `account id "${r.value.id}" appears twice` };
    // The popover matches a row to its chip, and the phone keys it, by label.
    if (labels.has(r.value.label.toLowerCase())) return { ok: false, error: `account label "${r.value.label}" appears twice` };
    seen.add(r.value.id);
    labels.add(r.value.label.toLowerCase());
    accounts.push(r.value);
  }
  if (accounts.filter((a) => a.active).length > 1) return { ok: false, error: "at most one account may be active" };
  return { ok: true, value: { provider: raw.provider, accounts } };
}

/** `contributes.accounts`: the providers this plugin holds the account list of. Closed, no repeats. */
export function validateAccountProviders(raw: unknown): Ok<AccountProvider[]> | Err {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ACCOUNT_PROVIDERS_MAX) return { ok: false, error: `contributes.accounts must be a list of 1-${ACCOUNT_PROVIDERS_MAX} providers` };
  const seen = new Set<AccountProvider>();
  for (const p of raw) {
    if (!isAccountProvider(p)) return { ok: false, error: `contributes.accounts: unknown provider ${JSON.stringify(typeof p === "string" ? p.slice(0, 40) : p)}; allowed: ${ACCOUNT_PROVIDERS.join(", ")}` };
    if (seen.has(p)) return { ok: false, error: `contributes.accounts: "${p}" appears twice` };
    seen.add(p);
  }
  return { ok: true, value: [...seen] };
}

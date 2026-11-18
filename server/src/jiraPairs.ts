/*
 * Which Jira account a GitHub login is, learned from what the person actually
 * did: on one pull request or card, a reviewer picked on GitHub and an assignee
 * set in Jira. That pair is remembered here, on this machine, and offered first
 * the next time the same login has a card to assign.
 *
 * Nobody is guessed. A GitHub login is often a pseudonym, so a name or an email
 * the two systems happen to share is not evidence and is never compared; the
 * only way a pair exists is that the person made both picks (decision 2026-10-09,
 * like the card's own links in web/src/lib/prCardPeople.ts).
 *
 * The store is a plain JSON file beside ClickUp's settings, keyed by the
 * lower-case login, one entry per login: the account id a write takes, the name
 * and email as Jira gave them for the list in Settings, how many times the pair
 * was made, and when it last was. A pick for the same login with another account
 * replaces the entry — the newer choice wins — and a repeated one counts up.
 * Ceiling: a pair per login, not per site, and nothing here is ever sent to Jira
 * or GitHub.
 *
 * The file is replaced whole, through a temporary file and a rename, and a file
 * that cannot be parsed is a refusal rather than an empty store: it is plain JSON
 * somebody may edit, and losing every pair to one trailing comma is not a trade.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface JiraPair {
  /** The GitHub login, lower-case: GitHub's are not case-sensitive. */
  login: string;
  /** What a Jira write takes for this account (Cloud's accountId, Data Center's login). */
  accountId: string;
  /** The account's name as Jira spells it, for the list in Settings. */
  name: string;
  email?: string;
  /** How many times this pair was made. */
  n: number;
  /** When it last was, epoch ms. */
  at: number;
}
export type JiraPairs = Record<string, JiraPair>;

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "jira-pairs.json");

/** Test seam, so a suite never reads or writes the developer's own file. */
let override: string | null = null;
export function __setPairsPath(p: string | null): void { override = p; }
const path = (): string => override ?? FILE;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The pairs as stored, or why the file could not be read. A missing file is an empty store; a damaged one is not. */
function load(): { ok: true; pairs: JiraPairs } | { ok: false; error: string } {
  let raw: unknown;
  try {
    if (!existsSync(path())) return { ok: true, pairs: {} };
    raw = JSON.parse(readFileSync(path(), "utf8"));
  } catch (e) {
    return { ok: false, error: `the pairs could not be read: ${(e as Error).message}` };
  }
  if (!isObj(raw)) return { ok: false, error: "the pairs file is not an object" };
  const out: JiraPairs = {};
  for (const [login, v] of Object.entries(raw)) {
    const p = isObj(v) ? v : null;
    const id = text(p?.accountId);
    const name = text(p?.name);
    if (!p || !login || !id || !name) continue;
    const n = typeof p.n === "number" && Number.isSafeInteger(p.n) && p.n > 0 ? p.n : 1;
    const at = typeof p.at === "number" && Number.isFinite(p.at) && p.at > 0 ? p.at : 0;
    const email = text(p.email);
    out[login.toLowerCase()] = { login: login.toLowerCase(), accountId: id, name, ...(email ? { email } : null), n, at };
  }
  return { ok: true, pairs: out };
}

/** The pairs as stored. Anything that is not the shape of one is dropped, never repaired. */
export function readPairs(): JiraPairs {
  const r = load();
  return r.ok ? r.pairs : {};
}

/** Written beside the file and renamed over it, as ClickUp's settings are: an interrupted write keeps the last good file. */
function write(pairs: JiraPairs): void {
  const p = path();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
  renameSync(tmp, p);
}

export interface PairPick { login: string; accountId: string; name: string; email?: string }

export type LearnedPairs = { ok: true; pairs: JiraPairs } | { ok: false; error: string };

/**
 * The pairs one errand made: a login and the Jira account that was put on the
 * card with it. Same account again counts up; another account replaces it. A
 * file that cannot be read or written is refused: it is never rebuilt from empty.
 */
export function learnPairs(picks: readonly PairPick[], now = Date.now()): LearnedPairs {
  const read = load();
  if (!read.ok) return read;
  const pairs = read.pairs;
  for (const p of picks) {
    const login = p.login.trim().toLowerCase().replace(/^@/, "");
    const accountId = p.accountId.trim();
    const name = p.name.trim();
    if (!login || !accountId || !name || login.startsWith("@")) continue;
    const was = pairs[login];
    const same = was && was.accountId === accountId;
    const email = p.email?.trim();
    pairs[login] = { login, accountId, name, ...(email ? { email } : null), n: same ? was.n + 1 : 1, at: now };
  }
  try {
    write(pairs);
  } catch (e) {
    return { ok: false, error: `the pairs could not be saved: ${(e as Error).message}` };
  }
  return { ok: true, pairs };
}

/** Forget one login's pair. Returns what is left. */
export function forgetPair(login: string): JiraPairs {
  const pairs = readPairs();
  const key = login.trim().toLowerCase().replace(/^@/, "");
  if (key in pairs) { delete pairs[key]; write(pairs); }
  return pairs;
}

/**
 * The pairs to offer first for the logins a pull request has, best first: the
 * one made most often, and the most recent among equal counts. Only the logins
 * given, so a pair is never carried to a login nobody picked.
 */
export function pairsFor(pairs: JiraPairs, logins: readonly string[]): JiraPair[] {
  const want = new Set(logins.filter((l) => !l.startsWith("@")).map((l) => l.toLowerCase()));
  return Object.values(pairs).filter((p) => want.has(p.login)).sort((a, b) => b.n - a.n || b.at - a.at);
}

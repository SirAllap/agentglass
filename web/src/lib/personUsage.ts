/*
 * Who this person reaches for, kept in this browser and nowhere else.
 *
 * The people lists (reviewers, assignees, the "@" in the pull-request search)
 * are the repository's whole roster in alphabetical order, and the three or
 * four colleagues somebody picks every day sit wherever the alphabet puts them.
 * A count and a last-used time per login is enough to put them first: no
 * server, no GitHub call, and the ranking is computed from what is already on
 * the screen.
 *
 * The score is the count halved for every HALF_LIFE_DAYS since the last pick,
 * so somebody picked twenty times last spring does not outrank the colleague
 * picked three times this week. Ceiling: one decay per login from its LAST pick
 * (not per pick), which is cheap and close enough; a true per-pick decay would
 * need the whole history and nobody needs that to order five names.
 */

const KEY = "agentglass.pr.people";
export const HALF_LIFE_DAYS = 14;
/** The top section holds at most this many names, so it stays a shortcut and not a second list. */
export const FREQUENT_MAX = 5;
/**
 * How many of everybody else the "@" menu draws. Every row is an avatar the
 * browser fetches, so a roster of three hundred would be three hundred image
 * requests for a menu that shows eight rows; typing narrows the rest. Ceiling:
 * a colleague past the tenth is reached by typing a few letters of the login.
 */
export const SUGGEST_REST_MAX = 10;
/** Stored entries are capped so a roster of hundreds cannot grow the key without bound. */
const KEEP = 60;
const DAY = 86_400_000;

export type PersonUse = Record<string, { n: number; at: number }>;

export function loadUse(): PersonUse {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PersonUse = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as { n?: unknown; at?: unknown } | null;
      if (e && typeof e.n === "number" && typeof e.at === "number" && e.n > 0) out[k] = { n: e.n, at: e.at };
    }
    return out;
  } catch { return {}; }
}

/** One pick for each login, now. Logins are keyed lower-case: GitHub's are not case-sensitive. */
export function recordPicks(logins: readonly string[], now = Date.now()): void {
  if (!logins.length) return;
  try {
    const use = loadUse();
    for (const l of logins) {
      const k = l.toLowerCase();
      use[k] = { n: (use[k]?.n ?? 0) + 1, at: now };
    }
    const kept = Object.entries(use).sort((a, b) => scoreOf(b[1], now) - scoreOf(a[1], now)).slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* private mode, or a browser that has said no */ }
}

export function scoreOf(e: { n: number; at: number } | undefined, now: number): number {
  if (!e) return 0;
  const days = Math.max(0, now - e.at) / DAY;
  return e.n * Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/**
 * The roster split in two: the people picked before, best first (at most
 * FREQUENT_MAX), and everybody else in the order the roster came in. A login
 * that was picked but is no longer on the roster is not invented back in.
 */
export function rankPeople(roster: readonly string[], use: PersonUse, now = Date.now()): { frequent: string[]; rest: string[] } {
  const scored = roster
    .map((login, i) => ({ login, i, s: scoreOf(use[login.toLowerCase()], now) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, FREQUENT_MAX);
  const top = new Set(scored.map((x) => x.login));
  return { frequent: scored.map((x) => x.login), rest: roster.filter((l) => !top.has(l)) };
}

/** The "@name" being typed at the end of the box, or null when the last word is not one. */
export function atToken(text: string): { token: string; start: number } | null {
  const m = /(?:^|\s)@([\w-]*)$/.exec(text);
  if (!m) return null;
  return { token: m[1], start: text.length - m[1].length - 1 };
}

/** The roster narrowed by what follows the "@", the frequent section kept first. */
export function suggestPeople(roster: readonly string[], use: PersonUse, token: string, now = Date.now()): { frequent: string[]; rest: string[] } {
  const t = token.toLowerCase();
  const { frequent, rest } = rankPeople(roster, use, now);
  const keep = (l: string) => !t || l.toLowerCase().includes(t);
  return { frequent: frequent.filter(keep), rest: rest.filter(keep).slice(0, SUGGEST_REST_MAX) };
}

/** The box with the trailing "@token" replaced by the qualifier the search already understands. */
export function applyPick(text: string, login: string): string {
  const at = atToken(text);
  const head = at ? text.slice(0, at.start) : text;
  return `${head}author:${login} `;
}

/**
 * A people picker's options with the frequent ones lifted into a top section.
 * Everything keeps its own label and sub-line; the rest keep their order. With
 * nobody frequent the list comes back untouched, no headers, so a first-time
 * picker looks exactly as it did.
 */
export function withFrequent<T extends { value: string }>(options: readonly T[], use: PersonUse, now = Date.now()): (T & { section?: string })[] {
  const { frequent } = rankPeople(options.map((o) => o.value), use, now);
  if (!frequent.length) return [...options];
  const by = new Map(options.map((o) => [o.value, o] as const));
  const top = new Set(frequent);
  return [
    ...frequent.map((v) => ({ ...by.get(v)!, section: "Frequent" })),
    ...options.filter((o) => !top.has(o.value)).map((o) => ({ ...o, section: "Everyone" })),
  ];
}

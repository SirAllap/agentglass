// GitHub repositories the person reads without cloning them.
//
// They are NOT projects: nothing here reaches the server's config, none has a
// directory, and none is ever given an agent. A remote repository is a name, the
// last counts GitHub gave for it, and whether it is ticked in the Open projects
// dialog. All of it lives in this browser's localStorage, like the pins.
//
// Stored: `owner/name` in GitHub's own casing, when it was added and last seen,
// the open pull request count and whether it is private. The description is not
// stored — it is read once, shown to the person who asked, and dropped.
//
// Ceiling: this browser only. A second machine has its own list.

export const REMOTE_MAX = 30;
const KEY = "agentglass.remoteRepos";
const TICK_KEY = "agentglass.remoteRepos.ticked";

export type RemoteRepo = {
  repo: string;
  addedAt: number;
  lastSeen: number;
  openPrs?: number;
  private?: boolean;
  /** Two `not-found` answers in a row for a repo that was found before. */
  gone?: boolean;
  /** The sign-in on this machine cannot see it any more; counts are kept. */
  noAccess?: boolean;
  /** One `not-found` seen; the next one makes it `gone`. */
  missedOnce?: boolean;
};

/** What `GET /gh/repo-lookup` answers. */
export type LookupAnswer =
  | { found: true; repo: string; private: boolean; description: string; defaultBranch: string; openPrs?: number }
  | { found: false; error: "not-found" | "no-access" | "gh-not-signed-in" | "gh-missing" | "unreachable" | "bad-repo"; account?: string };

export type Parsed =
  | { kind: "empty" }
  | { kind: "other-host" }
  | { kind: "invalid" }
  | { kind: "repo"; repo: string; pr?: number };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const okPair = (o: string, n: string): boolean => OWNER.test(o) && NAME.test(n) && n !== "." && n !== "..";

/**
 * One place that reads what was typed or pasted: `owner/repo`, a github.com URL
 * (www, http, https, `.git`, trailing slash), `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r`, and a `/pull/N` link, which also gives the number.
 * Any other path after owner/repo (`/tree/x`, `/issues/3`) is ignored. Another
 * host is its own answer, so the card can say "only github.com".
 */
export function parseRepoInput(raw: string): Parsed {
  const t = raw.trim();
  if (!t) return { kind: "empty" };
  let path: string;
  const scp = /^git@([^:/\s]+):(.+)$/.exec(t);
  if (scp) {
    if (scp[1].toLowerCase() !== "github.com") return { kind: "other-host" };
    path = scp[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    let u: URL;
    try { u = new URL(t); } catch { return { kind: "invalid" }; }
    if (!/^(https?|ssh|git):$/.test(u.protocol)) return { kind: "invalid" };
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "github.com") return { kind: "other-host" };
    path = u.pathname;
  } else if (/^(www\.)?github\.com\//i.test(t)) {
    path = t.replace(/^(www\.)?github\.com/i, "").split(/[?#]/)[0];
  } else if (/^[^/\s]+\.[a-z]{2,}\/[^/\s]+\/[^/\s]+/i.test(t) && !/^[^/\s]+\/[^/\s]+$/.test(t)) {
    return { kind: "other-host" };
  } else {
    path = t;
  }
  const [o, rawName, kind, num] = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (!o || !rawName) return { kind: "invalid" };
  const n = rawName.replace(/\.git$/, "");
  if (!okPair(o, n)) return { kind: "invalid" };
  const pr = kind === "pull" && /^\d{1,9}$/.test(num ?? "") ? Number(num) : undefined;
  return pr ? { kind: "repo", repo: `${o}/${n}`, pr } : { kind: "repo", repo: `${o}/${n}` };
}

/** Case-insensitive identity: GitHub treats `Acme/Orbit` and `acme/orbit` as one repository. */
export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const findRemote = (list: readonly RemoteRepo[], repo: string): RemoteRepo | undefined =>
  list.find((r) => sameRepo(r.repo, repo));

export const isFull = (list: readonly RemoteRepo[]): boolean => list.length >= REMOTE_MAX;

/** Add a found repository. Refuses a duplicate or a full list; never evicts. */
export function addRemote(list: readonly RemoteRepo[], found: Extract<LookupAnswer, { found: true }>, now: number): RemoteRepo[] {
  if (findRemote(list, found.repo) || isFull(list)) return [...list];
  // First, not last: a repo added a moment ago must be where the eye already is, not 30 rows down.
  return [{ repo: found.repo, addedAt: now, lastSeen: now, ...(found.openPrs !== undefined ? { openPrs: found.openPrs } : {}), private: found.private }, ...list];
}

export const forgetRemote = (list: readonly RemoteRepo[], repo: string): RemoteRepo[] => list.filter((r) => !sameRepo(r.repo, repo));

/**
 * Fold one lookup answer into an entry. A failure never removes anything:
 * `unreachable` keeps the last counts, `no-access` shows a chip, and only the
 * SECOND consecutive `not-found` marks the repository gone (the first is read
 * as GitHub being unsure, since it also answers 404 to a private repo it hides).
 */
export function mergeAnswer(r: RemoteRepo, a: LookupAnswer, now: number): RemoteRepo {
  if (a.found) {
    const { gone: _g, noAccess: _n, missedOnce: _m, ...rest } = r;
    return { ...rest, repo: a.repo, lastSeen: now, private: a.private, ...(a.openPrs !== undefined ? { openPrs: a.openPrs } : {}) };
  }
  if (a.error === "not-found") return r.missedOnce || r.gone ? { ...r, gone: true, missedOnce: true } : { ...r, missedOnce: true };
  if (a.error === "no-access") return { ...r, noAccess: true };
  return r;
}

/** How a row is drawn. `unreachable` is a property of the last refresh, so it is passed in. */
export type RowState = "ok" | "checking" | "unreachable" | "gone" | "no-access";
export function rowState(r: RemoteRepo, checking: boolean, unreachable: boolean): RowState {
  if (r.gone) return "gone";
  if (checking) return "checking";
  if (r.noAccess) return "no-access";
  return unreachable ? "unreachable" : "ok";
}

/** The answer card: one fixed slot, so exactly one of these is drawn. */
export type CardState =
  | "empty" | "only-github" | "checking" | "found" | "not-found" | "no-access"
  | "not-signed-in" | "gh-missing" | "unreachable" | "already" | "full";

export type Lookup = { phase: "idle" } | { phase: "checking" } | { phase: "done"; answer: LookupAnswer };

export function cardState(p: Parsed, lookup: Lookup, list: readonly RemoteRepo[]): CardState {
  if (p.kind === "other-host") return "only-github";
  if (p.kind !== "repo") return "empty";
  if (findRemote(list, p.repo)) return "already";
  if (lookup.phase !== "done") return lookup.phase === "checking" ? "checking" : "empty";
  const a = lookup.answer;
  if (a.found) return isFull(list) ? "full" : "found";
  switch (a.error) {
    case "not-found": return "not-found";
    case "no-access": return "no-access";
    case "gh-not-signed-in": return "not-signed-in";
    case "gh-missing": return "gh-missing";
    default: return "unreachable";
  }
}

/** Add stays disabled until the card says `found`. */
export const canAdd = (s: CardState): boolean => s === "found";

/** Why Add repo is off, said on the button's tooltip; "" when it is on. */
export function addReason(s: CardState): string {
  switch (s) {
    case "found": return "";
    case "not-found": return "Pick a repository that exists";
    case "no-access": return "GitHub must allow reading this repo first";
    case "unreachable": return "Needs a connection to look up the repo";
    case "already": return "Already on your list";
    case "checking": return "Looking the repository up…";
    case "not-signed-in": return "Sign in to GitHub first";
    case "gh-missing": return "Install the GitHub CLI first";
    case "full": return "The list is full: forget one first";
    case "only-github": return "Only github.com repositories";
    default: return "Type owner/repo or paste a link";
  }
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const ok = (r: unknown): r is RemoteRepo =>
  !!r && typeof r === "object"
  && typeof (r as RemoteRepo).repo === "string" && /^[^/]+\/[^/]+$/.test((r as RemoteRepo).repo)
  && Number.isFinite((r as RemoteRepo).addedAt) && Number.isFinite((r as RemoteRepo).lastSeen);

let cache: RemoteRepo[] | null = null;
let tickCache: string[] | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function remoteRepos(): RemoteRepo[] {
  if (cache) return cache;
  let raw: unknown = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* corrupt */ }
  cache = Array.isArray(raw) ? raw.filter(ok).slice(0, REMOTE_MAX) : [];
  return cache;
}

export function tickedRemotes(): string[] {
  if (tickCache) return tickCache;
  let raw: unknown = null;
  try { raw = JSON.parse(localStorage.getItem(TICK_KEY) || "null"); } catch { /* corrupt */ }
  const known = remoteRepos();
  tickCache = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && !!findRemote(known, s)) : [];
  return tickCache;
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? []));
    localStorage.setItem(TICK_KEY, JSON.stringify(tickCache ?? []));
  } catch { /* private mode: the list lasts until reload */ }
  emit();
}

export function subscribeRemotes(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

export function saveRemotes(list: RemoteRepo[]): void {
  cache = list;
  tickCache = tickedRemotes().filter((t) => findRemote(list, t));
  persist();
}

export function tickRemote(repo: string, on: boolean): void {
  const rest = tickedRemotes().filter((t) => !sameRepo(t, repo));
  tickCache = on ? [...rest, repo] : rest;
  persist();
}

/** Forget removes the entry and its tick. Pins on the repo are a separate thing and stay. */
export function forgetRemoteStored(repo: string): void {
  saveRemotes(forgetRemote(remoteRepos(), repo));
}

/** Test seam: drop the in-memory copy so the next read goes to storage. */
export function resetRemoteCache(): void { cache = null; tickCache = null; }

// ---------------------------------------------------------------------------
// two one-slot requests, the shape of prJump.ts
//
// The thing asking (the picker, the read-only strip) is not the thing that
// acts (the PR panel, the picker again), and either may not be mounted yet.
// ---------------------------------------------------------------------------

type Slot = { repo: string; n: number };
let openWanted: Slot | null = null;
let cloneWanted: Slot | null = null;
let seq = 0;
const slotSubs = new Set<() => void>();
export const subscribeSlots = (f: () => void): (() => void) => { slotSubs.add(f); return () => { slotSubs.delete(f); }; };

/** "Show this repository's pull requests", read-only. The panel clears it once it has acted. */
export const requestRemoteOpen = (repo: string): void => { openWanted = { repo, n: ++seq }; slotSubs.forEach((f) => f()); };
export const remoteOpenRequest = (): Slot | null => openWanted;
export const clearRemoteOpen = (): void => { openWanted = null; slotSubs.forEach((f) => f()); };

/** "Clone to work on it": the picker opens its clone page with this repository filled in. */
export const requestClone = (repo: string): void => { cloneWanted = { repo, n: ++seq }; slotSubs.forEach((f) => f()); };
export const cloneRequest = (): Slot | null => cloneWanted;
export const clearCloneRequest = (): void => { cloneWanted = null; slotSubs.forEach((f) => f()); };

// ---------------------------------------------------------------------------
// decisions pulled out of the screens, so a test can reach them
// ---------------------------------------------------------------------------

/** The borrowed-repository state of the PR panel: where it is, and the way back (none when nothing local exists). */
export type Away = { root: string; repo: string; back: { root: string; repo: string } | null } | null;

/**
 * What picking `r` in the PR panel does. A `gh:` root is valid with no local
 * project at all (`local` null): the way back is then null and the strip offers
 * none. A local root ends any loan. `away` is what is borrowed now, so a second
 * remote keeps the first one's way back.
 */
export function pickedRoot(r: string, away: Away, local: { root: string; repo: string } | null): { away: Away; root: string } {
  if (!r.startsWith("gh:")) return { away: null, root: r };
  return { away: { root: r, repo: r.slice(3), back: away ? away.back : local }, root: r };
}

/** The root the Open projects dialog's "open this repository" request points the panel at; needs nothing local. */
export const wantedRemoteRoot = (want: { repo: string } | null): string | null => (want ? `gh:${want.repo}` : null);

/** The first-run hero ("Add the folder your projects live in") is for a machine with nothing — a ticked-able remote is something. */
export const showFirstRunHero = (isFirstRun: boolean, remoteCount: number): boolean => isFirstRun && remoteCount === 0;

/** The "On GitHub" shelf shows as soon as the list is read, first run or not, when it has a row. */
export const showRemoteShelf = (listLoaded: boolean, shownCount: number): boolean => listLoaded && shownCount > 0;

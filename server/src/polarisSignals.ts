/*
 * The three read-only lines the Signals door puts on an item: a tracker card that
 * has not moved, two open pull requests changing the same files, and what a bot
 * review said about the head commit.
 *
 * None of them acts, none changes a verdict, and all of them read: the card state
 * comes from the tracker integration's own cache, the overlap from git objects
 * already fetched into this checkout, and the bot verdict from three GitHub lists (each followed up to five pages)
 * of the head commit. The card side is the one with a budget: one pass per
 * tracker per five minutes — one saved ClickUp view, every saved Jira view —
 * never one per card, and the counter here proves it.
 */
import type { PolarisItem, PolarisSignal } from "../../shared/polaris.ts";
import { ASSIGNED_VIEW_ID, type SavedView } from "../../shared/providers.ts";
import type { JiraCreds } from "./jira.ts";
import { cardIdDigits, mentionsCardId } from "../../shared/cardRef.ts";
import { gitAsync } from "./git.ts";
import { gh, repoIdFor } from "./prs.ts";

const DAY_MS = 24 * 60 * 60_000;
/** A card that is not done and that nobody has touched for this long is stale. */
export const STALE_CARD_DAYS = 7;
/** One pass per tracker per window, whatever the number of cards or pull requests. */
export const CARD_TTL_MS = 5 * 60_000;
/** A bot review read for a head commit is not repeated within this window. */
export const BOT_TTL_MS = 5 * 60_000;

/** The card fields a signal needs, cut from a ProviderTask so this file does not import the tracker clients. */
export interface CardState { id: string; customId?: string; title: string; status: string; statusKind: "open" | "done" | "other"; updated: number; url?: string; /** Set for Jira, absent for ClickUp so every reading of a ClickUp card stays what it was. */ tracker?: "jira" }
export const BOT_LABELS = ["blocker", "major", "minor", "nit"] as const;
export type BotLabel = (typeof BOT_LABELS)[number];
export type BotCounts = Record<BotLabel, number>;

/** The tracker reads this process made, for the budget line in the docs and a test. */
const stats = { requests: 0, cacheHits: 0 };
export const __signalStats = (): { requests: number; cacheHits: number } => ({ ...stats });
let lastCardRead = 0;
const botRead = new Map<string, { at: number; counts: BotCounts }>();

export function __resetSignals(): void {
  stats.requests = 0;
  stats.cacheHits = 0;
  lastCardRead = 0;
  botRead.clear();
}

/**
 * The words a bot review used as labels, one per line that starts with one.
 * "Blocker: the migration runs twice", "[major]", "**Nit:** spacing": a label.
 * The same word inside a sentence is prose and is not counted.
 */
export function botLabels(text: string): BotLabel[] {
  const out: BotLabel[] = [];
  for (const line of text.split("\n")) {
    // A bracketed word is a label whatever follows it; otherwise the label has to stand at the line's start and be followed by a colon or the end.
    const said = /^\s*(?:[-*+]\s+)?\[(blocker|major|minor|nit)\]/i.exec(line)
      ?? /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*(blocker|major|minor|nit)\s*(?:\*\*|__)?\s*(?::|$)/i.exec(line);
    if (said) out.push(said[1]!.toLowerCase() as BotLabel);
  }
  return out;
}

export const botCounts = (said: readonly BotLabel[]): BotCounts => {
  const counts: BotCounts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const l of said) counts[l]++;
  return counts;
};

/** "bot review on head: 1 blocker, 3 major", or null when the review carried no label. */
export function botVerdictLine(counts: BotCounts): string | null {
  const said = BOT_LABELS.filter((l) => counts[l] > 0).map((l) => `${counts[l]} ${l}`);
  return said.length ? `bot review on head: ${said.join(", ")}` : null;
}

/** The card a pull request names, when it is not done and has not moved for STALE_CARD_DAYS. */
export function staleCardOf(item: Pick<PolarisItem, "title" | "head">, cards: readonly CardState[], now = Date.now()): PolarisSignal | null {
  const said = `${item.head} ${item.title}`;
  const named = cards.filter((card) => {
    if (card.statusKind === "done") return false;
    const digits = cardIdDigits(card.customId ?? card.id);
    return !!digits && mentionsCardId(said, digits);
  });
  /* A migrated pull request names a ClickUp id and a Jira key, and the digits
     are the same in both. The Jira card is THE card (the Jira-first rule), so
     the line is about it even when the ClickUp one is the older, staler story. */
  const card = named.find((c) => c.tracker === "jira") ?? named[0];
  if (!card) return null;
  const id = card.customId ?? card.id;
  const days = Math.floor((now - card.updated) / DAY_MS);
  if (days < STALE_CARD_DAYS) return null;
  return { kind: "staleCard", text: `Card ${id} has not moved for ${days} day${days === 1 ? "" : "s"}.` };
}

/** "Overlaps #12 in a.ts, b.ts. Merging both would conflict." A null merge says only which files are shared. */
export function overlapLine(other: number, files: readonly string[], conflict: boolean | null): string {
  const listed = files.length > 3 ? `${files.slice(0, 3).join(", ")} and ${files.length - 3} more` : files.join(", ");
  const merge = conflict === true ? " Merging both would conflict." : conflict === false ? " Merging both is clean." : "";
  return `Overlaps #${other} in ${listed}.${merge}`;
}

export interface SignalSources {
  /** Null or absent when no tracker is configured: then there is no card signal at all. */
  cards?: readonly CardState[] | null;
  /** Already-worded overlap lines, keyed by the pull request number they belong to. */
  overlaps?: ReadonlyMap<number, string[]>;
  /** Bot counts per pull request number. */
  bots?: ReadonlyMap<number, BotCounts>;
}

function linesOf(item: PolarisItem, src: SignalSources, now: number): PolarisSignal[] {
  const out: PolarisSignal[] = [];
  if (src.cards) {
    const stale = staleCardOf(item, src.cards, now);
    if (stale) out.push(stale);
  }
  for (const text of src.overlaps?.get(item.number) ?? []) out.push({ kind: "overlap", text });
  const counts = src.bots?.get(item.number);
  if (counts) {
    const said = botVerdictLine(counts);
    if (said) out.push({ kind: "botVerdict", text: said });
  }
  return out;
}

/**
 * The same items with their signal lines. `cls`, `reason` and `sentence` are copied
 * untouched: a signal says one more thing about an item, it never re-files it.
 */
export function withSignals(items: readonly PolarisItem[], src: SignalSources, now = Date.now()): PolarisItem[] {
  return items.map((item) => {
    const signals = linesOf(item, src, now);
    return signals.length ? { ...item, signals } : item;
  });
}

// ── the live reads ──

const card = (t: { id: string; customId?: string; title: string; status: string; statusKind: "open" | "done" | "other"; updated: number; url?: string }, tracker?: "jira"): CardState => ({
  id: t.id, ...(t.customId ? { customId: t.customId } : {}), title: t.title, status: t.status, statusKind: t.statusKind, updated: t.updated, ...(t.url ? { url: t.url } : {}), ...(tracker ? { tracker } : {}),
});

/**
 * The cards of the tracker this app is connected to.
 *
 * Served from the integration's own cache when it is fresh, or when this process
 * asked recently; otherwise one list per connected tracker, never one per card.
 * No tracker configured reads as null, which means no signal.
 * `source` is the live wiring, replaced in a test so the budget can be measured.
 */
export async function trackerCards(source?: TrackerSource): Promise<CardState[] | null> {
  const src = source ?? await liveTrackerSource();
  if (!src.clickup && !src.jira) return null;
  const now = src.now ?? Date.now();
  const newest = Math.max(0, ...src.cached.map((c) => c.at));
  if ((newest && now - newest < CARD_TTL_MS) || now - lastCardRead < CARD_TTL_MS) {
    stats.cacheHits++;
    return src.cached.flatMap((c) => c.cards);
  }
  lastCardRead = now;
  const reads = [src.readClickup, src.readJira].filter((r): r is () => Promise<CardState[] | null> => !!r);
  const answered = await Promise.all(reads.map((r) => r()));
  stats.requests += reads.length;
  // A read that answered, even with no cards, is an answer; only every read refusing falls back to the cache.
  return answered.some((c) => c) ? answered.flatMap((c) => c ?? []) : src.cached.flatMap((c) => c.cards);
}

/** What a card read needs from the rest of the app: two configured trackers, their caches, and the one read each offers. */
export interface TrackerSource {
  clickup: boolean;
  jira: boolean;
  /** What the integrations already hold, newest first by `at`. */
  cached: { at: number; cards: CardState[] }[];
  readClickup?: () => Promise<CardState[] | null>;
  readJira?: () => Promise<CardState[] | null>;
  now?: number;
}

/** The live wiring: the credentials this app holds, the cached views, and the read each tracker offers. */
async function liveTrackerSource(): Promise<TrackerSource> {
  const [{ secretFor }, { storedCreds }, clickupViews] = await Promise.all([
    import("./credentials.ts"), import("./jira.ts"), import("./clickupviews.ts"),
  ]);
  const clickup = secretFor("clickup");
  const jira = storedCreds();
  const jiraViews = await import("./jiraviews.ts");
  const cached = [...cachedClickup(clickupViews), ...cachedJira(jiraViews, jira?.site)];
  const view = clickup ? (clickupViews.savedViews().find((v) => !v.builtin && v.id) ?? clickupViews.savedViews().find((v) => !v.builtin)) : undefined;
  const jiraViewsToRead = jira ? jiraCardViews(jiraViews.savedViews(jira.site)) : [];
  return {
    clickup: !!clickup, jira: !!jira, cached,
    ...(view ? { readClickup: async () => (await (await import("./providers.ts")).readView(view.id)).tasks.map((t) => card(t)) } : {}),
    ...(jira && jiraViewsToRead.length ? { readJira: () => readJiraCards(jira, jiraViewsToRead) } : {}),
  };
}

/**
 * The saved Jira views a live card read asks.
 *
 * Every one a person saved, because reading one board is how a card that lives
 * on any other was only ever found in the cache — and then only until the cache
 * was old. The pinned "assigned to me" search is left out: its rows are already
 * the person's own, and it is not a view anybody saved. A view that names
 * something Jira refuses (a filter that is gone) answers nothing and the rest
 * still count.
 */
export function jiraCardViews(views: readonly SavedView[]): SavedView[] {
  return views.filter((v) => v.id !== ASSIGNED_VIEW_ID);
}

/** One read per saved view, in parallel, as one answer: the same card on two boards counts once. */
async function readJiraCards(jira: JiraCreds, views: readonly SavedView[]): Promise<CardState[] | null> {
  const { readViewNow } = await import("./jiraboards.ts");
  const answers = await Promise.all(views.map((v) => readViewNow(jira, v)));
  if (!answers.some((r) => r.ok && r.data)) return null;
  const seen = new Set<string>();
  const out: CardState[] = [];
  for (const r of answers) {
    for (const t of r.ok && r.data ? r.data.tasks : []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(card(t, "jira"));
    }
  }
  return out;
}

function cachedClickup(v: typeof import("./clickupviews.ts")): { at: number; cards: CardState[] }[] {
  return v.savedViews().flatMap((view) => {
    const held = v.cachedFor(view.id);
    return held ? [{ at: held.at, cards: held.tasks.map((t) => card(t)) }] : [];
  });
}

function cachedJira(v: typeof import("./jiraviews.ts"), site: string | undefined): { at: number; cards: CardState[] }[] {
  if (!site) return [];
  return v.savedViews(site).flatMap((view) => {
    const held = v.cachedFor(site, view.id);
    return held ? [{ at: held.at, cards: held.tasks.map((t) => card(t, "jira")) }] : [];
  });
}

/** One open pull request as an overlap row: `headSha` is the head GitHub reported, and the commit the files are read from. */
export interface OverlapRow { number: number; head: string; base: string; headSha?: string }

/**
 * A ref as this checkout has it, local or from origin. Null when neither exists: no signal is invented from a branch nobody fetched.
 * Awaited, not blocking: this runs once per pull request on every items read.
 */
async function resolve(root: string, ref: string): Promise<string | null> {
  for (const name of [ref, `origin/${ref}`]) {
    const r = await gitAsync(root, ["rev-parse", "--verify", `${name}^{commit}`]);
    if (r.code === 0) return r.stdout.trim();
  }
  return null;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
/** A name `rev-parse` reads only from the ref store: no `~^:@`, no `*_HEAD` file at the top of `.git`, nothing that could be a short SHA. */
const PLAIN_REF = /^(?![0-9a-f]{4,40}$)(?!.*\.\.)[\w][\w./-]*$/;
/**
 * Every ref and every reported head SHA in two `git` calls, for the whole list:
 * `resolve` above is up to four `rev-parse` per pull request, so thirty open
 * PRs were a hundred spawns of the ~1 GB server per items read (each fork is a
 * stall under memory pressure, audit 17). Answers `rev-parse`'s own DWIM order
 * (<n> itself, refs/<n>, tags, heads, remotes, remotes/<n>/HEAD; then the same for
 * `origin/<n>`). Undefined from the lookup sends that one name back to
 * `resolve`; null from this function means the batch failed, and every name does.
 */
async function knownRefs(root: string, shas: string[]): Promise<((ref: string) => string | null | undefined) | null> {
  const refs = await gitAsync(root, ["for-each-ref", "--format=%(objectname) %(*objectname) %(refname)"]);
  if (refs.code !== 0) return null;
  const byName = new Map<string, string>();
  for (const line of refs.stdout.split("\n")) {
    const [obj, peeled, name] = line.split(" ");
    if (obj && name) byName.set(name, peeled || obj);
  }
  // `--no-walk` lists the given commits only; `--ignore-missing` drops a head this checkout never fetched.
  const have = new Set<string>();
  const wanted = [...new Set(shas)];
  if (wanted.length) {
    const r = await gitAsync(root, ["rev-list", "--no-walk", "--ignore-missing", ...wanted]);
    if (r.code !== 0) return null;
    for (const l of r.stdout.split("\n")) if (l.trim()) have.add(l.trim());
  }
  const dwim = (n: string) => [n, `refs/${n}`, `refs/tags/${n}`, `refs/heads/${n}`, `refs/remotes/${n}`, `refs/remotes/${n}/HEAD`]
    .map((k) => byName.get(k)).find(Boolean);
  return (ref) => {
    if (FULL_SHA.test(ref)) return wanted.includes(ref) ? (have.has(ref) ? ref : null) : undefined;
    if (!PLAIN_REF.test(ref) || /^[A-Z_]*HEAD$/.test(ref)) return undefined;
    return dwim(ref) ?? dwim(`origin/${ref}`) ?? null;
  };
}

/**
 * Two open pull requests changing the same files, and whether merging both would
 * conflict. Local git only: the head commits this checkout already has, and the
 * merge is `git merge-tree` between two commits, never a network call.
 *
 * The head is resolved by the SHA GitHub reported, not the branch name: a local
 * branch left behind would speak for a commit that is no longer the head.
 */
export async function overlapSignals(root: string, rows: readonly OverlapRow[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const batch = await knownRefs(root, rows.map((r) => r.headSha).filter((s): s is string => !!s && FULL_SHA.test(s)));
  const look = (ref: string) => { const hit = batch?.(ref); return hit === undefined ? resolve(root, ref) : hit; };
  const answers = await Promise.all(rows.map(async (r) => {
    const [head, base] = await Promise.all([look(r.headSha || r.head), look(r.base)]);
    if (!head || !base) return null;
    return { ...r, head, base, files: await changedFiles(root, base, head) };
  }));
  const known = answers.filter((r): r is { number: number; head: string; base: string; files: string[] } => !!r && r.files.length > 0);
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      const a = known[i]!, b = known[j]!;
      const shared = a.files.filter((f) => b.files.includes(f));
      if (!shared.length) continue;
      const conflict = await conflicts(root, a.head, b.head);
      out.set(a.number, [...(out.get(a.number) ?? []), overlapLine(b.number, shared, conflict)]);
      out.set(b.number, [...(out.get(b.number) ?? []), overlapLine(a.number, shared, conflict)]);
    }
  }
  return out;
}

/**
 * The files a head changes against a base. The same tree gives the same answer
 * every time, so it is kept per checkout and pair of commits like the merge:
 * a poll that changes nothing costs no `git diff`. Only a read that answered is
 * kept, so a transient failure is asked again next time.
 */
const changedCache = new Map<string, string[]>();

async function changedFiles(root: string, base: string, head: string): Promise<string[]> {
  const key = `${root}\0${base}\0${head}`;
  const kept = changedCache.get(key);
  if (kept) return kept;
  const r = await gitAsync(root, ["diff", "--name-only", `${base}...${head}`]);
  if (r.code !== 0) return [];
  const files = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  changedCache.set(key, files);
  return files;
}

/**
 * The merge of two commits is the same tree every time, so its answer is kept per
 * checkout and pair of commits: a poll that changes nothing costs no `git` call.
 * One entry per pair this project has seen; never pruned, which is the ceiling.
 *
 * The promise is what is kept, so two reads that overlap share one merge.
 *
 * Awaited, never the blocking `git`. Every pair of open pull requests that
 * share a file is one merge, and on a repository with thirty of them the
 * blocking version was thirty merges back to back on the server's only
 * thread. Measured on the running app with a sampler of the server's git
 * children: 28 `merge-tree` in a row at ~280 ms each, one stall of 8467 ms,
 * and 5044 ms again seven seconds later; every terminal stopped echoing for
 * both. It came back after each restart (the cache is memory) and each time a
 * head moved (new pairs). The merges still cost what they cost, now behind
 * the spawn pool with the loop free between them.
 */
const mergeCache = new Map<string, Promise<boolean | null>>();

/** Whether merging the two heads conflicts; null when this git has no such answer. */
function conflicts(root: string, a: string, b: string): Promise<boolean | null> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const key = `${root}\0${lo}\0${hi}`;
  const kept = mergeCache.get(key);
  if (kept) return kept;
  const answer = gitAsync(root, ["merge-tree", "--write-tree", a, b]).then((r) =>
    // An older git refuses the option instead of answering; that is not a conflict.
    r.code === 0 ? false : r.code === 1 && !/usage:|unknown option/i.test(r.stderr) ? true : null);
  mergeCache.set(key, answer);
  return answer;
}

/** One gh read of a JSON body: null when gh refused it or the answer was not JSON, so a refused read is never read as an empty one. */
async function ghJson(run: typeof gh, root: string, path: string): Promise<unknown> {
  const r = await run(["api", path], root);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** GitHub's page size, and how many pages of one list a read follows before it calls the answer cut short. */
export const PAGE_SIZE = 100;
export const PAGE_CAP = 5;

/**
 * One list read, page by page. `complete` is false when a page was refused or when
 * the cap was reached with the last page full: only a short last page says the list ended.
 */
async function ghPages(run: typeof gh, root: string, path: string, pick: (body: unknown) => unknown[] | null): Promise<{ rows: unknown[]; complete: boolean }> {
  const rows: unknown[] = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const body = await ghJson(run, root, `${path}?per_page=${PAGE_SIZE}&page=${page}`);
    if (body === null) return { rows, complete: false };
    const got = pick(body);
    if (!got) return { rows, complete: false };
    rows.push(...got);
    if (got.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

const loginOf = (row: { user?: { login?: string } }): string => (row.user?.login ?? "").toLowerCase();

/**
 * The labels a bot left on this head commit, from review comments, PR review
 * bodies and check-run summaries, counting only the logins in the setting. No
 * login configured reads nothing; a head already read recently answers from
 * memory, but only a read where all three lists were read to the end is kept.
 */
export async function botVerdict(root: string, number: number, headSha: string, bots: readonly string[], run: typeof gh = gh): Promise<BotCounts | null> {
  if (!bots.length || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  // The login list is part of the key: an edited list must not read the previous list's answer.
  const wanted = new Set(bots.map((b) => b.toLowerCase()));
  const key = `${root}\0${number}\0${headSha}\0${[...wanted].sort().join(",")}`;
  const hit = botRead.get(key);
  const now = Date.now();
  if (hit && now - hit.at < BOT_TTL_MS) return hit.counts;
  const repo = await repoIdFor(root);
  if (!repo) return null;
  const said: BotLabel[] = [];

  const comments = await ghPages(run, root, `repos/${repo.nameWithOwner}/pulls/${number}/comments`, (b) => (Array.isArray(b) ? b : null));
  for (const c of comments.rows as { body?: string; commit_id?: string; user?: { login?: string } }[]) {
    if (c.commit_id === headSha && wanted.has(loginOf(c))) said.push(...botLabels(c.body ?? ""));
  }

  // A review body is where a bot usually puts "Blocker:"; it names the commit it reviewed.
  const reviews = await ghPages(run, root, `repos/${repo.nameWithOwner}/pulls/${number}/reviews`, (b) => (Array.isArray(b) ? b : null));
  for (const r of reviews.rows as { body?: string; commit_id?: string; user?: { login?: string } }[]) {
    if (r.commit_id === headSha && wanted.has(loginOf(r))) said.push(...botLabels(r.body ?? ""));
  }

  const checks = await ghPages(run, root, `repos/${repo.nameWithOwner}/commits/${headSha}/check-runs`, (b) => {
    const runs = b && typeof b === "object" ? (b as { check_runs?: unknown }).check_runs : null;
    return Array.isArray(runs) ? runs : null;
  });
  for (const r of checks.rows as { name?: string; head_sha?: string; app?: { slug?: string }; output?: { summary?: string; text?: string } }[]) {
    if (r.head_sha !== headSha) continue;
    if (!wanted.has((r.app?.slug ?? "").toLowerCase()) && !wanted.has((r.name ?? "").toLowerCase())) continue;
    said.push(...botLabels(r.output?.summary ?? ""), ...botLabels(r.output?.text ?? ""));
  }

  const counts = botCounts(said);
  if (comments.complete && reviews.complete && checks.complete) botRead.set(key, { at: now, counts });
  return counts;
}

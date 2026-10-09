/*
 * GitHub's notification inbox, as this app's own list.
 *
 * The pull-request board answers "what wants something from me", which is a
 * question about STATE: who is blocked, what is green, what is behind. The
 * inbox answers a different one — "what happened while I was away" — and it is
 * the only surface that knows about a mention in a comment, a review somebody
 * asked for an hour ago, or an issue that is not a pull request at all. Until
 * now that meant leaving for the browser, which is what this app exists to
 * avoid.
 *
 * Read through `gh api`, like everything else here, so it inherits the token
 * and the login already set up rather than asking for a second one.
 *
 * What this deliberately does NOT do is mirror every button GitHub's page has.
 * "Saved" and "Done" are stored on their side of a web-only feature with no
 * REST verb; what the API gives — read, unread, unsubscribe, mark a repository
 * read — is what this offers, and nothing here pretends otherwise.
 */
import { gh } from "./prs.ts";
import { withTurns } from "./ghinbox-turn.ts";
import type { InboxItem } from "../../shared/types.ts";

export type { InboxItem };

/** GitHub's shape, as much of it as this reads. */
interface RawNote {
  id?: string;
  unread?: boolean;
  reason?: string;
  updated_at?: string;
  last_read_at?: string | null;
  repository?: { full_name?: string };
  subject?: { title?: string; url?: string; type?: string };
}

/** The number at the end of `.../pulls/17629` or `.../issues/18`. Null for a
 *  subject that has none — a release, a check suite — which is a row that can
 *  still be read and marked, just not opened here. */
export function numberFromUrl(url: string | undefined): number | undefined {
  const m = /\/(?:pulls|issues)\/(\d+)(?:$|[?#])/.exec(url ?? "");
  return m ? Number(m[1]) : undefined;
}

export function toItem(raw: RawNote): InboxItem | null {
  const id = String(raw.id ?? "");
  const title = raw.subject?.title ?? "";
  if (!id || !title) return null;
  return {
    id,
    unread: raw.unread !== false,
    reason: raw.reason ?? "subscribed",
    type: raw.subject?.type ?? "",
    repo: raw.repository?.full_name ?? "",
    title,
    at: Date.parse(raw.updated_at ?? "") || 0,
    ...(numberFromUrl(raw.subject?.url) !== undefined ? { number: numberFromUrl(raw.subject?.url) } : null),
  };
}

export interface InboxPage {
  ok: boolean;
  items: InboxItem[];
  /** When this was read, so the panel can say how old it is. */
  at: number;
  error?: string;
}

/*
 * Cached, because this is polled.
 *
 * The notifications endpoint carries a `X-Poll-Interval` header and asks for
 * sixty seconds between calls; it also answers 304 against `If-None-Match`
 * without counting against the rate limit. The panel polls every 60 s and the
 * old 45 s TTL was shorter than that, so 12 of 12 polls measured spawned `gh`
 * for an unchanged list. The TTL is now longer than the poll (a second poll
 * inside it is free), and past it the read is conditional: a 304 keeps the
 * list we hold and costs a spawn but no quota and no parse.
 *
 * The ceiling: a notification can be up to TTL_MS old on screen. A write here
 * drops the cache, and `force` still asks the API outright.
 */
const TTL_MS = 90_000;
let cache: { at: number; all: boolean; page: InboxPage; etag: string; lastRead: Map<string, number>; pending: boolean } | null = null;

export function __resetInbox(): void { cache = null; }

/** The page with what waits on the person added — see ghinbox-turn.ts. Rows
 *  already answered cost nothing, so this runs on every read of the cache:
 *  it is how a question that failed is asked again without a new list. */
async function withTurn(c: NonNullable<typeof cache>): Promise<InboxPage> {
  if (!c.page.items.length) { c.pending = false; return c.page; }
  const r = await withTurns(c.page.items, c.lastRead);
  c.pending = r.pending;
  c.page = { ...c.page, items: r.items };
  return c.page;
}

/** `gh api -i` prints the status line and headers, a blank line, then the body. */
export function splitIncluded(out: string): { status: number; etag: string; body: string } {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(out);
  if (!m) return { status: 0, etag: "", body: out };
  const cut = out.search(/\r?\n\r?\n/);
  const head = cut < 0 ? out : out.slice(0, cut);
  const body = cut < 0 ? "" : out.slice(cut).replace(/^\r?\n\r?\n/, "");
  const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? "";
  return { status: Number(m[1]), etag, body };
}

/**
 * The inbox.
 *
 * `all` is the API's own flag: false gives only what is unread, true gives the
 * recent history too. The panel asks for everything and filters on this side —
 * switching between All and Unread is a tab, and a tab that costs a network
 * call reads as broken.
 */
export async function inbox(all = true, force = false): Promise<InboxPage> {
  const same = cache && cache.all === all ? cache : null;
  if (same && !force && Date.now() - same.at < TTL_MS) return same.pending ? withTurn(same) : same.page;
  const args = ["api", "-i", `/notifications?all=${all ? "true" : "false"}&per_page=50`];
  if (same?.etag && !force) args.splice(2, 0, "-H", `If-None-Match: ${same.etag}`);
  const r = await gh(args);
  const got = splitIncluded(r.stdout);
  // "Not modified" is the answer, not a failure: gh exits non-zero on a 304.
  if (same && (got.status === 304 || /HTTP 304/.test(r.stderr))) {
    cache = { ...same, at: Date.now() };
    return cache.pending ? withTurn(cache) : cache.page;
  }
  if (r.code !== 0) {
    // The last good answer beats an empty list: an inbox that empties itself
    // when the network hiccups reads as "you are all caught up".
    if (cache) return { ...cache.page, error: r.stderr.trim() || "GitHub did not answer" };
    return { ok: false, items: [], at: Date.now(), error: r.stderr.trim() || "GitHub did not answer" };
  }
  let raw: RawNote[] = [];
  try { raw = JSON.parse(got.body) as RawNote[]; } catch { raw = []; }
  const page: InboxPage = {
    ok: true,
    items: raw.map(toItem).filter((x): x is InboxItem => !!x).sort((a, b) => b.at - a.at),
    at: Date.now(),
  };
  cache = {
    at: Date.now(), all, page, etag: got.etag,
    // Until the question has been asked: a second read during it must join it, not return bare rows.
    pending: true,
    lastRead: new Map(raw.map((n) => [String(n.id ?? ""), Date.parse(n.last_read_at ?? "") || 0])),
  };
  return withTurn(cache);
}

export interface InboxWrite { ok: boolean; error?: string }

const wrote = (r: { code: number; stderr: string }): InboxWrite =>
  r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || "GitHub refused that" };

/** Mark one thread read. The list is re-read rather than patched here: a write
 *  that answers with its own idea of the new state is a second source of truth
 *  for something one call can settle. */
export async function markRead(id: string): Promise<InboxWrite> {
  if (!/^\d+$/.test(id)) return { ok: false, error: "that is not a thread id" };
  const r = await gh(["api", "-X", "PATCH", `/notifications/threads/${id}`]);
  __resetInbox();
  return wrote(r);
}

/** Stop following a thread — GitHub's "unsubscribe", which is the only way to
 *  make a noisy thread stop coming back after every comment. */
export async function unsubscribe(id: string): Promise<InboxWrite> {
  if (!/^\d+$/.test(id)) return { ok: false, error: "that is not a thread id" };
  const r = await gh(["api", "-X", "DELETE", `/notifications/threads/${id}/subscription`]);
  // Unsubscribing does not mark it read, and leaving it unread means it sits
  // there for ever with nothing left to say. Both, in the order GitHub's own
  // page does them.
  if (r.code === 0) await gh(["api", "-X", "PATCH", `/notifications/threads/${id}`]);
  __resetInbox();
  return wrote(r);
}

/**
 * Everything in one repository, read.
 *
 * The button people actually want after a fortnight away, and the reason it is
 * per-repository rather than global: "mark all as read" across every repo you
 * watch is a decision nobody can take back, and this app is used with a work
 * repository and a personal one open at once.
 */
export async function markRepoRead(repo: string): Promise<InboxWrite> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: "that is not a repository" };
  const r = await gh(["api", "-X", "PUT", `/repos/${repo}/notifications`]);
  __resetInbox();
  return wrote(r);
}

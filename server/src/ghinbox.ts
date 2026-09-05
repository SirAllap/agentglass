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
import type { InboxItem } from "../../shared/types.ts";

export type { InboxItem };

/** GitHub's shape, as much of it as this reads. */
interface RawNote {
  id?: string;
  unread?: boolean;
  reason?: string;
  updated_at?: string;
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
 * GitHub's notifications endpoint carries a `X-Poll-Interval` header and asks
 * for sixty seconds between calls; it also answers 304 against `If-Modified-
 * Since` for free. `gh api` hides both, so the cheap version of respecting them
 * is a TTL of our own — and one shared answer for however many surfaces ask.
 */
const TTL_MS = 45_000;
let cache: { at: number; all: boolean; page: InboxPage } | null = null;

export function __resetInbox(): void { cache = null; }

/**
 * The inbox.
 *
 * `all` is GitHub's own flag: false gives only what is unread, true gives the
 * recent history too. The panel asks for everything and filters on this side —
 * switching between All and Unread is a tab, and a tab that costs a network
 * call reads as broken.
 */
export async function inbox(all = true, force = false): Promise<InboxPage> {
  const fresh = cache && cache.all === all && Date.now() - cache.at < TTL_MS;
  if (fresh && !force) return cache!.page;
  const r = await gh(["api", `/notifications?all=${all ? "true" : "false"}&per_page=50`]);
  if (r.code !== 0) {
    // The last good answer beats an empty list: an inbox that empties itself
    // when the network hiccups reads as "you are all caught up".
    if (cache) return { ...cache.page, error: r.stderr.trim() || "GitHub did not answer" };
    return { ok: false, items: [], at: Date.now(), error: r.stderr.trim() || "GitHub did not answer" };
  }
  let raw: RawNote[] = [];
  try { raw = JSON.parse(r.stdout) as RawNote[]; } catch { raw = []; }
  const page: InboxPage = {
    ok: true,
    items: raw.map(toItem).filter((x): x is InboxItem => !!x).sort((a, b) => b.at - a.at),
    at: Date.now(),
  };
  cache = { at: Date.now(), all, page };
  return page;
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

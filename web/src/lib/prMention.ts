/*
 * Where in a pull request somebody said your name.
 *
 * The inbox knows THAT you were mentioned — that is the whole of what GitHub's
 * notification carries — and opening the pull request then left you at the top
 * of a conversation with forty entries in it, looking for the one that is about
 * you. This finds it: the body, a comment, a review, or a line thread, and the
 * panel scrolls there and flashes it.
 *
 * Newest first on purpose. A long thread mentions somebody several times and
 * the one worth reading is the most recent — that is the one the notification
 * is about.
 *
 * Pure, and split from the panel, because every interesting case is a string
 * one: `@ana` must not match inside `@anabel`, a name inside a code fence is
 * code rather than a call, and a review that quotes an earlier mention should
 * not outrank the comment that actually named you.
 */

/** Anything the panel can scroll to, as little of it as this needs. */
export interface Mentionable {
  /** What the panel's `data-node` holds, when the entry has one. */
  nodeId?: string | null;
  body?: string;
  createdAt?: string;
}

export interface MentionHit {
  /** `body` for the pull request's own description; `node` for anything in the
   *  timeline; `thread` for a line comment, which the Files tab addresses by a
   *  different attribute. */
  where: "body" | "node" | "thread";
  /** The `data-node` / `data-thread` value to scroll to. Empty for the body. */
  id: string;
}

/**
 * Text with the parts that are not prose taken out.
 *
 * A fenced block, an inline span or a link's target can all contain an `@name`
 * that nobody was called by — a shell line with an email in it, a URL with a
 * user in the path. Stripping them first is cheaper and more honest than a
 * regular expression that tries to be clever about context.
 */
export function prose(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>\n]{0,200}>/g, " ");
}

/** Does this text call that login? Word-bounded, so `@ana` is not `@anabel`,
 *  and case-insensitive, because GitHub's names are. */
export function callsOut(md: string, login: string): boolean {
  const name = login.trim().replace(/^@/, "");
  if (!name) return false;
  const re = new RegExp(`(^|[^\\w/])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  return re.test(prose(md));
}

/**
 * The entry that named you, newest first.
 *
 * `body` is checked LAST rather than first: a description that says "@ana
 * please review" is true for the life of the pull request, and a notification
 * that arrived a minute ago is about something somebody just said.
 */
export function findMention(
  detail: {
    body?: string;
    comments?: Mentionable[];
    reviews?: Mentionable[];
    threads?: { id: string; comments?: { body?: string; createdAt?: string }[] }[];
  },
  login: string,
): MentionHit | null {
  const when = (x: { createdAt?: string }) => Date.parse(x.createdAt ?? "") || 0;

  const timeline = [...(detail.comments ?? []), ...(detail.reviews ?? [])]
    .filter((c) => c.body && callsOut(c.body, login))
    .sort((a, b) => when(b) - when(a));
  const first = timeline.find((c) => c.nodeId);
  if (first?.nodeId) return { where: "node", id: first.nodeId };

  const threads = (detail.threads ?? [])
    .map((t) => ({ t, hit: (t.comments ?? []).filter((c) => c.body && callsOut(c.body, login)).sort((a, b) => when(b) - when(a))[0] }))
    .filter((x) => x.hit)
    .sort((a, b) => when(b.hit!) - when(a.hit!));
  if (threads[0]) return { where: "thread", id: threads[0].t.id };

  // A mention in an entry with no node id still counts — it just cannot be
  // scrolled to, so the body is the honest place to land.
  if (timeline.length || (detail.body && callsOut(detail.body, login))) return { where: "body", id: "" };
  return null;
}

/** The selector for a hit, or null for the body — which the panel scrolls to by
 *  its own ref rather than by query. */
export function selectorFor(hit: MentionHit): string | null {
  if (hit.where === "body" || !hit.id) return null;
  const attr = hit.where === "thread" ? "data-thread" : "data-node";
  return `[${attr}="${CSS.escape(hit.id)}"]`;
}

/**
 * Where a `#discussion_r…` / `#issuecomment-…` / `#pullrequestreview-…`
 * fragment lands. GitHub's own URL for each entry ends in that fragment, so the
 * match is on the URL the panel already holds rather than on a numeric id the
 * DOM does not carry.
 *
 * A line comment goes to Files, on ITS file, only while the code under it is
 * still in the diff; an outdated one (or one on a file the diff no longer has)
 * has no row there, so it is shown in the Conversation, where every thread is.
 * Nothing found: the Conversation, with nothing to scroll to — never an
 * unrelated file. `fetched` is the comment read on its own, for one the loaded
 * threads (capped by GitHub) do not hold: it can say where, not open a thread.
 */
export interface AnchorTarget {
  tab: "files" | "conversation";
  path?: string;
  line?: number;
  /** What to scroll to: a thread (`data-thread`) or a timeline entry (`data-node`). */
  thread?: string;
  node?: string;
}

export function anchorTarget(
  detail: {
    comments?: { nodeId?: string | null; url?: string }[];
    reviews?: { nodeId?: string | null; url?: string }[];
    threads?: { id: string; path: string; line: number | null; isOutdated: boolean; comments?: { url?: string }[] }[];
    files?: { path: string }[];
  },
  anchor: string,
  fetched?: { path: string; line: number | null } | null,
): AnchorTarget {
  const is = (u?: string) => !!u && u.endsWith(`#${anchor}`);
  const inDiff = (path: string) => (detail.files ?? []).some((f) => f.path === path);
  const t = (detail.threads ?? []).find((x) => (x.comments ?? []).some((c) => is(c.url)));
  if (t) {
    return !t.isOutdated && t.line != null && inDiff(t.path)
      ? { tab: "files", path: t.path, line: t.line, thread: t.id }
      : { tab: "conversation", thread: t.id };
  }
  const node = [...(detail.comments ?? []), ...(detail.reviews ?? [])].find((c) => c.nodeId && is(c.url));
  if (node?.nodeId) return { tab: "conversation", node: node.nodeId };
  if (fetched && fetched.line != null && inDiff(fetched.path)) return { tab: "files", path: fetched.path, line: fetched.line };
  return { tab: "conversation" };
}

/**
 * Whether a pending anchor can be served now, and what is left pending.
 *
 * A link can arrive with the pull request cold (the detail loads later), cached
 * (the detail is painted straight away) or already open (the detail object does
 * not change at all). The panel calls this on every render of either input, so
 * all three starts reach the same answer: wait until the detail is THIS pull
 * request's, serve once, then nothing is pending.
 */
export function takeAnchor<T extends { number: number }>(
  want: T | null,
  detail: { number: number } | null | undefined,
): { serve: T | null; pending: T | null } {
  if (!want || !detail || detail.number !== want.number) return { serve: null, pending: want };
  return { serve: want, pending: null };
}

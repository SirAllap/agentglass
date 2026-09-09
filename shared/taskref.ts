/*
 * The work item a pull request came from, whoever tracks it.
 *
 * A pull request usually exists BECAUSE of something — a card, a ticket, an
 * issue. Standing on the pull request, that link is worth four characters of
 * chrome: it is how you tell two similarly-titled pull requests apart, and how
 * you get from a review back to what was actually asked for.
 *
 * ── it must work for somebody who has never heard of any of these ────────
 * Most people running this have no ClickUp. Some have Jira, some have Linear,
 * plenty have nothing but GitHub issues, and plenty have nothing at all. So
 * this reads what a pull request CARRIES and never assumes which product wrote
 * it, and the three answers it can give are:
 *
 *   nothing              null. No chip, no gap, no placeholder — the row is
 *                        simply one thing shorter. This is the common case and
 *                        the one that has to feel deliberate.
 *   an address           certain. The body named a tracker's own URL, and a
 *                        URL opens without anybody's credentials or setup.
 *   an id by convention  shown only when the caller says something is
 *                        connected that could resolve it, and never dressed in
 *                        a particular tracker's colours: `WEB-1042` is a shape
 *                        half the trackers in the world use, and being
 *                        confidently wrong about which one owns an id sends
 *                        people to a page that does not exist.
 *
 * ── what it deliberately does not do ─────────────────────────────────────
 * Guess a provider from the shape of an id. A tracker is named only when its
 * own address was in the body; otherwise `tracker` is null and stays null.
 */

/** The trackers whose addresses can be read without ambiguity. Not a list of
 *  what is supported — nothing here needs supporting — but of URL shapes that
 *  cannot be mistaken for somebody else's. */
export type TrackerId =
  | "clickup" | "jira" | "linear" | "shortcut" | "asana" | "trello"
  | "github" | "gitlab" | "azure";

export type Evidence = "url" | "branch" | "title";

export interface TaskRef {
  /** What the chip says, because it is what people say out loud. */
  label: string;
  /** What a finder is handed. Not always the label: an address carries an
   *  unambiguous id, and using it skips a custom-id lookup entirely. */
  query: string;
  /** Present only when the body carried a real address. Without one there is
   *  nowhere honest to send a click. */
  url?: string;
  from: Evidence;
  /** Named ONLY by its own address. Never inferred from an id's shape. */
  tracker: TrackerId | null;
}

/**
 * One tracker's address, and which capture is the item.
 *
 * Every pattern is anchored on a host AND a path segment that means "an item"
 * — `/t/`, `/browse/`, `/issue/`, `/issues/`. A host alone is not enough: a
 * link to somebody's Jira dashboard is not a ticket, and a chip that opens one
 * is a chip that lied.
 */
const ADDRESSES: { tracker: TrackerId; re: RegExp; pick?: (m: RegExpExecArray) => string }[] = [
  // Two shapes in the wild: `/t/<id>` and `/t/<team>/<id>`, the second being a
  // workspace with custom ids switched on. When there are two segments the LAST
  // is the task — the first is the workspace, and handing that to a lookup asks
  // for an item whose id is a team number.
  {
    tracker: "clickup",
    re: /https?:\/\/(?:[\w-]+\.)*clickup\.com\/t\/([\w-]+)(?:\/([\w-]+))?/i,
    pick: (m) => m[2] ?? m[1]!,
  },
  { tracker: "jira", re: /https?:\/\/[\w-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i },
  { tracker: "linear", re: /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]+-\d+)/i },
  { tracker: "shortcut", re: /https?:\/\/app\.shortcut\.com\/[\w-]+\/story\/(\d+)/i },
  { tracker: "asana", re: /https?:\/\/app\.asana\.com\/\d+\/\d+\/(\d+)/i },
  { tracker: "trello", re: /https?:\/\/trello\.com\/c\/([\w-]+)/i },
  { tracker: "github", re: /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/i },
  { tracker: "gitlab", re: /https?:\/\/(?:[\w-]+\.)*gitlab\.[\w.]+\/[\w./-]+?\/-\/issues\/(\d+)/i },
  { tracker: "azure", re: /https?:\/\/dev\.azure\.com\/[\w-]+\/[\w%-]+\/_workitems\/edit\/(\d+)/i },
];

/**
 * The item addresses a body MEANS, which is not every address in it.
 *
 * Lines that are a list item or a quotation are skipped. That is where a
 * template puts its own links and where a reply quotes somebody else's, and
 * both are in the body of every pull request the template made rather than in
 * the one you are reading. Measured on real pull requests before this rule
 * existed: most of them resolved to the same item, because the checklist they
 * are all written from links an item of its own. What survives is a reference
 * somebody wrote for THIS pull request — on its own line, bare or as a link.
 */
function addresses(body: string): { id: string; url: string; tracker: TrackerId }[] {
  const found = new Map<string, { id: string; url: string; tracker: TrackerId }>();
  for (const line of (body || "").split(/\r?\n/)) {
    if (/^\s*(?:[-*+>]|\d+[.)])\s/.test(line)) continue;
    for (const { tracker, re, pick } of ADDRESSES) {
      const m = re.exec(line);
      if (!m) continue;
      const id = pick ? pick(m) : m[1]!;
      found.set(`${tracker}:${id}`, { id, url: m[0], tracker });
    }
  }
  return [...found.values()];
}

/**
 * A human item id: capitals, a hyphen, digits.
 *
 * Every bound is doing one job — keeping ordinary branch names out of a chip.
 * None of them are hypothetical:
 *
 *   fix/UTF-8-decode                    one digit, so not an id
 *   release/v2-1409                     lower case, and a digit in the prefix
 *   .../types/node-22-10-1              lower case — this is the one that bites
 *
 * Capitals is the load-bearing rule, and it is not arbitrary: an id is a proper
 * noun and gets written as one, by every tracker's own "create branch", by
 * every template, and by anybody copying it out of an address bar. Somebody who
 * lower-cases theirs loses the chip on the branch and keeps it via the address
 * in the body, which is where most of them come from anyway.
 *
 * It must start the string or follow a separator, so `agent-v2` cannot lend its
 * tail to something that looks like an id. What follows may be a hyphen — a
 * branch is `ORBIT-1042-what-it-was-about` — but not a word character, so a
 * number is never matched half-way.
 */
const HUMAN_ID = /(?:^|[/_\-\s[(])([A-Z]{2,10})-(\d{2,})(?!\w)/;

const human = (s: string): string | null => {
  const m = HUMAN_ID.exec(s || "");
  return m ? `${m[1]}-${m[2]}` : null;
};

/**
 * The issue this pull request says it closes, in the host's own syntax.
 *
 * `Fixes #12`, `Closes owner/repo#12`. This is the one every public repository
 * has and no tracker needs to be connected for — GitHub and GitLab both write
 * it, both act on it, and the number is meaningful against the pull request's
 * own repository.
 *
 * Skipped inside list items and quotations for the same reason as an address,
 * and a bare `#12` with no keyword is NOT read: pull request bodies are full of
 * them, referring to other pull requests as often as to issues.
 */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/i;

function closesIssue(body: string): { label: string; query: string; repo?: string } | null {
  for (const line of (body || "").split(/\r?\n/)) {
    if (/^\s*(?:[-*+>]|\d+[.)])\s/.test(line)) continue;
    const m = CLOSES.exec(line);
    if (m) return { label: `#${m[2]}`, query: m[2]!, repo: m[1] };
  }
  return null;
}

/**
 * What item this pull request is about, as far as it is willing to say.
 *
 * `repoUrl` is the pull request's own address, used only to build the URL of an
 * issue it says it closes — `…/pull/91` and `…/issues/12` differ by one
 * segment, and without it that reference has a label and nowhere to go.
 *
 * Two different addresses surviving means the body names two items and this
 * cannot tell which is the one. It says so by returning neither: a chip that
 * opens the wrong thing is worse than no chip, because it is believed.
 */
export function readTaskRef(
  pr: { headRefName?: string; title?: string; body?: string; url?: string },
): TaskRef | null {
  // The label people recognise, wherever it turns up. Branch first: it is
  // written by the tool that cut it, so it is the id far more often than a
  // title somebody typed.
  const branch = human(pr.headRefName ?? "");
  const named = branch ?? human(pr.title ?? "");
  const [only, ...rest] = addresses(pr.body ?? "");

  if (only && !rest.length) {
    return { label: named ?? only.id, query: only.id, url: only.url, from: "url", tracker: only.tracker };
  }
  // An address beats a closing keyword: somebody who linked a ticket AND wrote
  // "fixes #12" means the ticket, and the issue is the housekeeping.
  if (!only) {
    const issue = closesIssue(pr.body ?? "");
    if (issue) {
      const url = issueUrl(pr.url, issue.repo, issue.query);
      // Without an address this is still certain — the host resolves the
      // number itself — but it is only useful if it can be opened.
      if (url) return { label: issue.label, query: issue.query, url, from: "url", tracker: hostOf(pr.url) };
    }
  }
  if (!named) return null;
  return { label: named, query: named, from: branch ? "branch" : "title", tracker: null };
}

/** `…/owner/repo/pull/91` → `…/owner/repo/issues/12`, and the same for a
 *  GitLab merge request. Null when the pull request's own address is unknown or
 *  is not one of those two shapes — a guessed URL is the thing this file exists
 *  to avoid. */
function issueUrl(prUrl: string | undefined, repo: string | undefined, number: string): string | undefined {
  if (!prUrl) return undefined;
  const gh = /^(https?:\/\/[^/]*github\.[^/]+)\/([\w.-]+\/[\w.-]+)\/pull\/\d+/i.exec(prUrl);
  if (gh) return `${gh[1]}/${repo ?? gh[2]}/issues/${number}`;
  const gl = /^(https?:\/\/[^/]*gitlab\.[^/]+)\/([\w./-]+?)\/-\/merge_requests\/\d+/i.exec(prUrl);
  if (gl) return `${gl[1]}/${repo ?? gl[2]}/-/issues/${number}`;
  return undefined;
}

function hostOf(prUrl: string | undefined): TrackerId | null {
  if (!prUrl) return null;
  if (/github\./i.test(prUrl)) return "github";
  if (/gitlab\./i.test(prUrl)) return "gitlab";
  return null;
}

/**
 * What a chip may DO with a reference, as one decision rather than a condition
 * spread across some JSX.
 *
 * `tracked` is the caller's answer to "is anything connected that could resolve
 * a bare id" — on both clients that comes from the provider catalogue and never
 * from a product name. Null while the answer has not arrived: saying nothing
 * until it has is what stops a chip appearing and then vanishing.
 *
 *   null          say nothing — an id from a tracker nothing here can resolve
 *   { open }      a URL, which needs nobody's credentials
 *   { find }      hand the id to whatever tracker is connected
 */
export function chipFor(
  ref: TaskRef | null,
  tracked: boolean | null,
): { open: string } | { find: string } | null {
  if (!ref) return null;
  if (ref.url) return { open: ref.url };
  if (tracked === true) return { find: ref.query };
  return null;
}

/** What the chip says when there is room to explain it — where the honesty
 *  about evidence lives, since the chip itself is a few characters. */
export function taskRefTitle(ref: TaskRef): string {
  return ref.from === "url"
    ? `${ref.label} — linked from the description`
    : `${ref.label} — read from the ${ref.from}, which is a convention rather than a link`;
}

/**
 * Does this row answer that query?
 *
 * Every word must appear somewhere in the row's own text. Shape-free on
 * purpose — the caller passes the fields, because a ClickUp card, a Taskwarrior
 * task and whatever comes next do not agree on what they are called, and a
 * matcher that knew would be a matcher that has to be edited per tracker.
 *
 * An empty query matches nothing rather than everything: it is asked by a
 * screen that has been handed an id, and "no id" there means "show what you
 * were showing", which the caller decides — not this.
 */
export function matchesQuery(fields: (string | null | undefined)[], q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

// What the rest of the pull request says about the file you are looking at.
//
// The measured problem, from the mockup this comes from: reading the review
// comment that argues about the file in front of you took six moves —
// Conversation, scroll the timeline, find the file name, Files, find the file,
// find the line — and the timeline lost your place on the way. The comment was
// always there; it just lived in a different tab from the code it was about.
//
// So the rail asks the opposite question. Not "what was said" but "what was
// said ABOUT THIS", and the answer is filtered from what the panel already has.
// No request is made: the timeline, the reviews and the check rollup are all on
// the detail the panel loaded to draw the tabs.
//
// The hard part is not the filtering, it is knowing when to shut up. A rail
// that guesses is worse than an empty one: it puts somebody else's paragraph
// beside your code and lets you believe it is about your code.

import type { PrDetail, PrComment, PrReview, PrCheck, PrThread } from "../../../shared/types.ts";

export interface RailMention {
  who: string;
  body: string;
  createdAt: string;
  /** Where it lives on github.com. A DESTINATION, and the panel already spells
   *  it that way — `Open on GitHub` on every conversation card. It is not the
   *  handle the jump below travels on; see `nodeId`. */
  url?: string;
  /**
   * The entry itself, in the one name that means the same thing on both ends of
   * the trip out of this column.
   *
   * A GraphQL node id names ONE object and encodes its type in the prefix, so
   * `PRR_…` (a review) and `IC_…` (an issue comment) cannot be confused for one
   * another and a single string picks the right entry out without being told
   * which list it came from. The panel already carries it on every card it
   * draws in the Conversation tab, because reacting, editing and deleting are
   * all keyed on it — so the far end of the jump is holding the same handle
   * already.
   *
   * Absent when GitHub sent none. The server writes `nodeId: r.id || ""`, and
   * an empty string is not an address, so it is normalised away here: a caller
   * asking "can I go to this one" must get one answer and not two spellings of
   * no.
   */
  nodeId?: string;
  /** Which part of the conversation it came from, because "a reviewer said" and
   *  "somebody commented" are read differently. */
  kind: "review" | "comment";
}

/**
 * Does this text refer to that path?
 *
 * Deliberately narrow. A full path is unambiguous; a bare basename is not —
 * `index.ts` appears in forty files and in half the sentences anybody writes
 * about a TypeScript project. So a basename only counts when it is distinctive:
 * long enough not to be a word, and carrying a dot, which is what makes it read
 * as a file rather than as prose.
 *
 * Being wrong here is asymmetric, which is why it leans this way. Missing a
 * mention costs you the trip you were already making. Inventing one puts an
 * unrelated argument beside your code, and you will believe it.
 */
export function mentionsPath(text: string, path: string): boolean {
  if (!text || !path) return false;
  const hay = text.toLowerCase();
  if (hay.includes(path.toLowerCase())) return true;
  const base = path.split("/").pop() ?? "";
  if (base.length < 7 || !base.includes(".")) return false;
  // A generic name is a word in a sentence, not a reference.
  if (/^(index|main|types|utils|config|test|tests)\./i.test(base)) return false;
  return hay.includes(base.toLowerCase());
}

/** An HTML comment. Every renderer GitHub uses drops it, which is precisely why
 *  a bot writes its marker in one: it is a note to its own next pass. */
const MARKER = /<!--[\s\S]*?-->/g;

/**
 * The body with the machine's notes to itself taken out.
 *
 * Reported from the app: every entry in the column opened with the literal text
 * of one of these. Nobody wrote it as text — it is invisible everywhere it was
 * meant to be read — and the section's answer to "what does this say about my
 * file" began with a word about a machine.
 *
 * Only a marker that closes is removed. A `<!--` with no `-->` is prose about
 * HTML, or a body GitHub cut off; dropping the rest of the body at it would
 * delete the argument in order to hide a fragment.
 *
 * It runs on every body the rail draws, so the ordinary case has to come out
 * untouched — hence the collapse only of the blank run a removal leaves behind,
 * and nothing else that would make this a reformatter.
 */
export function stripMarkers(text: string): string {
  if (!text) return "";
  if (!text.includes("<!--")) return text;
  return text.replace(MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Something shaped like a file: a path with slashes, or a name with a real
 *  extension. The stem must be two characters, which is what keeps `e.g.` and
 *  `i.e.` out, and the extension must start with a letter, which keeps version
 *  numbers out. */
const PATH_TOKEN = /(?:[\w.@+-]+\/)+[\w.@+-]+|\b[\w@+-]{2,}\.[a-z][a-z\d]{0,5}\b/gi;
/** A word, once the paths are gone. Numbers, percentages, pipes, bullets and
 *  dashes are not words: they are what a table is made of. */
const PROSE_WORD = /[A-Za-z][A-Za-z'’-]+/g;

const pathsOn = (line: string): string[] => line.match(PATH_TOKEN) ?? [];
const wordsOn = (line: string): string[] => line.replace(PATH_TOKEN, " ").match(PROSE_WORD) ?? [];

/**
 * Is this line saying something about a file, or just listing one?
 *
 * The second half of what was reported: three whole-pull-request summaries sat
 * beside a file, each pulled in because the file's name appeared in the LIST OF
 * FILES the summary said it had walked over. The same three attached to six
 * different files, so changing file changed the column for no reason a reader
 * could see, and the heading's promise — what the rest of the pull request says
 * about THIS file — was false on all six.
 *
 * A name is not a claim. What earns a place beside somebody's code is a line
 * that has something to say beyond the name, so that is what this asks:
 *
 *   - a table row is a table row (`| path | 41% |`), whatever is in it;
 *   - a line naming two or more paths with no more words than paths is a
 *     manifest — "6 files: a.py, b.py, …" is bookkeeping, not an argument;
 *   - a line that is nothing but the name is an entry in a list, whatever drew
 *     the list;
 *   - a line with the name and one word is ambiguous — `- path — 41%` and
 *     `- path: double-charges` are the same shape and different things — and
 *     the tiebreak is siblings: three lines that all look like that are a
 *     per-file table, one is somebody being brief.
 *
 * `entries` is that sibling count, computed once over the body.
 */
function isRoster(line: string, entries: number): boolean {
  /*
   * A table row, and not merely a line with pipes in it.
   *
   * Counting bare `|` characters made every shell pipeline, every TypeScript
   * union and every `a || b` into a table — so a reviewer writing one line
   * about the file, with a pipeline in it, was dropped AND the column then
   * printed the confident wrong empty state: "named only in a list of files",
   * about a remark the reader can see in the timeline. Found by the
   * error-handling audit; `||` alone was enough.
   *
   * A markdown table's cells are separated by a pipe with space around it or a
   * pipe at an edge, so that is what is counted; and code spans are masked
   * first, because a pipeline inside backticks is prose about a shell.
   */
  const t = line.trim().replace(/`[^`]*`/g, "");
  /* A row is fenced: markdown writes `| a | b |`, and the separators alone are
     not enough — `"a" | "b" | "c"` is a TypeScript union with two of them, and
     dropping that costs a real remark to catch a shape nobody writes. */
  if ((t.startsWith("|") || t.endsWith("|")) && (t.match(/\|/g)?.length ?? 0) >= 2) return true;
  const paths = pathsOn(t).length;
  const words = wordsOn(t).length;
  if (paths >= 2 && words <= paths) return true;
  if (words === 0) return true;
  return words <= 1 && entries >= 3;
}

/**
 * Does this body ARGUE about that path, rather than merely name it?
 *
 * Asked per line and not per body on purpose. A summary that lists the files it
 * covered and then writes a paragraph about one of them is both things at once,
 * and a rule that counted the paths in the whole body would throw the paragraph
 * out with the manifest — which is the expensive half of the doctrine above:
 * missing a mention costs the trip you were already making.
 *
 * Markers come out first, because a name only a machine can see cannot be the
 * reason a paragraph is quoted beside your code.
 */
/**
 * The part of the question that is about the BODY and not about the file.
 *
 * Splitting the lines and counting how many of them are roster-shaped does not
 * depend on the path at all, and it was being redone for every file you
 * selected, for every body on the pull request, twice per render. Measured on a
 * 40KB automation report: 0.567ms of the 0.725ms each `argues` cost — 78% of
 * it — against 0.003ms per file once the body is prepared.
 *
 * Cached on the body string itself. Bodies are long-lived strings held by the
 * detail, and a `Map` keyed on them would keep every body of every pull request
 * you have opened; a `WeakRef`-free `Map` bounded by insertion order is enough
 * here, because the same handful of bodies is asked about a hundred and fifty
 * times in a row and then never again.
 */
type BodyScan = { lines: string[]; entries: number };
const scans = new Map<string, BodyScan>();
const SCAN_CACHE = 256;

function scanBody(body: string): BodyScan {
  const hit = scans.get(body);
  if (hit) return hit;
  const lines = body.split("\n");
  const scan: BodyScan = {
    lines,
    entries: lines.filter((l) => pathsOn(l).length > 0 && wordsOn(l).length <= 1).length,
  };
  // Oldest out first. Map iterates in insertion order, so this is one delete.
  if (scans.size >= SCAN_CACHE) { const first = scans.keys().next().value; if (first !== undefined) scans.delete(first); }
  scans.set(body, scan);
  return scan;
}

export function argues(text: string, path: string): boolean {
  const body = stripMarkers(text);
  if (!mentionsPath(body, path)) return false;
  const { lines, entries } = scanBody(body);
  return lines.some((l) => mentionsPath(l, path) && !isRoster(l, entries));
}

/** One walk over both lists, because "what to quote" and "was it named at all"
 *  are the same scan asked two ways, and they must not disagree. */
function scanFor(d: Pick<PrDetail, "comments" | "reviews">, path: string): { said: RailMention[]; named: boolean } {
  const said: RailMention[] = [];
  let named = false;
  const take = (body: string, m: () => RailMention) => {
    const clean = stripMarkers(body);
    if (!clean) return;
    if (argues(clean, path)) said.push(m());
    else if (mentionsPath(clean, path)) named = true;
  };
  for (const r of (d.reviews ?? []) as PrReview[]) {
    take(r.body, () => ({ who: r.author, body: stripMarkers(r.body), createdAt: r.submittedAt ?? "", url: r.url, nodeId: r.nodeId || undefined, kind: "review" }));
  }
  for (const c of (d.comments ?? []) as PrComment[]) {
    // A bot naming a file is usually a coverage table, and a coverage table
    // beside the code is noise dressed as a mention. Kept out of `named` as
    // well: the sentence that explains an empty section must be about the rule
    // that emptied it, and this is not that rule.
    if (!c.isBot) take(c.body, () => ({ who: c.author, body: stripMarkers(c.body), createdAt: c.createdAt, url: c.url, nodeId: c.nodeId || undefined, kind: "comment" }));
  }
  return { said, named };
}

/** Everything in the conversation that argues about this file, newest last so
 *  it reads as a thread rather than as a list. */
export function saidAbout(d: Pick<PrDetail, "comments" | "reviews">, path: string | null): RailMention[] {
  /* Kept as the one-answer form for tests and for any caller that wants only
     the quotes. It is a view of `railScan`, never a second walk. */
  return railScan(d, path).said;
}

/**
 * Both answers from one walk, for a caller that wants both — which the rail
 * always does.
 *
 * `saidAbout` and `namedOnlyInRoster` were called side by side in the rail's
 * render body and each ran the SAME full walk of every review and every
 * comment, one of the two thrown away. Measured on a pull request with 200
 * comments and six 44KB automation reports: 4.2ms and 4.6ms, of an 11.9ms
 * render that was paid twice for every file you stepped to.
 */
export function railScan(
  d: Pick<PrDetail, "comments" | "reviews">,
  path: string | null,
): { said: RailMention[]; listedOnly: boolean } {
  if (!path) return { said: [], listedOnly: false };
  const { said, named } = scanFor(d, path);
  return {
    said: said.sort((a, b) => Date.parse(a.createdAt || "0") - Date.parse(b.createdAt || "0")),
    listedOnly: named && said.length === 0,
  };
}

/**
 * Nothing argued about it, but something did list it.
 *
 * Two different answers that would otherwise share one sentence. "Nothing in
 * the conversation names it", printed over a timeline where the file IS listed
 * six lines up, reads as the column being broken — and going to check is
 * exactly the trip this section exists to save. So the empty state says which
 * of the two it is, and the rule above stops being invisible to the reader it
 * is protecting.
 */
export function namedOnlyInRoster(d: Pick<PrDetail, "comments" | "reviews">, path: string | null): boolean {
  /* Through `railScan`, not around it. This used to call `scanFor` and
     re-derive the rule, so changing what "listed only" means in one place left
     the other asserting the old rule — and passing. There is one rule. */
  return railScan(d, path).listedOnly;
}

/** One run of a preview. `text` is what is drawn; `kind` is the one thing about
 *  it that a reader would otherwise have to infer from punctuation. */
export interface RailSpan {
  kind: "text" | "bold" | "italic" | "code";
  text: string;
}

/** A fence: punctuation around code, never content. */
const FENCE = /^(?:```|~~~)/;
/** A table's rule row, and a horizontal rule. Both are drawings, not readings. */
const RULE = /^\|?\s*:?-{3,}/;

/**
 * Every line of a body reduced to one run of prose, in reading order.
 *
 * The column is 320px and the entry is a three-line preview of a body that is
 * routinely forty lines long, so block structure is not something it can draw:
 * a preview that grows into a document is not a preview, and the jump beside it
 * is what takes a reader to the real one.
 *
 * But the markers still have to GO, which is the half that was reported. Left
 * as text, a heading prints its hashes and a bullet prints its dash; the reader
 * sees the syntax of a structure that is not there. So each line loses the mark
 * that would have drawn it and keeps every word it had — the loss is the shape,
 * never the sentence.
 *
 * The two exceptions are the two lines that are ONLY shape. A fence has no
 * words in it, and a table's rule row is three dashes pretending to be a
 * border; printing either would be printing the drawing after refusing to draw.
 */
function flattenBlocks(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let l = raw.trim();
    if (!l || FENCE.test(l)) continue;
    l = l.replace(/^>+\s?/, "");
    l = l.replace(/^#{1,6}\s+/, "");
    l = l.replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "");
    // What a task list leaves behind once its bullet is gone.
    l = l.replace(/^\[[ xX]\]\s+/, "");
    if (!l || RULE.test(l)) continue;
    /* A table row is cells, and the pipes are the ruling around them. Drawn as
       the separator the rail already uses between two facts on one line, so a
       row reads as a row rather than as a sentence with bars in it. */
    if (l.startsWith("|")) {
      l = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ");
    }
    if (l) out.push(l);
  }
  return out.join(" ").replace(/\s{2,}/g, " ").trim();
}

/**
 * The inline marks, in the order they are tried.
 *
 * Code first, because everything inside a backtick run is an identifier and
 * must not be read as anything else — `a * b * c` in code is multiplication,
 * and emphasis would eat the operators.
 *
 * Then bold before italic, so `**x**` is not read as an empty italic around an
 * italic. Both require the run to begin and end on a non-space, non-asterisk
 * character, which is what keeps `2 * 3` and a stray trailing `*` from opening
 * one that swallows the rest of the sentence.
 *
 * `__bold__` is deliberately NOT read. `__init__` and `__all__` are the
 * commonest double-underscore runs in any review of Python, and they are names
 * rather than emphasis: reading them as bold would print `init` in the middle
 * of a sentence about `__init__`. The cost is that a body written with
 * underscores keeps them on screen — a visible nuisance, where the other way
 * round is a wrong word.
 *
 * A link keeps its words and drops its address. The URL is the part of a link
 * that cannot be read at this width, and the entry now has a button whose only
 * job is going somewhere. An image collapses to its alt text, which is usually
 * nothing, which is the right size for a picture in a three-line preview.
 */
const INLINE = /`([^`\n]+)`|\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*|\*([^\s*](?:[^*\n]*[^\s*])?)\*|!?\[([^\]\n]*)\]\([^)\n]*\)/g;

function inlineSpans(text: string): RailSpan[] {
  const out: RailSpan[] = [];
  const push = (kind: RailSpan["kind"], s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    // Adjacent plain runs are one run: a link between two sentences must not
    // leave the clip below counting three spans where a reader sees one line.
    if (kind === "text" && prev?.kind === "text") prev.text += s;
    else out.push({ kind, text: s });
  };
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    push("text", text.slice(last, i));
    if (m[1] != null) push("code", m[1]);
    else if (m[2] != null) push("bold", m[2]);
    else if (m[3] != null) push("italic", m[3]);
    else push("text", m[4] ?? "");
    last = i + m[0].length;
  }
  push("text", text.slice(last));
  return out;
}

/**
 * A body as the column can actually show it: the marks read rather than
 * printed, the blocks flattened, and clipped to what fits.
 *
 * Reported from the app, against a real review — the first entry read
 * `Review Summary 1 Critical. 1 High. 5 Medium. 4 Low. **Pre-check reports:**
 * could not read /tmp/…`, asterisks and backticks and all, because the column
 * drew every body as plain text. A body written in markdown had its syntax on
 * show in the one place whose job is to be read at a glance.
 *
 * The budget is spent on WORDS. Clipping the raw body counted `**Review
 * Summary**` as eighteen of it and showed fourteen, so the number in the call
 * site was about the markup rather than about the column — and two entries with
 * the same visible length got different amounts of room for no reason a reader
 * could see.
 */
export function railPreview(body: string, max: number): RailSpan[] {
  /*
   * Only ever flatten as much as the clip below can possibly show.
   *
   * The whole body was flattened and inline-scanned to put 260 characters in a
   * 320px column: 0.54ms per 40KB automation report, paid for every quoted
   * entry on every render. The multiplier is generous on purpose — markdown
   * marks, a link's address and a dropped fence all cost characters that never
   * reach the screen, so a tight cut would clip earlier than the clip does.
   */
  const head = body.length > max * 12 ? body.slice(0, max * 12) : body;
  const spans = inlineSpans(flattenBlocks(stripMarkers(head)));
  const out: RailSpan[] = [];
  let left = max;
  let cut = false;
  for (const s of spans) {
    if (left <= 0) { cut = true; break; }
    if (s.text.length <= left) { out.push({ ...s }); left -= s.text.length; continue; }
    out.push({ kind: s.kind, text: s.text.slice(0, left) });
    cut = true;
    break;
  }
  // Its own run rather than the tail of the last one: an ellipsis is the
  // column speaking, not the author, and inside a code run it would look like
  // part of the identifier it just truncated.
  if (cut && out.length) out.push({ kind: "text", text: "…" });
  return out;
}

/**
 * How long ago, in the two characters the rail has room for.
 *
 * It is here rather than imported for the same reason `RailDraft` is declared
 * below: the panel's own `ago` is module-private, and reaching for it would mean
 * editing the six-thousand-line component this library exists in order not to
 * depend on. The spelling is deliberately the panel's, so a comment does not
 * read "4h" in the timeline and "4 hours" beside the code.
 *
 * `now` is an argument because a sentence that changes with the wall clock
 * cannot be tested, and this one is asserted on.
 */
export function railAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * The failing checks, and whether any of them can honestly be tied to this file.
 *
 * A check carries a name and a workflow and no log, so most of the time the
 * truthful answer is "these are failing, and I cannot tell you which file broke
 * them". The rail says exactly that rather than picking one — the mockup this
 * comes from promises "the failing check that names this file", and promising
 * it from data that cannot support it is how a panel starts lying quietly.
 *
 * When a check's own name does contain the path it IS a real link, and those
 * are marked so they can be shown first.
 */
export function checksAbout(failing: PrCheck[], path: string | null): { check: PrCheck; namesFile: boolean }[] {
  return failing.map((c) => ({
    check: c,
    namesFile: !!path && (mentionsPath(c.name, path) || mentionsPath(c.workflow ?? "", path)),
  })).sort((a, b) => Number(b.namesFile) - Number(a.namesFile));
}

/**
 * The unresolved threads sitting on this file, in the order the file reads.
 *
 * Resolved ones are left out: a resolved thread is not something to go and
 * read. Outdated ones are kept — the code under them moved, but the argument in
 * them did not, and it is still unanswered.
 *
 * Sorted by the line they are anchored to, falling back to the line they were
 * written on, so the rail lists them in the order you will meet them scrolling
 * down. A thread with neither goes last rather than to the top, where it would
 * push the ones you can still find beneath it.
 */
export function threadsAbout(d: Pick<PrDetail, "threads">, path: string | null): PrThread[] {
  if (!path) return [];
  const at = (t: PrThread) => t.line ?? t.originalLine ?? Number.MAX_SAFE_INTEGER;
  return (d.threads ?? [])
    .filter((t) => t.path === path && !t.isResolved)
    .sort((a, b) => at(a) - at(b));
}

/** How many threads sit on this file, which is the one number that tells you
 *  whether there is anything to read before you scroll. */
export const threadsOn = (d: Pick<PrDetail, "threads">, path: string | null): number =>
  threadsAbout(d, path).length;

/**
 * A line comment you have written and not sent — GitHub's pending review.
 *
 * Declared here by shape rather than imported. `DraftComment` belongs to the
 * panel, because the panel owns the stash it is kept in, and a library the rail
 * calls has no business importing the component that draws it. What the rail
 * needs is this much, and `DraftComment` is this much and more.
 */
export interface RailDraft {
  path: string;
  /** The last line the comment covers — GitHub's `line`. */
  line: number;
  /** The first, when it covers a range. */
  startLine?: number;
  body: string;
}

/**
 * A line comment GitHub is holding in a review you started on the website and
 * never submitted.
 *
 * Same shape as a draft plus the one thing that makes it different: it lives on
 * a server, so it has an address. No API edits a comment inside a pending
 * review without submitting the whole review, so everything this app can offer
 * about one is a way to READ it and a way to get to where it can be changed —
 * which is exactly `url`.
 */
export interface RailHeld {
  path: string;
  /** Null when the diff moved under it — GitHub calls that outdated. */
  line: number | null;
  body: string;
  /** The comment's own page. Empty when the server could not resolve one. */
  url?: string;
}

/**
 * The ones on this file, top of the file first.
 *
 * Outdated comments (`line === null`) sort last: they are attached to a version
 * of the file that is no longer on screen, so there is no row to put them
 * beside and no order to put them in.
 */
export function heldOn(held: RailHeld[] | undefined, path: string | null): RailHeld[] {
  if (!path || !held) return [];
  return held
    .filter((c) => c.path === path)
    .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
}

/**
 * What YOU have queued on this file.
 *
 * The other sections here answer "what did somebody else say"; this one answers
 * a question you cannot answer yourself. A queued comment exists only as a box
 * under the line it was left on, so scrolling past it is indistinguishable from
 * never having written it, and the file gives you no way to ask.
 *
 * Matched on the exact path, and deliberately not through `mentionsPath`: a
 * draft carries the diff's own path, so there is nothing to infer, and prose
 * tolerance would only let a note on one file surface beside another.
 */
export function queuedOn(drafts: RailDraft[] | undefined, path: string | null): RailDraft[] {
  if (!path || !drafts) return [];
  return drafts
    .filter((c) => c.path === path)
    .sort((a, b) => (a.startLine ?? a.line) - (b.startLine ?? b.line));
}

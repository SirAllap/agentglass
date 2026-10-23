/**
 * One organized comment for a pull request, made out of a local review.
 *
 * Nothing in this file reaches GitHub on its own. `buildReviewComment` is pure
 * (same input, same text, no clock and no home directory read), and the two
 * entry points below take the GitHub reads and writes as a handed-in `deps`, so
 * a test sees exactly what was asked of it. The route that calls them is a
 * person's click: see `mayPublishReview` in index.ts.
 */
import { reviewStale } from "../../shared/headCompare.ts";
import { stripSecrets } from "../../shared/scrub.ts";
import { DEFAULT_PUBLISH_OPTIONS, PUBLISH_MAX_CHARS, cleanPublishOptions, type PublishOptions } from "../../shared/reviewPublish.ts";
import { NOTE_SEVERITIES, type NoteReply, type NoteSeverity, type NoteStatus, type PrNote, type PrRun } from "../../shared/pluginUi.ts";

export { DEFAULT_PUBLISH_OPTIONS, PUBLISH_MAX_CHARS, cleanPublishOptions, type PublishOptions };

export const MARKER_PLUGIN_RE = /^[A-Za-z0-9_.-]{1,60}$/;
export const reviewMarker = (plugin: string): string => `<!-- agentglass-review:${plugin} -->`;

export interface BuildInput {
  plugin: string;
  repo: string;
  number: number;
  run: PrRun;
  notes: readonly PrNote[];
  options: PublishOptions;
  /** The signed-in GitHub login, to name the person's own replies. */
  viewer?: string;
  /** How many finished reviews this plugin has on the pull request; the header says so past one. */
  reviews?: number;
  /** What those finished reviews cost together; the table shows it past one review, with the word "total". */
  totalCost?: number;
}

/** The run the comment's header speaks for: the plugin's latest FINISHED run, by when it finished. */
export function headerRun<R extends PrRun & { plugin: string }>(runs: readonly R[], plugin: string): { run: R | undefined; reviews: number; totalCost: number | undefined } {
  const mine = runs.filter((r) => r.plugin === plugin);
  const done = mine.filter((r) => r.state === "done").sort((x, y) => (x.finishedAt ?? x.startedAt) - (y.finishedAt ?? y.startedAt));
  const priced = done.filter((r) => r.costUsd !== undefined);
  return { run: done[done.length - 1] ?? mine[mine.length - 1], reviews: done.length, totalCost: priced.length ? priced.reduce((n, r) => n + r.costUsd!, 0) : undefined };
}

/** The findings the comment draws from: every one this plugin has on the pull
 *  request, whichever of its runs touched it last (the store holds one note per
 *  finding id, so there is nothing to dedupe). A finding belongs to the pull
 *  request. A latest run that found nothing must not hide what earlier ones
 *  found and the person closed. */
export const publishNotes = <N extends PrNote & { plugin: string }>(notes: readonly N[], plugin: string, repo: string, number: number): N[] =>
  notes.filter((n) => n.plugin === plugin && n.repo === repo && n.number === number);

export type Built =
  | { ok: true; markdown: string; chars: number; openCount: number; omitted: number }
  | { ok: false; error: string };

const SEV_RANK = new Map<NoteSeverity, number>(NOTE_SEVERITIES.map((s, i) => [s, i] as const));
const STATE_RANK: Record<NoteStatus, number> = { open: 0, resolved: 1, dismissed: 2 };
const isInfo = (n: PrNote) => n.severity === "idea" || n.severity === "info";

/** A mention that would notify somebody gets a zero-width break after the `@`. */
function noMention(s: string): string {
  return s.replace(/(^|[^A-Za-z0-9_`])@(?=[A-Za-z0-9])/g, "$1@​");
}

/** Home directories of any user become `~`; a path of this machine says who is at it. */
function noHome(s: string): string {
  return s.replace(/\/(?:home|Users)\/[^/\s`'")]+/g, "~").replace(/\/root(?=\/|\b)/g, "~");
}

/**
 * Text a plugin or a person wrote, made safe to sit inside a comment. Markdown
 * is kept (a finding is written in it); what is closed is the way out of its
 * own block: `<` is escaped, so there is no raw HTML, no `</details>`, no
 * comment that could forge the marker; an image is neutralised (a request
 * made by whoever opens the PR); a fence left open is closed.
 */
export function safeMarkdown(text: string): string {
  let t = noHome(text).replace(/\r\n?/g, "\n").replace(/<!--/g, "&lt;!--").replace(/</g, "&lt;");
  t = t.replace(/!\[/g, "!\\[");
  t = noMention(t);
  const fences = t.split("\n").filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2 === 1) t += "\n```";
  return t.trim();
}

/** The same for a title: one line, and no markdown at all. */
function safeInline(text: string): string {
  return noMention(noHome(text).replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>|~]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "\\" + c)));
}

const code = (t: string) => "`" + noHome(t).replace(/`/g, "'").replace(/\s+/g, " ") + "`";
const quote = (t: string) => t.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

/** A credential-shaped string. A 40-character commit id is one to the scrubber, so ids are set aside first. */
export function looksLikeSecret(text: string): boolean {
  const plain = text.replace(/\b[0-9a-f]{40}\b/gi, "");
  return stripSecrets(plain) !== plain;
}

function who(by: string, viewer?: string): string {
  if (by === "user") return viewer ? safeInline(viewer) : "reviewer";
  return `agent ${safeInline(by.replace(/^agent:/, ""))}`;
}

function replyBlock(r: NoteReply, viewer?: string): string {
  const tag = r.withStatus ? ` (${r.withStatus})` : "";
  return quote(`**${who(r.by, viewer)}**${tag}: ${safeMarkdown(r.text)}`);
}

function dateOf(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function money(v: number | undefined): string { return v === undefined ? "-" : v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`; }
/** One review: its own cost. Several: the sum of all of them, said so, since the other cells speak for the latest run only. */
function costCell(run: PrRun, input: BuildInput): string {
  return input.reviews && input.reviews > 1 && input.totalCost !== undefined ? `${money(input.totalCost)} total` : money(run.costUsd);
}
const cell = (v: string | undefined) => (v ? safeInline(v) : "-");

function verdict(notes: readonly PrNote[]): { line: string; open: PrNote[] } {
  const open = notes.filter((n) => n.status === "open" && !isInfo(n));
  const heavy = open.some((n) => n.severity === "critical" || n.severity === "high");
  const line = heavy ? "needs changes before merge" : open.length ? "minor issues open" : "no open findings";
  return { line, open };
}

function countLine(notes: readonly PrNote[], o: PublishOptions): string {
  const open = notes.filter((n) => n.status === "open" && !isInfo(n));
  const by = NOTE_SEVERITIES.map((s) => [s, open.filter((n) => n.severity === s).length] as const).filter(([, c]) => c > 0);
  const parts: string[] = [];
  parts.push(by.length ? `${by.map(([s, c]) => `${c} ${s}`).join(", ")} open` : "0 open");
  const resolved = notes.filter((n) => n.status === "resolved" && (o.includeInfo || !isInfo(n))).length;
  const dismissed = notes.filter((n) => n.status === "dismissed" && (o.includeInfo || !isInfo(n))).length;
  if (o.includeResolved && resolved) parts.push(`${resolved} resolved`);
  if (o.includeDismissed && dismissed) parts.push(`${dismissed} dismissed`);
  return parts.join(", ");
}

function findingBlock(n: PrNote, o: PublishOptions, viewer?: string): string {
  const where = n.path ? ` · ${code(`${n.path}${n.line ? `:${n.line}` : ""}`)}` : "";
  const lines = [
    `<details${n.status === "open" ? " open" : ""}>`,
    `<summary><b>${n.severity.toUpperCase()}</b> ${safeInline(n.title)}${where} · <b>${n.status}</b></summary>`,
    "",
  ];
  if (n.body?.trim()) lines.push(safeMarkdown(n.body), "");
  const thread = n.replies ?? [];
  // A closed finding says how it was closed; the whole thread is the person's to tick.
  const shown = o.includeReplies ? thread : n.status === "open" ? [] : thread.filter((r) => r.withStatus === n.status).slice(-1);
  for (const r of shown) lines.push(replyBlock(r, viewer), "");
  lines.push("</details>");
  return lines.join("\n");
}

/** The comment for one plugin on one pull request: the header is its latest
 *  finished run's, the findings are the pull request's (a finding belongs to
 *  the pull request, not to the run that last touched it). */
export function buildReviewComment(input: BuildInput): Built {
  const { plugin, repo, number, run, notes, viewer } = input;
  const o = input.options;
  if (!MARKER_PLUGIN_RE.test(plugin)) return { ok: false, error: "that plugin name cannot be put in a comment marker" };

  const mine = notes.filter((n) => n.repo === repo && n.number === number);
  const wants = (n: PrNote) => (isInfo(n) ? o.includeInfo : true)
    && (n.status === "open" ? o.includeOpen : n.status === "resolved" ? o.includeResolved : o.includeDismissed);
  const shown = mine.filter(wants).sort((a, b) =>
    STATE_RANK[a.status] - STATE_RANK[b.status] || (SEV_RANK.get(a.severity) ?? 9) - (SEV_RANK.get(b.severity) ?? 9) || a.createdAt - b.createdAt);

  // Refuse before building anything long. The finding's id is named, its text never.
  const texts = (n: PrNote) => [n.title, n.body ?? "", n.path ?? "", ...(n.replies ?? []).map((r) => r.text)];
  for (const n of shown) if (texts(n).some(looksLikeSecret)) return { ok: false, error: `finding ${n.id} looks like it holds a credential; remove it from that finding before publishing` };
  if ([run.title, run.summary ?? "", run.agent ?? "", run.model ?? ""].some(looksLikeSecret)) return { ok: false, error: "the run's own text looks like it holds a credential" };

  const v = verdict(mine);
  const head: string[] = [];
  const sha = run.sha ? run.sha.slice(0, 7) : undefined;
  if (o.includeHeader) {
    const reviews = input.reviews && input.reviews > 1 ? ` · ${input.reviews} reviews` : "";
    head.push(`### 🔍 Local review${run.agent ? ` · ${safeInline(run.agent)}` : ""} · ${safeInline(plugin)}${reviews}`, "");
    head.push("| Agent | Model | Commit | Cost | Date |", "|---|---|---|---|---|");
    head.push(`| ${cell(run.agent)} | ${cell(run.model)} | ${sha ? code(sha) : "-"} | ${costCell(run, input)} | ${dateOf(run.finishedAt ?? run.startedAt)} |`, "");
    head.push(`**Verdict: ${v.line}** — ${countLine(mine, o)}. Reviewed locally on the author's machine; not a GitHub review (no approval, no change request).`, "");
  }
  const foot = [
    `Published from agentglass${sha ? ` · review of ${code(sha)}` : ""} · re-publishing after a push edits this comment.`,
    "", reviewMarker(plugin),
  ];

  const blocks = shown.map((n) => findingBlock(n, o, viewer));
  const render = (keep: number, omitted: Map<string, number>): string => {
    const out = [...head, ...blocks.slice(0, keep).flatMap((b) => [b, ""])];
    if (omitted.size) {
      out.push(`_Left out to fit GitHub's size limit: ${[...omitted].map(([k, c]) => `${c} ${k}`).join(", ")} (still in the local review)._`, "");
    }
    return [...out, ...foot].join("\n");
  };

  let keep = blocks.length;
  const omitted = new Map<string, number>();
  let md = render(keep, omitted);
  // Lowest severities go first, summarised as counts, and a finding is never cut in half.
  while (md.length > PUBLISH_MAX_CHARS && keep > 0) {
    keep--;
    const n = shown[keep]!;
    omitted.set(n.severity, (omitted.get(n.severity) ?? 0) + 1);
    md = render(keep, omitted);
  }
  if (md.length > PUBLISH_MAX_CHARS) return { ok: false, error: `the comment is over ${PUBLISH_MAX_CHARS} characters even without findings` };
  let left = 0;
  for (const c of omitted.values()) left += c;
  return { ok: true, markdown: md, chars: md.length, openCount: v.open.length, omitted: left };
}

// ── preview and publish ─────────────────────────────────────────────────────

export interface PrCommentRef { nodeId: string; author: string; body: string; url: string }

/** What the two entry points ask of GitHub. A test hands in a spy. */
export interface PublishDeps {
  read(): Promise<{ ok: true; comments: PrCommentRef[]; viewer: string; headSha?: string; headReadAt?: number } | { ok: false; error: string }>;
  create(body: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  edit(nodeId: string, body: string): Promise<{ ok: boolean; error?: string }>;
}

export interface PublishRequest extends Omit<BuildInput, "viewer"> { root?: unknown }

/** The comment this plugin's review already has on the pull request, the signed-in user's own. */
export function findPublished(comments: readonly PrCommentRef[], plugin: string, viewer: string): PrCommentRef | null {
  if (!viewer) return null;
  const mark = reviewMarker(plugin);
  const mineHere = comments.filter((c) => c.author.toLowerCase() === viewer.toLowerCase() && c.body.includes(mark));
  return mineHere[mineHere.length - 1] ?? null;
}

export type Previewed =
  | { ok: true; markdown: string; chars: number; existing: { commentId: string; url: string } | null; stale: boolean; openCount: number; omitted: number }
  | { ok: false; error: string };

/** Read-only: builds the comment and looks for the one it would edit. */
export async function previewReview(req: PublishRequest, deps: PublishDeps): Promise<Previewed> {
  const seen = await deps.read();
  if (!seen.ok) return seen;
  const built = buildReviewComment({ ...req, viewer: seen.viewer });
  if (!built.ok) return built;
  const ex = findPublished(seen.comments, req.plugin, seen.viewer);
  return {
    ok: true, markdown: built.markdown, chars: built.chars, openCount: built.openCount, omitted: built.omitted,
    existing: ex ? { commentId: ex.nodeId, url: ex.url } : null,
    stale: reviewStale(req.run.sha, req.run.finishedAt ?? req.run.startedAt, { sha: seen.headSha, at: seen.headReadAt }) === true,
  };
}

/** What the dialog sent back, made fit to post: size, credentials, and the marker last. */
export function checkEdited(markdown: string, plugin: string): { ok: true; markdown: string } | { ok: false; error: string } {
  if (!MARKER_PLUGIN_RE.test(plugin)) return { ok: false, error: "that plugin name cannot be put in a comment marker" };
  const mark = reviewMarker(plugin);
  const body = markdown.split(mark).join("").replace(/\r\n?/g, "\n").trimEnd();
  if (!body.trim()) return { ok: false, error: "the comment is empty" };
  const md = `${body}\n\n${mark}`;
  if (md.length > PUBLISH_MAX_CHARS) return { ok: false, error: `the comment is over ${PUBLISH_MAX_CHARS} characters` };
  if (looksLikeSecret(md)) return { ok: false, error: "the comment looks like it holds a credential" };
  return { ok: true, markdown: md };
}

const flying = new Set<string>();

export type Published =
  | { ok: true; url: string; edited: boolean; commit?: string }
  | { ok: false; error: string };

/**
 * Posts the comment, or edits the one already there. One at a time per pull
 * request, no retry: a second attempt is a second comment. Only a plain
 * comment: there is no path from here to an approval or a change request.
 */
export async function publishReview(req: PublishRequest, edited: string | undefined, deps: PublishDeps): Promise<Published> {
  const key = `${req.repo}#${req.number}`;
  if (flying.has(key)) return { ok: false, error: "a comment is already being posted on this pull request" };
  flying.add(key);
  try {
    const seen = await deps.read();
    if (!seen.ok) return seen;
    let markdown: string;
    if (edited !== undefined) {
      const c = checkEdited(edited, req.plugin);
      if (!c.ok) return c;
      markdown = c.markdown;
    } else {
      const b = buildReviewComment({ ...req, viewer: seen.viewer });
      if (!b.ok) return b;
      markdown = b.markdown;
    }
    const ex = findPublished(seen.comments, req.plugin, seen.viewer);
    if (ex) {
      const r = await deps.edit(ex.nodeId, markdown);
      return r.ok ? { ok: true, url: ex.url, edited: true, ...(req.run.sha ? { commit: req.run.sha } : {}) } : { ok: false, error: r.error || "GitHub refused the edit" };
    }
    const r = await deps.create(markdown);
    return r.ok ? { ok: true, url: r.url ?? "", edited: false, ...(req.run.sha ? { commit: req.run.sha } : {}) } : { ok: false, error: r.error || "GitHub refused the comment" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "GitHub refused the comment" };
  } finally {
    flying.delete(key);
  }
}

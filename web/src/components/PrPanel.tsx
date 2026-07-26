// Pull requests, so a review does not mean opening a browser.
//
// What shapes this panel, all of it learned from real pull requests rather than
// guessed:
//
// 1. The conversation is mostly machines. On a live review, four issue comments
//    were all from CI and one coverage table alone was 46,551 characters, while
//    the single human review that blocked the merge sat last. So it reads in
//    three lanes — humans, line threads, automation — and the machine lane
//    collapses to its digest.
//
// 2. A body is markdown, and prose set to the full width of a 2000px window is
//    unreadable however correct the formatting. Everything written by a person
//    renders through `Md`, which holds a reading measure and centres it.
//
// 3. Diffs are not re-implemented. `SplitDiff`/`UnifiedDiff` from ChangesModal
//    are the app's diff viewer, keybindings and all; a pull request is
//    translated into the `FileChange` they already speak.
//
// 4. Nothing waits on the network. `gh` costs a second or more per call and the
//    server has one thread; every read is a cached answer with its age shown.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import type {
  PrSummary, PrDetail, PrRepoId, PrThread, PrComment, PrReview, PrCheck, GitRepoRef, FileChange,
} from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE, UnifiedDiff, SplitDiff, Toggle } from "./ChangesModal.tsx";
import { parseBody, parseUnifiedDiff, newLineNumbers, type MdBlock, type ParsedFile } from "../lib/prBody.ts";
import { stepFileIndex } from "../lib/prNav.ts";
import { PrFilterBar } from "./PrFilterBar.tsx";
import { parseQuery, applyFilters, buildFacets, activeCount } from "../lib/prFilter.ts";
import { getHighlighter, shikiTheme } from "../lib/highlight.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";

type Filter = "mine" | "review" | "all";
type Tab = "overview" | "conversation" | "commits" | "files" | "checks" | "review";

/**
 * Saved views: a scope and a query, together, under one name.
 *
 * The three scopes are what the server can fetch; the interesting questions
 * ("what of mine is red", "what of mine could land right now") are a scope plus
 * a filter, and asking them used to mean picking a tab and then building the
 * query by hand every time. A view is only ever shorthand — it writes the same
 * query string the facets write, so the chips below still show what is on and
 * still take it off again.
 */
const VIEWS: { id: string; label: string; scope: Filter; query: string; tint?: string; hint: string }[] = [
  { id: "review", label: "Needs my review", scope: "review", query: "", tint: "var(--warning)", hint: "Somebody asked you to look" },
  { id: "mine", label: "Mine", scope: "mine", query: "", tint: "var(--primary)", hint: "Pull requests you opened" },
  { id: "failing", label: "Failing", scope: "all", query: "checks:red", tint: "var(--error)", hint: "Open here with a red check" },
  { id: "ready", label: "Ready", scope: "all", query: "review:approved checks:green", tint: "var(--success)", hint: "Approved and green — these can land" },
  { id: "all", label: "All", scope: "all", query: "", hint: "Every open pull request" },
];

const POLL_MS = 20_000;
const SEEN_KEY = "agentglass.pr.seen";
const DRAFT_KEY = "agentglass.pr.drafts";

/** A line comment written but not yet sent — GitHub's "pending review". */
export interface DraftComment { path: string; line: number; body: string }

const loadMap = <T,>(k: string): Record<string, T> => {
  try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; }
};
const saveMap = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function ago(iso: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const stateTint = (p: PrSummary): string => {
  if (p.checks.pending > 0) return "var(--warning)";
  if (p.checks.verdict === "red") return "var(--error)";
  if (p.checks.verdict === "green") return "var(--success)";
  return "var(--text3)";
};

function Dot({ tint, title }: { tint: string; title?: string }) {
  return <span title={title} className="inline-block shrink-0 rounded-full" style={{ width: 6, height: 6, background: tint }} />;
}

function Chip({ text, tint, title }: { text: string; tint: string; title?: string }) {
  return (
    <span title={title} className="shrink-0 text-[9px] px-1.5 py-px rounded-full uppercase tracking-wide"
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 14%, transparent)` }}>{text}</span>
  );
}

function ReviewChip({ d }: { d: PrSummary["reviewDecision"] }) {
  if (d === "APPROVED") return <Chip text="approved" tint="var(--success)" />;
  if (d === "CHANGES_REQUESTED") return <Chip text="changes" tint="var(--error)" />;
  if (d === "REVIEW_REQUIRED") return <Chip text="waiting" tint="var(--warning)" />;
  return null;
}

function Bar({ parts }: { parts: { pct: number; tint: string }[] }) {
  return (
    <div className="flex-1 h-1.5 rounded-full overflow-hidden flex min-w-[60px]"
      style={{ background: "color-mix(in srgb, var(--border) 35%, transparent)" }}>
      {parts.map((p, i) => <div key={i} style={{ width: `${p.pct}%`, background: p.tint }} />)}
    </div>
  );
}

/** GitHub's avatar for a login, through the server's allowlisted proxy. The
 *  name is always beside it — the picture is recognition, not identification. */
function Avatar({ login, size = 18 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = (login || "?").replace(/\[bot\]$/, "").slice(0, 2).toUpperCase();
  if (failed || !login) {
    return (
      <span className="shrink-0 rounded-full inline-flex items-center justify-center"
        style={{ width: size, height: size, background: "var(--primary)", color: "var(--bg)", fontSize: size * 0.42 }}>{initials}</span>
    );
  }
  return (
    <img src={api.prAssetUrl(`https://avatars.githubusercontent.com/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}?size=48`)}
      alt="" aria-hidden width={size} height={size} onError={() => setFailed(true)}
      className="shrink-0 rounded-full" style={{ width: size, height: size, objectFit: "cover" }} />
  );
}

function Btn({ children, onClick, disabled, danger, primary, ok, warn, title, small }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  danger?: boolean; primary?: boolean; ok?: boolean; warn?: boolean; title?: string; small?: boolean;
}) {
  // `warn` is the amber "this mutates the branch" accent, matching the Source
  // Control bar's sync/behind colour (--warning). Used for update-branch, which
  // merges the base into this branch — a consequential action that should not
  // read the same as its plain neighbours.
  const edge = danger ? "var(--error)" : ok ? "var(--success)" : warn ? "var(--warning)" : primary ? "var(--primary)" : "var(--border)";
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`agx-btn rounded disabled:opacity-40 ${small ? "text-[10px] px-2 py-0.5" : "text-[10.5px] px-2.5 py-1"}`}
      style={{
        color: primary ? "var(--bg)" : danger ? "var(--error)" : ok ? "var(--success)" : warn ? "var(--warning)" : "var(--text2)",
        background: primary ? "var(--primary)" : warn ? "color-mix(in srgb, var(--warning) 16%, transparent)" : "transparent",
        border: `1px solid color-mix(in srgb, ${edge} ${primary ? 100 : warn ? 55 : 50}%, transparent)`,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: primary || warn ? 500 : 400,
      }}>{children}</button>
  );
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

/**
 * The typography for rendered markdown.
 *
 * A stylesheet rather than inline styles because these rules are about
 * descendants — a heading inside a comment, a cell inside a table — which
 * inline styles cannot reach. `.agx-md` scopes every one of them.
 */
export const MD_CSS = `
/* Feedback, so a press is legible before the work behind it finishes.
   :active answers within one frame; :focus-visible keeps the keyboard
   visible; [data-busy] dims the label and blocks a second press without
   resizing the button, so the row does not jump under the cursor. */
.agx-btn{transition:background .13s,border-color .13s,color .13s,transform .07s}
.agx-btn:active:not(:disabled){transform:translateY(1px) scale(.99)}
.agx-btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.agx-btn[data-busy]{pointer-events:none;opacity:.6}
/* margin:0, not "0 auto". The measure is still capped for reading, but a
   centred column inside a card sets the body 380px away from the author name
   above it, which reads as a layout fault rather than as typography. */
/* One timeline, one rail. The node says what kind of thing happened; the
   rail says they happened in an order. */
.agx-tl{position:relative;padding-left:26px}
.agx-tl::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;border-radius:2px;background:color-mix(in srgb,var(--border) 42%,transparent)}
.agx-ev{position:relative;margin-bottom:10px}
.agx-ev:last-child{margin-bottom:0}
.agx-node{position:absolute;left:-26px;top:6px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:9px;background:var(--bg);border:2px solid color-mix(in srgb,var(--border) 50%,transparent)}
/* A small event — opened, force-pushed, review requested. It sits on the same
   rail as the comments but weighs a fraction of one, because it is context
   rather than something anybody said. */
.agx-tiny{position:relative;display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--text3);padding:3px 0;margin-bottom:10px}
.agx-tiny .agx-node{top:1px;width:18px;height:18px;left:-26px}
.agx-tiny b{color:var(--text2);font-weight:500}
/* menus */
.agx-menu{background:var(--bg);border:1px solid color-mix(in srgb,var(--primary) 40%,transparent);box-shadow:0 20px 50px -20px #000}
.agx-mi:hover{background:color-mix(in srgb,var(--primary) 12%,transparent);color:var(--text)}
.agx-mi:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
/* the "＋" that adds a reviewer or a label, inline with the values it extends */
.agx-inline-add{font-size:10px;padding:1px 6px;border-radius:5px;color:var(--text3);border:1px solid color-mix(in srgb,var(--border) 50%,transparent);transition:color .13s,border-color .13s,background .13s}
.agx-inline-add:hover:not(:disabled){color:var(--primary);border-color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,transparent)}
.agx-inline-add:disabled{opacity:.4;cursor:not-allowed}
/* the viewed switch on a file header — a checkbox does not read as a state you
   are keeping, and "viewed" is state you keep across a whole review */
.agx-sw{position:relative;width:24px;height:14px;border-radius:8px;flex:none;background:color-mix(in srgb,var(--border) 50%,transparent);transition:background .17s}
.agx-sw::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--text3);transition:transform .17s,background .17s}
.agx-sw[data-on="1"]{background:color-mix(in srgb,var(--success) 55%,transparent)}
.agx-sw[data-on="1"]::after{transform:translateX(10px);background:var(--success)}
.agx-hl pre{margin:0;padding:10px 12px;border-radius:8px;overflow-x:auto;background:color-mix(in srgb,#000 42%,transparent) !important;border:1px solid color-mix(in srgb,var(--border) 30%,transparent)}
.agx-hl code{font-size:11.5px;line-height:1.65}
.agx-md .agx-hl{margin:0 0 .85em}
.agx-md{max-width:78ch;margin:0;line-height:1.7;font-size:12.5px;color:var(--text2)}
.agx-md>*:first-child{margin-top:0}
.agx-md>*:last-child{margin-bottom:0}
.agx-md p{margin:0 0 .85em}
.agx-md h1,.agx-md h2,.agx-md h3,.agx-md h4,.agx-md h5,.agx-md h6{color:var(--text);font-weight:600;line-height:1.3;margin:1.5em 0 .5em}
.agx-md h1{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid color-mix(in srgb,var(--border) 35%,transparent)}
.agx-md h2{font-size:1.25em;padding-bottom:.25em;border-bottom:1px solid color-mix(in srgb,var(--border) 28%,transparent)}
.agx-md h3{font-size:1.1em}
.agx-md h4,.agx-md h5,.agx-md h6{font-size:1em;color:var(--text2)}
.agx-md a{color:var(--primary);text-underline-offset:2px}
.agx-md strong{color:var(--text);font-weight:600}
.agx-md del{opacity:.6}
.agx-md code{font-family:var(--diff-font,ui-monospace,monospace);font-size:.88em;background:color-mix(in srgb,var(--border) 30%,transparent);padding:.15em .4em;border-radius:4px;color:var(--text)}
.agx-md pre{background:var(--bg);border:1px solid color-mix(in srgb,var(--border) 40%,transparent);border-radius:6px;padding:.7em .9em;overflow-x:auto;margin:0 0 .9em}
.agx-md pre code{background:none;padding:0;font-size:.92em;line-height:1.55;color:var(--text2)}
.agx-md blockquote{margin:0 0 .9em;padding:.15em 0 .15em .9em;border-left:3px solid color-mix(in srgb,var(--primary) 45%,transparent);color:var(--text3)}
.agx-md ul,.agx-md ol{margin:0 0 .85em;padding-left:1.5em}
.agx-md li{margin-bottom:.3em}
.agx-md li::marker{color:var(--primary)}
.agx-md .agx-task{list-style:none;padding-left:0}
.agx-md .agx-task li{display:flex;gap:.55em;align-items:flex-start}
.agx-md .agx-box{flex:none;width:13px;height:13px;margin-top:.28em;border-radius:3px;border:1px solid color-mix(in srgb,var(--border) 70%,transparent);display:inline-flex;align-items:center;justify-content:center;font-size:9px;line-height:1}
.agx-md .agx-box[data-on="1"]{background:var(--primary);border-color:var(--primary);color:var(--bg)}
.agx-md .agx-tw{overflow-x:auto;margin:0 0 .9em;max-width:100%}
.agx-md table{border-collapse:collapse;font-size:.95em}
.agx-md th{text-align:left;padding:.4em .8em;background:color-mix(in srgb,var(--border) 22%,transparent);color:var(--text);font-weight:600;border:1px solid color-mix(in srgb,var(--border) 40%,transparent);white-space:nowrap}
.agx-md td{padding:.4em .8em;border:1px solid color-mix(in srgb,var(--border) 30%,transparent);vertical-align:top}
.agx-md tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--border) 10%,transparent)}
.agx-md hr{border:0;border-top:1px solid color-mix(in srgb,var(--border) 40%,transparent);margin:1.2em 0}
.agx-md figure{margin:0 0 .9em}
.agx-md figure img{max-width:100%;border-radius:6px;border:1px solid color-mix(in srgb,var(--border) 40%,transparent);display:block}
.agx-md figcaption{font-size:.85em;color:var(--text3);margin-top:.35em}
`;

/** One markdown block. Images go through the proxy — GitHub's own attachment
 *  URLs answer 404 without the token, and those are the review's evidence. */
function Block({ b }: { b: MdBlock }) {
  if (b.kind === "heading") {
    const H = (["h1", "h2", "h3", "h4", "h5", "h6"][b.level - 1] ?? "h6") as "h1";
    return <H dangerouslySetInnerHTML={{ __html: b.html }} />;
  }
  if (b.kind === "para") return <p dangerouslySetInnerHTML={{ __html: b.html }} />;
  if (b.kind === "rule") return <hr />;
  if (b.kind === "code") return <CodeBlock text={b.text} lang={b.lang} />;
  if (b.kind === "quote") return <blockquote dangerouslySetInnerHTML={{ __html: b.html }} />;
  if (b.kind === "image") {
    return (
      <figure>
        <img src={api.prAssetUrl(b.src)} alt={b.alt} loading="lazy" />
        {b.alt && <figcaption>{b.alt}</figcaption>}
      </figure>
    );
  }
  if (b.kind === "table") {
    return (
      <div className="agx-tw agx-scroll">
        <table>
          <thead><tr>{b.head.map((h, i) => <th key={i} dangerouslySetInnerHTML={{ __html: h }} />)}</tr></thead>
          <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} dangerouslySetInnerHTML={{ __html: c }} />)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  const isTask = b.items.some((i) => i.checked !== undefined);
  const List = b.ordered ? "ol" : "ul";
  return (
    <List className={isTask ? "agx-task" : undefined}>
      {b.items.map((it, i) => (
        <li key={i} style={it.depth ? { marginLeft: it.depth * 14 } : undefined}>
          {it.checked !== undefined && <span className="agx-box" data-on={it.checked ? "1" : "0"}>{it.checked ? "✓" : ""}</span>}
          <span dangerouslySetInnerHTML={{ __html: it.html }} />
        </li>
      ))}
    </List>
  );
}

/**
 * A fenced code block, tokenised by the same shiki highlighter the diff
 * surfaces already use. The parser has carried `lang` since it was written;
 * the renderer dropped it and printed plain text, so a code reference from a
 * person or a bot arrived as prose. Falls back to plain text while the
 * highlighter loads and whenever the language is unknown — a block that
 * renders unstyled is fine, one that renders late or blank is not.
 */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const id = (lang || "").toLowerCase();
    if (!id) return;
    (async () => {
      try {
        const hl = await getHighlighter();
        await hl.loadLanguage(id as never).catch(() => {});
        if (!hl.getLoadedLanguages().includes(id)) return;
        const out = hl.codeToHtml(text, { lang: id as never, theme: shikiTheme() });
        if (live) setHtml(out);
      } catch { /* unstyled is a fine outcome */ }
    })();
    return () => { live = false; };
  }, [text, lang]);
  if (html) return <div className="agx-hl" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre><code>{text}</code></pre>;
}

export function Md({ body, className }: { body: string; className?: string }) {
  const blocks = useMemo(() => parseBody(body), [body]);
  if (!body?.trim()) return null;
  return <div className={`agx-md ${className ?? ""}`}>{blocks.map((b, i) => <Block key={i} b={b} />)}</div>;
}

// ---------------------------------------------------------------------------
// diff, through the app's own viewer
// ---------------------------------------------------------------------------

/** A parsed diff in the shape ChangesModal's viewer speaks. The synthetic
 *  fields are inert — that component reads path, counts and hunks. */
function toFileChange(f: ParsedFile, i: number): FileChange {
  return {
    id: i, timestamp: 0, source_app: "github", session_id: "pr", tool: "PullRequest",
    file_path: f.path, additions: f.additions, deletions: f.deletions, hunks: f.hunks,
  };
}

function DiffPane({ file, split, wrap, onComment }: {
  file: FileChange; split: boolean; wrap: boolean;
  onComment?: (line: number) => void;
}) {
  // `hunkAction` is the seam the viewer already offers. A comment anchors to
  // the last added line of its hunk — the line you are almost always talking
  // about — falling back to the hunk's last line when it only removes.
  const action = onComment
    ? (hi: number) => {
        const h = file.hunks[hi];
        if (!h) return null;
        const nums = newLineNumbers(h);
        let target = 0;
        h.lines.forEach((l, i) => { if (l.startsWith("+") && nums[i]) target = nums[i]!; });
        if (!target) for (let i = nums.length - 1; i >= 0; i--) if (nums[i]) { target = nums[i]!; break; }
        if (!target) return null;
        return <button onClick={() => onComment(target)} className="text-[10px] px-1.5 rounded"
          style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}
          title={`Comment on line ${target}`}>+ Comment</button>;
      }
    : undefined;
  return split ? <SplitDiff c={file} wrap={wrap} /> : <UnifiedDiff c={file} wrap={wrap} hunkAction={action} />;
}

// ---------------------------------------------------------------------------
// list row
// ---------------------------------------------------------------------------

/** Placeholder rows while the list is on its way.
 *
 *  A spinner says "wait"; these say "a list is coming, roughly this shape",
 *  which is the difference between a pane that feels slow and one that feels
 *  broken. `prefers-reduced-motion` drops the shimmer, not the placeholder. */
function Skeletons({ n = 6 }: { n?: number }) {
  return (
    <div aria-hidden>
      <style>{`@keyframes agxpulse{0%,100%{opacity:.35}50%{opacity:.7}}
@media (prefers-reduced-motion:reduce){.agx-sk{animation:none!important}}`}</style>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="px-2.5 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
          <div className="agx-sk rounded" style={{
            height: 8, width: `${58 + ((i * 13) % 34)}%`, background: "color-mix(in srgb, var(--border) 55%, transparent)",
            animation: `agxpulse 1.4s ease-in-out ${i * 0.09}s infinite`,
          }} />
          <div className="agx-sk rounded mt-1.5" style={{
            height: 6, width: `${30 + ((i * 7) % 20)}%`, background: "color-mix(in srgb, var(--border) 38%, transparent)",
            animation: `agxpulse 1.4s ease-in-out ${i * 0.09 + 0.2}s infinite`,
          }} />
        </div>
      ))}
    </div>
  );
}

function PrRow({ p, active, onSelect }: { p: PrSummary; active: boolean; onSelect: () => void }) {
  const c = p.checks;
  return (
    <button onClick={onSelect} className="w-full text-left px-2.5 py-1.5 border-b"
      style={{
        borderColor: "color-mix(in srgb, var(--border) 22%, transparent)",
        background: active ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent",
        boxShadow: active ? "inset 2px 0 0 var(--primary)" : undefined,
      }}>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>#{p.number}</span>
        <span className="text-[11.5px] truncate" style={{ color: "var(--text)" }}>{p.title}</span>
        {p.isCurrentBranch && <Chip text="here" tint="var(--primary)" title="This checkout is on that branch" />}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 text-[10px]" style={{ color: "var(--text3)" }}>
        <Dot tint={p.checksLoaded === false ? "var(--text3)" : stateTint(p)}
          title={p.checksLoaded === false ? "Check states are still loading" : `${c.success} passed · ${c.failure} failed · ${c.skipped} skipped · ${c.pending} running`} />
        <span className="tabular-nums">
          {/* Not yet fetched is not the same as none. Saying "no checks" here
              would be a claim about the repository rather than about us. */}
          {p.checksLoaded === false ? "Checks…"
            : c.total === 0 ? "No checks"
            : c.pending > 0 ? `${c.total - c.pending}/${c.total}`
            : c.failure > 0 ? `${c.failure} failing` : "Green"}
        </span>
        {p.isDraft ? <Chip text="draft" tint="var(--text3)" /> : <ReviewChip d={p.reviewDecision} />}
        <span className="ml-auto shrink-0">{ago(p.updatedAt)}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

export function PrView({ active, onOpenChatWith }: { active: boolean; onOpenChatWith?: (cwd: string, prompt: string) => void }) {
  const sidebarW = useSidebarWidth();
  const { ask, askText, dialog } = useDialogs();

  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");
  const [repo, setRepo] = useState<PrRepoId | null>(null);
  /** The panel opens on what is waiting on you, not on what you wrote — that
   *  is the question a review dashboard exists to answer. If nothing is waiting
   *  the first load falls through to your own pull requests once, so opening it
   *  never lands on an empty pane. */
  const [filter, setFilter] = useState<Filter>("review");
  const fellBack = useRef(false);
  // The filter query for the current scope tab — the single source of truth for
  // both the search box and every facet dropdown (parsed in lib/prFilter.ts).
  // Cleared when the scope changes so each tab (mine / review / all) starts
  // fresh; "all" can be hundreds of rows and a facet beats scrolling.
  const [query, setQuery] = useState("");
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [counts, setCounts] = useState<Partial<Record<Filter, number>>>({});
  const [listState, setListState] = useState<{ fetchedAt: number; loading: boolean; checksPending?: boolean; error?: string; needsAuth?: boolean }>({ fetchedAt: 0, loading: false });
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [rawBots, setRawBots] = useState(false);
  const [seen, setSeen] = useState<Record<string, string[]>>(() => loadMap<string[]>(SEEN_KEY));
  const [drafts, setDrafts] = useState<Record<string, DraftComment[]>>(() => loadMap<DraftComment[]>(DRAFT_KEY));
  const [diff, setDiff] = useState("");
  const [selFile, setSelFile] = useState<string | null>(null);
  const [selCommit, setSelCommit] = useState<string | null>(null);
  const [commitText, setCommitText] = useState("");
  const [commitBusy, setCommitBusy] = useState(false);
  const [split, setSplit] = useState(true);
  const [wrap, setWrap] = useState(false);
  const detailReq = useRef(0);
  /** Which list request is current. A filter's answer takes seconds, and
   *  without this the slower reply from the filter you just left overwrites the
   *  one you switched to — the old selection reappearing under the new tab. */
  const listReq = useRef(0);
  /** Which whole-PR diff / commit diff is current. Same shape as listReq: the
   *  diff of a pull request (or commit) you have since left can take seconds to
   *  arrive, and without this its late reply overwrites the one you switched to. */
  const diffReq = useRef(0);
  const commitReq = useRef(0);

  const flash = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    if (!active) return;
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      setRoot((cur) => cur || repos[0]?.root || "");
    }).catch(() => {});
  }, [active]);

  const loadList = useCallback((force = false) => {
    if (!root) return;
    const req = ++listReq.current;
    const want = filter;
    api.prList(root, filter, force).then((r) => {
      if (req !== listReq.current) return; // a newer request already won
      setRepo(r.repo);
      setPrs(r.prs);
      setCounts((c) => ({ ...c, [want]: r.prs.length }));
      setListState({ fetchedAt: r.fetchedAt, loading: r.loading, checksPending: r.checksPending, error: r.error, needsAuth: r.needsAuth });
      setSelected((cur) => (cur && r.prs.some((p) => p.number === cur) ? cur : r.prs[0]?.number ?? null));
      // Nothing waiting on you: show your own instead of an empty pane. Once
      // only, so choosing "Needs my review" yourself is never overruled.
      if (want === "review" && r.prs.length === 0 && !r.loading && !r.error && !fellBack.current) {
        fellBack.current = true;
        setFilter("mine");
      }
    }).catch((e) => {
      if (req !== listReq.current) return;
      setListState({ fetchedAt: 0, loading: false, error: String(e) });
    });
  }, [root, filter]);

  /**
   * Switching filter empties the pane before anything is fetched.
   *
   * Otherwise the previous filter's selection stays on screen for the second or
   * two the new list takes, and you are reading one pull request under a tab
   * that says you are looking at another.
   */
  const lastScope = useRef<string>("");
  useEffect(() => {
    const scope = `${root}\u0000${filter}`;
    if (lastScope.current === scope) return; // re-render, not a switch
    const first = lastScope.current === "";
    lastScope.current = scope;
    if (first) return; // nothing on screen yet to clear
    listReq.current++;
    setPrs([]);
    setSelected(null);
    setDetail(null);
    setDetailErr("");
    setListState((st) => ({ ...st, loading: true, fetchedAt: 0 }));
  }, [filter, root]);

  // Polling pauses while the view is hidden — no point spending requests on a
  // pane nobody is looking at — and resumes on return. Resuming refreshes; it
  // does not reset.


  /**
   * Warm the filters you are not looking at.
   *
   * Each is its own cache entry on the server, so the first visit to a tab
   * always paid the whole fetch. Touching them once fills the counts and leaves
   * a warm cache to switch into. Staggered, because the server has one thread
   * and three `gh` calls at once is the stall this panel exists to avoid.
   */
  useEffect(() => {
    if (!active || !root) return;
    const others = (["mine", "review", "all"] as Filter[]).filter((f) => f !== filter);
    const timers = others.map((f, i) => setTimeout(() => {
      api.prList(root, f, false)
        .then((r) => setCounts((c) => ({ ...c, [f]: r.prs.length })))
        .catch(() => {});
    }, 1200 + i * 2500));
    return () => timers.forEach(clearTimeout);
  }, [active, root, filter]);

  const loadDetail = useCallback((n: number, force = false) => {
    const req = ++detailReq.current;
    setDetailErr("");
    api.prDetail(root, n, force).then((r) => {
      if (req !== detailReq.current) return; // a later selection already won
      if (r.ok && r.detail) setDetail(r.detail);
      // A refresh that fails leaves what is on screen alone: the pull request
      // you are reading is better than an error where it used to be.
      else if (!force) setDetailErr(r.error || "");
      else { setDetail(null); setDetailErr(r.error || "Could not load this pull request"); }
    }).catch((e) => { if (req === detailReq.current) setDetailErr(String(e)); });
  }, [root]);

  useEffect(() => {
    if (!active || !root) return;
    loadList();
    const t = setInterval(() => {
      loadList();
      // Keep the open pull request current too. This reads the server's cache,
      // so it only reaches the network when that entry has actually aged out —
      // without it, a comment left while you are reading never appears until
      // you navigate away and back.
      const n = selectedRef.current;
      if (n != null) loadDetail(n);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active, root, filter, loadList, loadDetail]);

  /**
   * Load a pull request when the SELECTION changes — never merely because the
   * view became visible again.
   *
   * This effect used to list `active`, so stepping away to the terminal and
   * coming back re-ran it: the open commit, the open file and the fetched diff
   * were all thrown away and the pane went back to "loading". You lost your
   * place for having looked somewhere else for a moment. The view stays mounted
   * the whole time — only its visibility changes — so there is nothing to
   * restore and nothing to reload.
   */
  const loadedFor = useRef<number | null>(null);
  const selectedRef = useRef<number | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    if (!root || selected == null) { setDetail(null); loadedFor.current = null; return; }
    if (loadedFor.current === selected) return; // same pull request, already here
    loadedFor.current = selected;
    // Clear the previous PR's detail so the pane shows "loading #N" instead of
    // the last PR's data while the new one is in flight. Without this a PR→PR
    // jump silently keeps the old content on screen and reads as a dead click.
    // (The poll-refresh path in loadDetail deliberately keeps the current detail
    // on a failed refresh; that path does not run this effect.)
    setDetail(null); setDetailErr("");
    setDiff(""); setSelFile(null); setSelCommit(null); setCommitText("");
    loadDetail(selected);
  }, [root, selected, loadDetail]);

  useEffect(() => {
    if ((tab !== "files" && tab !== "review") || !detail || diff || !root) return;
    const req = ++diffReq.current; // a later selection's diff must win over a slow earlier one
    api.prDiff(root, detail.number).then((r) => { if (req === diffReq.current) setDiff(r.ok ? (r.text || "") : ""); }).catch(() => {});
  }, [tab, detail, diff, root]);

  // Filter the current scope's rows by the search box: PR number (with or
  // without a leading #), title, or author login. Memoized so a 400-row "all"
  // list does not re-scan on every keystroke or re-render.
  // The query string is the single source of truth; the facet dropdowns are
  // editors of it (see lib/prFilter.ts). `filters` is a pure derivation, never
  // stored, so the bar and the menus can never disagree.
  const filters = useMemo(() => parseQuery(query), [query]);
  const visiblePrs = useMemo(() => applyFilters(prs, filters), [prs, filters]);
  const facets = useMemo(() => buildFacets(prs, filters), [prs, filters]);

  /** What each view last counted.
   *
   *  Only the scope currently loaded has rows to count, so a view on another
   *  scope can only report what it last saw — the same deal the panel already
   *  makes for the list itself, which shows its own age rather than pretending
   *  to be live. A view that has never been loaded shows no number at all,
   *  because a made-up one next to "Failing" is worse than none: you would act
   *  on it. */
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (listState.loading) return;
    const seen: Record<string, number> = {};
    for (const v of VIEWS) if (v.scope === filter) seen[v.id] = applyFilters(prs, parseQuery(v.query)).length;
    setViewCounts((cur) => ({ ...cur, ...seen }));
  }, [prs, filter, listState.loading]);

  const viewCount = useCallback((v: (typeof VIEWS)[number]): number | null => {
    if (v.scope === filter && !listState.loading) return applyFilters(prs, parseQuery(v.query)).length;
    return viewCounts[v.id] ?? (v.query ? null : counts[v.scope] ?? null);
  }, [filter, prs, counts, viewCounts, listState.loading]);

  const activeView = VIEWS.find((v) => v.scope === filter && v.query === query.trim());

  // If the selected row is filtered out, move the selection to the first row
  // still visible rather than leaving a phantom highlight on a hidden PR — the
  // same reconciliation loadList does when the list itself changes. Only when a
  // selection existed; never auto-selects out of the empty initial state.
  useEffect(() => {
    if (selected != null && !visiblePrs.some((p) => p.number === selected)) {
      setSelected(visiblePrs[0]?.number ?? null);
    }
  }, [visiblePrs, selected]);

  // Keyboard nav over the list, keyboard-first like the files tab (which relies
  // on the same thing: App.tsx ignores bare letters while the workspace is open,
  // so j/k/n/p are free here). Selection is derived, not a second state.
  const listRef = useRef<HTMLDivElement>(null);
  const stepSel = (d: number) => {
    if (!visiblePrs.length) return;
    const i = visiblePrs.findIndex((p) => p.number === selected);
    const ni = i < 0 ? (d > 0 ? 0 : visiblePrs.length - 1) : (i + d + visiblePrs.length) % visiblePrs.length;
    setSelected(visiblePrs[ni].number);
    setTab("overview");
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const inInput = /input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "");
    if (e.key === "/" && !inInput) {
      e.preventDefault();
      (document.querySelector("[data-pr-filter-input]") as HTMLInputElement | null)?.focus();
      return;
    }
    if (inInput) { if (e.key === "Escape") (e.target as HTMLElement).blur(); return; }
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); stepSel(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); stepSel(-1); }
    else if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); }
  };
  // Make the list keyboard-ready the moment the panel opens, but never steal
  // focus from a field the user is already in (only claim it off <body>).
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => { if (document.activeElement === document.body) listRef.current?.focus(); });
  }, [active]);

  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const byPath = useMemo(() => {
    const m = new Map<string, FileChange>();
    parsed.forEach((f, i) => m.set(f.path, toFileChange(f, i)));
    return m;
  }, [parsed]);

  const openCommit = useCallback((sha: string) => {
    const req = ++commitReq.current; // invalidates any in-flight commit diff, whether opening another or closing
    if (!root || !sha) { setSelCommit(null); return; }
    setSelCommit(sha); setCommitText(""); setCommitBusy(true);
    api.prCommitDiff(root, sha)
      .then((r) => { if (req === commitReq.current) setCommitText(r.ok ? (r.text || "") : ""); })
      .catch(() => { if (req === commitReq.current) setCommitText(""); })
      .finally(() => { if (req === commitReq.current) setCommitBusy(false); });
  }, [root]);

  const commitFiles = useMemo(() => parseUnifiedDiff(commitText).map(toFileChange), [commitText]);

  const act = useCallback(async (label: string, fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const r = await fn();
      flash(r.ok, r.ok ? (r.detail || `${label} — done`) : (r.error || `${label} failed`));
      if (r.ok) { loadList(true); if (selected != null) loadDetail(selected, true); }
      return r.ok;
    } catch (e) { flash(false, String(e)); return false; }
    finally { setBusy(false); }
  }, [busy, flash, loadList, selected, loadDetail]);

  const key = repo && detail ? `${repo.key}#${detail.number}` : "";
  const seenFiles = key ? (seen[key] ?? []) : [];
  const myDrafts = key ? (drafts[key] ?? []) : [];

  const toggleSeen = (path: string) => {
    if (!key) return;
    setSeen((cur) => {
      const list = new Set(cur[key] ?? []);
      if (list.has(path)) list.delete(path); else list.add(path);
      const next = { ...cur, [key]: [...list] };
      saveMap(SEEN_KEY, next);
      return next;
    });
  };

  const addDraft = async (path: string, line: number) => {
    const body = await askText({
      title: `Comment on ${path.split("/").pop()}:${line}`,
      body: "Queued with the rest of your review — nothing is sent until you submit.",
      confirmLabel: "Add to review",
      input: { label: "Comment", placeholder: "What needs to change here…" },
    });
    if (!body?.trim() || !key) return;
    setDrafts((cur) => {
      const next = { ...cur, [key]: [...(cur[key] ?? []), { path, line, body: body.trim() }] };
      saveMap(DRAFT_KEY, next);
      return next;
    });
    flash(true, `Queued — ${(myDrafts.length + 1)} pending comment${myDrafts.length ? "s" : ""}`);
  };

  const dropDraft = (i: number) => {
    if (!key) return;
    setDrafts((cur) => {
      const next = { ...cur, [key]: (cur[key] ?? []).filter((_, j) => j !== i) };
      saveMap(DRAFT_KEY, next);
      return next;
    });
  };

  const submitReview = async (verb: "approve" | "request_changes" | "comment", body: string) => {
    if (!detail) return;
    const ok = await act("Review", () => api.prReviewWith(root, detail.number, verb, body, myDrafts));
    if (ok && key) {
      setDrafts((cur) => { const next = { ...cur, [key]: [] }; saveMap(DRAFT_KEY, next); return next; });
      setTab("conversation");
    }
  };

  const doMerge = async () => {
    if (!detail) return;
    const head = detail.commits[detail.commits.length - 1]?.oid;
    const ok = await ask({
      title: `Merge #${detail.number} into ${detail.baseRefName}?`,
      body: `${detail.title}\n\nSquash and merge, then delete the branch. This is public and cannot be undone from here.` +
        (head ? `\n\nPinned to ${head.slice(0, 8)} — if anyone pushes before this lands, GitHub refuses rather than merging a commit you have not seen.` : ""),
      confirmLabel: "Squash & merge", danger: true,
    });
    if (!ok) return;
    await act("Merge", () => api.prMerge(root, detail.number, "squash", { deleteBranch: true, headSha: head }));
  };

  const doClose = async () => {
    if (!detail) return;
    const ok = await ask({
      title: `Close #${detail.number}?`,
      body: `${detail.title}\n\nClosed without merging. You can reopen it afterwards.`,
      confirmLabel: "Close pull request", danger: true,
    });
    if (!ok) return;
    await act("Close", () => api.prClose(root, detail.number));
  };

  const doLocalReview = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await api.prLocalReview(root, detail.number);
      if (!r.ok || !r.cwd || !r.prompt) { flash(false, r.error || "Could not prepare the review"); return; }
      if (onOpenChatWith) { onOpenChatWith(r.cwd, r.prompt); flash(true, `Checked out #${detail.number} — review waiting in chat`); }
      else flash(true, `Checked out at ${r.cwd}`);
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  const doEditTitle = async () => {
    if (!detail) return;
    const title = await askText({ title: `Rename #${detail.number}`, confirmLabel: "Save", input: { label: "Title", initial: detail.title } });
    if (!title?.trim() || title.trim() === detail.title) return;
    await act("Edit title", () => api.prEdit(root, detail.number, { title: title.trim() }));
  };

  const doEditBody = async (body: string) => {
    if (!detail) return false;
    return act("Description", () => api.prEdit(root, detail.number, { body }));
  };

  /** Labels and reviewers both take a comma-separated list and diff it against
   *  what is already there, so one box does both adding and removing. */
  const doLabels = async () => {
    if (!detail) return;
    const cur = detail.labels.map((l) => l.name);
    const next = await askText({
      title: `Labels on #${detail.number}`, confirmLabel: "Save",
      input: { label: "Comma-separated — remove one by deleting it", initial: cur.join(", ") },
    });
    if (next == null) return;
    const want = next.split(",").map((s) => s.trim()).filter(Boolean);
    const add = want.filter((l) => !cur.includes(l));
    const remove = cur.filter((l) => !want.includes(l));
    if (add.length === 0 && remove.length === 0) return;
    await act("Labels", () => api.prLabels(root, detail.number, add, remove));
  };

  const doReviewers = async () => {
    if (!detail) return;
    const cur = detail.reviewers;
    const next = await askText({
      title: `Reviewers on #${detail.number}`, confirmLabel: "Save",
      input: { label: "Comma-separated logins — remove one by deleting it", initial: cur.join(", ") },
    });
    if (next == null) return;
    const want = next.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
    const add = want.filter((l) => !cur.includes(l));
    const remove = cur.filter((l) => !want.includes(l));
    if (add.length === 0 && remove.length === 0) return;
    await act("Reviewers", () => api.prReviewers(root, detail.number, add, remove));
  };

  const doCopyLink = async () => {
    if (!detail) return;
    try { await navigator.clipboard.writeText(detail.url); flash(true, "Link copied"); }
    catch { flash(false, "Could not reach the clipboard"); }
  };

  /** Hand a failing check to the chat with the pull request already checked out,
   *  so the answer is written against the code that failed rather than a guess
   *  from the name of the job. */
  const askClaudeAboutCheck = async (check: PrCheck) => {
    if (!detail || !onOpenChatWith) return;
    setBusy(true);
    try {
      const r = await api.prLocalReview(root, detail.number);
      if (!r.ok || !r.cwd) { flash(false, r.error || "Could not check the pull request out"); return; }
      onOpenChatWith(r.cwd,
        `The check "${check.name}"${check.workflow ? ` in the ${check.workflow} workflow` : ""} is failing on pull request #${detail.number} (${detail.title}).\n\n` +
        `This worktree is on ${detail.headRefName}. Work out why it is failing and propose the fix.` +
        (check.url ? `\n\nThe run is at ${check.url}.` : ""));
      flash(true, `Checked out #${detail.number} — the failure is waiting in chat`);
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  const doComment = async (body: string) => {
    if (!detail) return false;
    return act("Comment", () => api.prComment(root, detail.number, body));
  };

  const lanes = useMemo(() => {
    if (!detail) return { humans: [] as PrReview[], botReviews: [] as PrReview[], humanComments: [] as PrComment[], bots: [] as PrComment[] };
    // Oldest first, the way a conversation is read — GitHub's order, and the
    // one the replies were written in. The API hands these back newest-first,
    // so a thread arrived answered before it was asked.
    const byTime = <T,>(xs: T[], at: (x: T) => string) =>
      [...xs].sort((p, q) => at(p).localeCompare(at(q)));
    return {
      humans: byTime(detail.reviews.filter((r) => !r.isBot && (r.body.trim() || r.state !== "COMMENTED")), (r) => r.submittedAt),
      botReviews: byTime(detail.reviews.filter((r) => r.isBot && r.body.trim()), (r) => r.submittedAt),
      humanComments: byTime(detail.comments.filter((c) => !c.isBot), (c) => c.createdAt),
      bots: byTime(detail.comments.filter((c) => c.isBot), (c) => c.createdAt),
    };
  }, [detail]);

  const openThreads = useMemo(() => (detail?.threads ?? []).filter((t) => !t.isResolved), [detail]);
  const d = detail;

  // You cannot review your own pull request — GitHub does not offer it either,
  // and a review control on every row buries the ones actually waiting on you.
  const canReview = !!d && !d.viewerDidAuthor;

  const TABS: { id: Tab; label: string; n?: number; warn?: boolean }[] = d ? [
    { id: "overview", label: "Overview" },
    { id: "conversation", label: "Conversation", n: lanes.humans.length + lanes.humanComments.length + d.threads.length + lanes.bots.length },
    { id: "commits", label: "Commits", n: d.commits.length },
    { id: "files", label: "Files", n: d.files.length },
    { id: "checks", label: "Checks", n: d.checks.total, warn: d.checks.failure > 0 },
    ...(canReview ? [{ id: "review" as Tab, label: "Review", n: myDrafts.length || undefined, warn: d.viewerRequested }] : []),
  ] : [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <style>{SCROLLBAR_CSS}{MD_CSS}</style>

      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <span className={viewTitleClass} style={{ color: "var(--text)" }}>Pull Requests</span>
        {repos.length > 1 ? (
          <select value={root} onChange={(e) => { setRoot(e.target.value); setSelected(null); setDetail(null); }}
            title={repo?.nameWithOwner}
            className="text-[10px] px-1 py-0.5 rounded bg-transparent max-w-[220px]"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
            {repos.map((r) => <option key={r.root} value={r.root} style={{ background: "var(--bg)" }}>{r.root.split("/").pop()}</option>)}
          </select>
        ) : repo && <span className="text-[10px] truncate" style={{ color: "var(--text3)" }}>{repo.nameWithOwner}</span>}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {toast && <span className="text-[10px] max-w-[380px] truncate" style={{ color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</span>}
          <span className="text-[10px] tabular-nums" style={{ color: listState.loading || listState.checksPending ? "var(--warning)" : "var(--text3)" }}>
            {listState.loading ? "Loading pull requests…"
              : listState.checksPending ? "Loading check states…"
              : listState.fetchedAt ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}` : ""}
          </span>
          <Btn onClick={() => loadList(true)} disabled={busy} small>Refresh</Btn>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col min-h-0 shrink-0" style={{ width: sidebarW }}>
          <div className="flex gap-1 flex-wrap px-2 py-1.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
            {VIEWS.map((v) => {
              const n = viewCount(v);
              const on = activeView?.id === v.id;
              return (
                <button key={v.id} onClick={() => { setFilter(v.scope); setQuery(v.query); }} title={v.hint}
                  className="agx-btn text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0"
                  style={{
                    color: on ? "var(--bg)" : "var(--text2)",
                    background: on ? "var(--primary)" : "transparent",
                    border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
                  }}>
                  {v.tint && !on && <span className="rounded-full shrink-0" style={{ width: 5, height: 5, background: v.tint }} />}
                  {v.label}
                  {n != null && <span className="tabular-nums" style={{ opacity: on ? .8 : .75 }}>{n}</span>}
                </button>
              );
            })}
            {!activeView && (
              <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0 self-center"
                style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--border) 45%, transparent)" }}>Custom</span>
            )}
          </div>
          {repo && prs.length > 0 && (
            <PrFilterBar
              query={query}
              filters={filters}
              facets={facets}
              onQuery={setQuery}
              checksPending={listState.checksPending}
              shown={visiblePrs.length}
              total={prs.length}
            />
          )}
          <div ref={listRef} tabIndex={-1} onKeyDown={onListKey} className="flex-1 overflow-y-auto min-h-0 agx-scroll outline-none">
            {listState.needsAuth ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                <div style={{ color: "var(--warning)" }}>{listState.error || "The GitHub CLI is not set up"}</div>
                <div className="mt-2">Pull requests come from <code>gh</code>. Install it, run <code>gh auth login</code>, then refresh.</div>
              </div>
            ) : !repo ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>{listState.error || "No GitHub remote on this repository"}</div>
            ) : prs.length === 0 ? (
              listState.loading ? <Skeletons /> : (
                <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                  {filter === "mine" ? "No open pull requests of yours" : filter === "review" ? "Nothing waiting on your review" : "No open pull requests"}
                </div>
              )
            ) : visiblePrs.length === 0 ? (
              <div className="p-3 text-[11px] flex flex-col items-start gap-1.5" style={{ color: "var(--text3)" }}>
                <span>No pull requests match {activeCount(filters) === 1 ? "this filter" : "these filters"}.</span>
                <button onClick={() => setQuery("")} className="text-[10.5px] px-2 py-0.5 rounded hover:bg-white/5" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)" }}>Clear filters</button>
              </div>
            ) : visiblePrs.map((p) => (
              <PrRow key={p.number} p={p} active={p.number === selected} onSelect={() => { setSelected(p.number); setTab("overview"); }} />
            ))}
          </div>
        </div>

        <SidebarGrip />

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {!d ? (
            <div className="p-4 text-[11.5px]" style={{ color: "var(--text3)" }}>
              {detailErr ? detailErr
                : selected == null ? (listState.loading ? "Loading pull requests…" : "Select a pull request")
                : `Loading #${selected}…`}
            </div>
          ) : (
            <>
              <Masthead
                d={d} busy={busy}
                onEditTitle={doEditTitle} onDraft={() => act(d.isDraft ? "Mark ready" : "Convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                onClose={doClose} onLocalReview={doLocalReview}
                onLabels={doLabels} onReviewers={doReviewers} onCopyLink={doCopyLink}
              />
              <div className="flex border-b shrink-0 overflow-x-auto items-center" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                {TABS.map((t) => (
                  <button key={t.id} onClick={() => setTab(t.id)} className="text-[10.5px] px-3 py-1.5 whitespace-nowrap"
                    style={{
                      color: tab === t.id ? "var(--text)" : "var(--text3)",
                      borderBottom: `2px solid ${tab === t.id ? "var(--primary)" : "transparent"}`,
                      background: tab === t.id ? "color-mix(in srgb, var(--primary) 8%, transparent)" : "transparent",
                    }}>
                    {t.label}
                    {t.n != null && <span className="ml-1 tabular-nums opacity-60">{t.n}</span>}
                    {t.warn && <span className="ml-1" style={{ color: "var(--warning)" }}>●</span>}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-1.5 px-2 shrink-0">
                  {myDrafts.length > 0 && <Chip text={`${myDrafts.length} pending`} tint="var(--warning)" title="Line comments queued but not sent" />}
                  {d.viewerRequested && tab !== "review" && (
                    <Btn onClick={() => setTab("review")} primary small>Add your review</Btn>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0 agx-scroll p-3">
                {tab === "overview" && (
                  <Overview
                    d={d} busy={busy} openThreads={openThreads.length}
                    conversationCount={d.comments.length + d.reviews.length + d.threads.length}
                    onEditBody={doEditBody}
                    onLocalReview={doLocalReview} onMerge={doMerge} onClose={doClose}
                    onUpdateBranch={() => act("Update branch", () => api.prUpdateBranch(root, d.number))}
                    onRerun={() => act("Re-run checks", () => api.prRerun(root, d.number))}
                    onAutoMerge={() => act("Auto-merge", () => api.prMerge(root, d.number, "squash", { auto: true, deleteBranch: true }))}
                    onDraft={() => act(d.isDraft ? "Mark ready" : "Convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                    onGoThreads={() => setTab("conversation")}
                  />
                )}

                {tab === "conversation" && (
                  <Conversation
                    d={d} lanes={lanes} raw={rawBots} onRaw={setRawBots} busy={busy} onComment={doComment}
                    onResolve={(t) => act(t.isResolved ? "Unresolve" : "Resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                    onReply={async (t) => {
                      const first = t.comments[0];
                      if (typeof first?.databaseId !== "number") return;
                      const body = await askText({ title: `Reply on ${t.path}${t.line ? `:${t.line}` : ""}`, confirmLabel: "Reply", input: { label: "Reply" } });
                      if (!body?.trim()) return;
                      await act("Reply", () => api.prReply(root, d.number, first.databaseId as number, body));
                    }}
                  />
                )}

                {tab === "commits" && (
                  <div className="text-[11px]">
                    {d.commits.map((c) => (
                      <div key={c.oid}>
                        <button onClick={() => openCommit(selCommit === c.oid ? "" : c.oid)}
                          className="w-full text-left flex items-center gap-2 py-1.5 border-b"
                          style={{
                            borderColor: "color-mix(in srgb, var(--border) 18%, transparent)",
                            opacity: c.isMerge ? 0.55 : 1,
                            background: selCommit === c.oid ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent",
                          }}>
                          <span className="shrink-0" style={{ color: "var(--text3)" }}>{selCommit === c.oid ? "▾" : "▸"}</span>
                          <span className="tabular-nums shrink-0" style={{ ...CODE_FONT_STYLE, color: "var(--primary)" }}>{c.short}</span>
                          <span className="truncate" style={{ color: "var(--text2)" }}>{c.message}</span>
                          {c.isMerge && <Chip text="merge" tint="var(--text3)" title="Trunk catch-up, not work to review" />}
                          <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--text3)" }}>
                            <Avatar login={c.author} size={14} />{c.author}
                          </span>
                        </button>
                        {selCommit === c.oid && (
                          <div className="my-2">
                            {commitBusy ? <div className="text-[10.5px] p-2" style={{ color: "var(--text3)" }}>Loading the diff…</div>
                              : commitFiles.length === 0 ? <div className="text-[10.5px] p-2" style={{ color: "var(--text3)" }}>This commit changed nothing textual</div>
                              : <FileStack files={commitFiles} split={split} wrap={wrap} onSplit={setSplit} onWrap={setWrap} />}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {tab === "files" && (
                  <FilesTab
                    d={d} byPath={byPath} loaded={!!diff} seenFiles={seenFiles} onSeen={toggleSeen}
                    sel={selFile} onSel={setSelFile} split={split} wrap={wrap} onSplit={setSplit} onWrap={setWrap}
                    drafts={myDrafts} onAddDraft={addDraft}
                  />
                )}

                {tab === "checks" && (
                  <Checks
                    d={d} busy={busy}
                    onRerun={() => act("Re-run checks", () => api.prRerun(root, d.number))}
                    onAsk={onOpenChatWith ? (k) => askClaudeAboutCheck(k) : undefined}
                  />
                )}

                {tab === "review" && canReview && (
                  <ReviewTab
                    d={d} drafts={myDrafts} seen={seenFiles.length} busy={busy}
                    onDrop={dropDraft} onSubmit={submitReview} onGoFiles={() => setTab("files")}
                  />
                )}
              </div>

            </>
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

const MERGE_WHY: Record<string, string> = {
  BLOCKED: "A required review or check has not passed",
  BEHIND: "The base branch has moved — update the branch first",
  DIRTY: "There are conflicts with the base branch",
  UNSTABLE: "A check is failing",
  DRAFT: "This is a draft",
  HAS_HOOKS: "A repository hook is blocking the merge",
  UNKNOWN: "GitHub has not finished working it out",
};

function Overview({ d, busy, openThreads, conversationCount, onLocalReview, onMerge, onClose, onUpdateBranch, onRerun, onAutoMerge, onDraft, onGoThreads, onEditBody }: {
  d: PrDetail; busy: boolean; openThreads: number; conversationCount: number;
  onLocalReview: () => void; onMerge: () => void; onClose: () => void; onUpdateBranch: () => void;
  onRerun: () => void; onAutoMerge: () => void; onDraft: () => void; onGoThreads: () => void;
  onEditBody: (body: string) => Promise<boolean>;
}) {
  const c = d.checks;
  const canMerge = d.mergeState === "CLEAN";

  return (
    <div className="flex flex-col gap-3">
      {d.forcePushedSinceReview && (
        <div className="text-[10.5px] px-2.5 py-2 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          The author force-pushed after the last review — that review was for code that is no longer here.
        </div>
      )}

      {/* merge, and why not */}
      <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 38%, transparent)" }}>
        <div className="flex gap-2.5 items-start p-3">
          <span className="shrink-0 rounded-full flex items-center justify-center text-[13px]"
            style={{ width: 26, height: 26, background: canMerge ? "var(--success)" : "var(--error)", color: "var(--bg)" }}>
            {canMerge ? "✓" : "!"}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
              {canMerge ? "Ready to merge" : "Merging is blocked"}
            </span>
            <span className="block text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>
              {canMerge ? "Nothing is standing in the way" : (MERGE_WHY[d.mergeState] ?? "Not mergeable")}
            </span>
          </span>
        </div>

        <div style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
          {d.reviewDecision === "CHANGES_REQUESTED" && (
            <Reason tint="var(--error)" glyph="✕"><b style={{ color: "var(--text)", fontWeight: 500 }}>Changes requested</b> by a reviewer with write access</Reason>
          )}
          {openThreads > 0 && (
            <Reason tint="var(--warning)" glyph="◯" action={<button onClick={onGoThreads} style={{ color: "var(--primary)" }}>Go to thread</button>}>
              {openThreads} review thread{openThreads === 1 ? "" : "s"} still open — <span style={{ color: "var(--text3)" }}>a reply is not a resolve</span>
            </Reason>
          )}
          {c.failure > 0 && (
            <Reason tint="var(--error)" glyph="✕">{c.failing.slice(0, 2).map((f) => f.name).join(", ")}{c.failing.length > 2 ? ` +${c.failing.length - 2} more` : ""} failing</Reason>
          )}
          {c.failure === 0 && c.total > 0 && (
            <Reason tint="var(--success)" glyph="✓">{c.total} checks passed{d.mergeable === "MERGEABLE" ? `, no conflicts with ${d.baseRefName}` : ""}</Reason>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap px-3 py-2.5"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
          <Btn onClick={onMerge} disabled={busy || !canMerge} primary title={canMerge ? "Squash, merge and delete the branch" : MERGE_WHY[d.mergeState]}>Squash &amp; merge</Btn>
          <Btn onClick={onAutoMerge} disabled={busy} title="Merge automatically once everything passes">Merge when green</Btn>
          <Btn onClick={onUpdateBranch} disabled={busy} warn title="Merge the base branch into this one — this updates the branch on GitHub">↻ Update branch</Btn>
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy}>Re-run failed</Btn>}
          <span className="ml-auto flex gap-1.5">
            <Btn onClick={onDraft} disabled={busy} small>{d.isDraft ? "Mark ready" : "To draft"}</Btn>
            <Btn onClick={onClose} disabled={busy} danger small>Close</Btn>
          </span>
        </div>
      </section>

      <Description d={d} busy={busy} onSave={onEditBody} />

      <div className="flex gap-1.5 flex-wrap items-center">
        <Btn onClick={onLocalReview} disabled={busy} primary title="Check the PR out into a throwaway worktree and review it with the whole repo in context">Review locally with Claude</Btn>
        <a href={externalUrl(d.url)} target="_blank" rel="noreferrer noopener" className="text-[10.5px] px-2.5 py-1 rounded"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>Open on GitHub ↗</a>
      </div>

      {/* Where to go next. Overview answers "can this land"; the conversation is
          usually the reason it cannot, and it should not need finding. */}
      <button onClick={onGoThreads}
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left agx-btn"
        style={{ border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)", background: "color-mix(in srgb, var(--primary) 7%, transparent)" }}>
        <span className="min-w-0">
          <span className="block text-[9px] uppercase tracking-[.13em]" style={{ color: "var(--text3)" }}>Next</span>
          <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>Conversation</span>
        </span>
        <span className="ml-auto text-[10.5px] shrink-0" style={{ color: "var(--primary)" }}>
          {conversationCount === 0 ? "Nothing said yet" : `${conversationCount} comment${conversationCount === 1 ? "" : "s"} and thread${conversationCount === 1 ? "" : "s"}`} →
        </span>
      </button>
    </div>
  );
}

/**
 * The description, and a way to fix it without leaving.
 *
 * Write/Preview rather than a bare textarea: a description is markdown, and
 * finding out how it renders by saving it and looking is not a review flow.
 */
function Description({ d, busy, onSave }: { d: PrDetail; busy: boolean; onSave: (body: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.body);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  // A new pull request means a new body; without this the editor keeps the
  // previous one and offers to save it over the one you are looking at.
  useEffect(() => { setEditing(false); setPreview(false); setText(d.body); }, [d.number, d.body]);

  const done = d.checklist.filter((i) => i.checked).length;

  const save = async () => {
    if (text === d.body) { setEditing(false); return; }
    setSaving(true);
    const ok = await onSave(text);
    setSaving(false);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 38%, transparent)" }}>
        <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
          <Btn onClick={() => setPreview(false)} small primary={!preview}>Write</Btn>
          <Btn onClick={() => setPreview(true)} small primary={preview}>Preview</Btn>
        </div>
        {preview ? (
          <div className="p-3 min-h-[160px]">{text.trim() ? <Md body={text} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}</div>
        ) : (
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") { setText(d.body); setEditing(false); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            }}
            className="w-full p-3 text-[12px] outline-none resize-y agx-scroll"
            style={{ ...CODE_FONT_STYLE, minHeight: 160, background: "transparent", color: "var(--text2)", lineHeight: 1.6 }}
          />
        )}
        <div className="flex items-center gap-1.5 px-2.5 py-2"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
          <span className="text-[10px]" style={{ color: "var(--text3)" }}>Markdown · ⌘↵ save · Esc cancel</span>
          <span className="ml-auto flex gap-1.5">
            <Btn onClick={() => { setText(d.body); setEditing(false); }} disabled={saving} small>Cancel</Btn>
            <Btn onClick={save} disabled={saving || busy} primary small>{saving ? "Saving…" : "Save"}</Btn>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 38%, transparent)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>description</span>
        <span className="ml-auto"><Btn onClick={() => setEditing(true)} disabled={busy} small>✎ Edit</Btn></span>
      </div>
      <div className="p-3">
        {d.checklist.length > 0 && (
          <div className="flex items-center gap-2 mb-3 text-[10.5px]" style={{ color: done === d.checklist.length ? "var(--success)" : "var(--text3)" }}>
            <span className="tabular-nums shrink-0">{done} of {d.checklist.length} done</span>
            <span className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
              <span className="block h-full rounded-full" style={{ width: `${(done / d.checklist.length) * 100}%`, background: done === d.checklist.length ? "var(--success)" : "var(--primary)" }} />
            </span>
          </div>
        )}
        {d.body.trim() ? <Md body={d.body} /> : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No description.</div>}
      </div>
    </section>
  );
}

/**
 * A dropdown that closes on an outside click, on Escape, and on choosing
 * something. All three, because a menu that only closes one of those ways is
 * the kind of thing you only notice when it is stuck open over the diff.
 */
function Menu({ label, title, children, align = "right" }: {
  label: string; title?: string; children: (close: () => void) => React.ReactNode; align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="relative shrink-0" ref={box}>
      <Btn onClick={() => setOpen((v) => !v)} title={title} small>{label}</Btn>
      {open && (
        <div className="absolute z-50 mt-1.5 rounded-lg overflow-hidden agx-menu" style={{ [align]: 0, minWidth: 216 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger, kbd }: {
  children: React.ReactNode; onClick: () => void; danger?: boolean; kbd?: string;
}) {
  return (
    <button onClick={onClick} className="agx-mi w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px]"
      style={{ color: danger ? "var(--error)" : "var(--text2)" }}>
      <span className="min-w-0 truncate">{children}</span>
      {kbd && <span className="ml-auto text-[9.5px] shrink-0" style={{ color: "var(--text3)" }}>{kbd}</span>}
    </button>
  );
}

const MenuSep = () => <div style={{ height: 1, background: "color-mix(in srgb, var(--border) 26%, transparent)", margin: "3px 0" }} />;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0" style={{ maxWidth: 260 }}>
      <div className="text-[9px] uppercase tracking-[.12em] mb-1" style={{ color: "var(--text3)" }}>{label}</div>
      <div className="text-[11px] flex items-center gap-1.5 flex-wrap" style={{ color: "var(--text2)" }}>{children}</div>
    </div>
  );
}

/**
 * The identity of the pull request, above the tabs so it survives every tab.
 *
 * Everything here used to live at the top of Overview, which meant that the
 * moment you opened Files you no longer knew whose pull request you were
 * reading or what branch it targeted.
 */
function Masthead({ d, busy, onEditTitle, onDraft, onClose, onLocalReview, onLabels, onReviewers, onCopyLink }: {
  d: PrDetail; busy: boolean;
  onEditTitle: () => void; onDraft: () => void; onClose: () => void; onLocalReview: () => void;
  onLabels: () => void; onReviewers: () => void; onCopyLink: () => void;
}) {
  const tint = stateTint(d);
  const state = d.state === "MERGED" ? "Merged" : d.state === "CLOSED" ? "Closed" : d.isDraft ? "Draft" : "Open";
  return (
    <div className="px-3 pt-2.5 pb-2 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-[9.5px] px-1.5 py-0.5 rounded-full align-middle"
            style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>
            ● {state}
          </span>
          <span className="text-[14px] leading-snug ml-2" style={{ color: "var(--text)" }}>
            <span className="tabular-nums mr-1.5" style={{ color: "var(--text3)" }}>#{d.number}</span>{d.title}
          </span>
        </div>
        <Menu label="⋯" title="More actions">
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); onEditTitle(); }}>✎ Edit title</MenuItem>
              <MenuItem onClick={() => { close(); onReviewers(); }}>◍ Request a review</MenuItem>
              <MenuItem onClick={() => { close(); onLabels(); }}>⌗ Edit labels</MenuItem>
              <MenuItem onClick={() => { close(); onDraft(); }}>◌ {d.isDraft ? "Mark ready for review" : "Convert to draft"}</MenuItem>
              <MenuSep />
              <MenuItem onClick={() => { close(); onCopyLink(); }}>🔗 Copy link</MenuItem>
              <MenuItem onClick={() => { close(); openExternal(d.url); }}>↗ Open on GitHub</MenuItem>
              <MenuItem onClick={() => { close(); onLocalReview(); }}>✦ Review locally with Claude</MenuItem>
              <MenuSep />
              <MenuItem onClick={() => { close(); onClose(); }} danger>✕ {d.state === "CLOSED" ? "Reopen" : "Close"} pull request</MenuItem>
            </>
          )}
        </Menu>
      </div>

      {/* Packed left and wrapping, not stretched to fill: six fields spread
          across a wide pane put Milestone a screen away from Author, and the
          eye has to travel the whole width to read one header. */}
      <div className="flex flex-wrap gap-x-7 gap-y-2 mt-2.5">
        <Field label="Author"><Avatar login={d.author} size={15} />{d.author}</Field>
        <Field label="Branch">
          <code className="px-1 py-0.5 rounded text-[10.5px] truncate" style={{ ...CODE_FONT_STYLE, color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>{d.headRefName}</code>
          <span style={{ color: "var(--text3)" }}>→ {d.baseRefName}</span>
        </Field>
        <Field label="Changes">
          <span className="tabular-nums" style={{ color: "var(--success)" }}>+{d.additions}</span>
          <span className="tabular-nums" style={{ color: "var(--error)" }}>−{d.deletions}</span>
          <span style={{ color: "var(--text3)" }}>· {d.changedFiles} file{d.changedFiles === 1 ? "" : "s"}</span>
        </Field>
        <Field label="Reviewers">
          {d.reviewers.length === 0
            ? <span style={{ color: "var(--text3)" }}>nobody yet</span>
            : d.reviewers.map((r) => <span key={r} className="flex items-center gap-1"><Avatar login={r} size={14} />{r}</span>)}
          <button onClick={onReviewers} disabled={busy} title="Request a review" className="agx-inline-add">＋</button>
        </Field>
        <Field label="Assignee">
          {d.assignees.length === 0
            ? <span style={{ color: "var(--text3)" }}>unassigned</span>
            : d.assignees.map((a) => <span key={a} className="flex items-center gap-1"><Avatar login={a} size={14} />{a}</span>)}
        </Field>
        <Field label="Milestone">
          {d.milestone ? <span className="truncate">{d.milestone}</span> : <span style={{ color: "var(--text3)" }}>none</span>}
        </Field>
      </div>

      <div className="flex gap-1 flex-wrap mt-2.5 items-center">
        {d.labels.map((l) => <Chip key={l.name} text={l.name} tint={l.color ? `#${l.color}` : "var(--primary)"} />)}
        <button onClick={onLabels} disabled={busy} className="agx-inline-add" style={{ borderStyle: "dashed" }}>＋ Label</button>
      </div>
    </div>
  );
}

function Reason({ tint, glyph, children, action }: { tint: string; glyph: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
      style={{ color: "var(--text2)", borderBottom: "1px solid color-mix(in srgb, var(--border) 18%, transparent)" }}>
      <span className="shrink-0 w-3.5 text-center" style={{ color: tint }}>{glyph}</span>
      <span className="min-w-0">{children}</span>
      {action && <span className="ml-auto shrink-0 text-[10px]">{action}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// files & commits
// ---------------------------------------------------------------------------

function DiffToolbar({ path, add, del, split, wrap, onSplit, onWrap, right }: {
  path?: string; add?: number; del?: number; split: boolean; wrap: boolean;
  onSplit: (v: boolean) => void; onWrap: (v: boolean) => void; right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px] shrink-0"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", background: "color-mix(in srgb, var(--border) 10%, transparent)" }}>
      {path && <span className="truncate" style={{ color: "var(--text)" }}>{path}</span>}
      {add != null && <span className="tabular-nums shrink-0" style={{ color: "var(--success)" }}>+{add}</span>}
      {del != null && <span className="tabular-nums shrink-0" style={{ color: "var(--error)" }}>−{del}</span>}
      <span className="ml-auto flex items-center gap-1 shrink-0">
        {right}
        <Toggle on={split} onClick={() => onSplit(!split)} title="Split / unified">{split ? "Split" : "Unified"}</Toggle>
        <Toggle on={wrap} onClick={() => onWrap(!wrap)} title="Toggle line wrap">Wrap</Toggle>
      </span>
    </div>
  );
}

/** Several files, each with its own header — how a commit reads. */
function FileStack({ files, split, wrap, onSplit, onWrap }: {
  files: FileChange[]; split: boolean; wrap: boolean; onSplit: (v: boolean) => void; onWrap: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {files.map((f, i) => (
        <div key={f.file_path} className="rounded overflow-hidden flex flex-col"
          style={{ border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", maxHeight: 520 }}>
          <DiffToolbar path={f.file_path} add={f.additions} del={f.deletions}
            split={split} wrap={wrap} onSplit={i === 0 ? onSplit : onSplit} onWrap={onWrap} />
          <div className="flex-1 min-h-0 flex">
            <DiffPane file={f} split={split} wrap={wrap} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders its children only once they have come near the viewport.
 *
 * Every file on this tab is open by default, which is the right default for
 * reading a change — but mounting sixty syntax-highlighted diffs at once is not
 * a tab you can scroll. This keeps the default and pays for each diff at the
 * moment it is about to be looked at; `once` means scrolling back up does not
 * unmount what you already read.
 */
function LazyMount({ minHeight, children }: { minHeight: number; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) return;
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") { setShown(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); } }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  return <div ref={box} style={shown ? undefined : { minHeight }}>{shown ? children : null}</div>;
}

/** Above this many changed lines a file starts folded. A 4,000-line lockfile is
 *  not something anybody reads, and it should not be what the tab opens on. */
const BIG_FILE_LINES = 600;

function FilesTab({ d, byPath, loaded, seenFiles, onSeen, sel, onSel, split, wrap, onSplit, onWrap, drafts, onAddDraft }: {
  d: PrDetail; byPath: Map<string, FileChange>; loaded: boolean;
  seenFiles: string[]; onSeen: (p: string) => void;
  sel: string | null; onSel: (p: string | null) => void;
  split: boolean; wrap: boolean; onSplit: (v: boolean) => void; onWrap: (v: boolean) => void;
  drafts: DraftComment[]; onAddDraft: (path: string, line: number) => void;
}) {
  const draftsFor = (p: string) => drafts.filter((x) => x.path === p).length;
  const frameRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  // Folded, not opened: every file is open by default and this records the ones
  // you have put away. Seeded with the files too big to be a sensible default.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setQ("");
    setFolded(new Set(d.files.filter((f) => f.additions + f.deletions > BIG_FILE_LINES).map((f) => f.path)));
  }, [d.number, d.files]);

  const shownFiles = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? d.files.filter((f) => f.path.toLowerCase().includes(needle)) : d.files;
  }, [d.files, q]);

  const toggleFold = (p: string) => setFolded((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  const allFolded = shownFiles.length > 0 && shownFiles.every((f) => folded.has(f.path));

  // The same keyboard model as the changes modal, so the two review surfaces
  // don't diverge: j/k walk the file list, n/p walk the hunks of the open diff,
  // x toggles reviewed. The diff itself is ChangesModal's UnifiedDiff/SplitDiff,
  // so its [data-hunk] markers and [data-vscroll] container are reused verbatim.
  const stepFile = (dir: 1 | -1) => {
    const files = shownFiles;
    if (!files.length) return;
    const i = stepFileIndex(files.length, files.findIndex((f) => f.path === sel), dir);
    onSel(files[i].path);
    requestAnimationFrame(() => frameRef.current?.querySelector('[data-file="active"]')?.scrollIntoView({ block: "nearest" }));
  };
  const jumpHunk = (dir: 1 | -1) => {
    const frame = frameRef.current;
    if (!frame) return;
    const sc = (frame.querySelector("[data-vscroll]") as HTMLElement | null) ?? frame;
    const heads = Array.from(sc.querySelectorAll<HTMLElement>("[data-hunk]"));
    if (!heads.length) return;
    const scTop = sc.getBoundingClientRect().top;
    const cur = sc.scrollTop;
    const tops = heads.map((h) => h.getBoundingClientRect().top - scTop + cur);
    const target = dir === 1 ? tops.find((t) => t > cur + 4) : [...tops].reverse().find((t) => t < cur - 4);
    sc.scrollTo({ top: (target ?? (dir === 1 ? tops[tops.length - 1] : tops[0])) - 2, behavior: "smooth" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    // Never while a field owns the keys — the PR search box, a comment textarea,
    // or a row's reviewed checkbox. Same guard App.tsx and ChangesModal use.
    const inInput = /input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "");
    if (inInput) return;
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); stepFile(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); stepFile(-1); }
    else if (k === "n") { e.preventDefault(); e.stopPropagation(); jumpHunk(1); }
    else if (k === "p") { e.preventDefault(); e.stopPropagation(); jumpHunk(-1); }
    else if (k === "x") { e.preventDefault(); e.stopPropagation(); if (sel) onSeen(sel); }
    else if (k === "enter" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (sel) toggleFold(sel); }
  };
  // Focus the frame when the files tab mounts, so the keys work without a click
  // first — the same first-frame focus the changes modal does.
  useEffect(() => { requestAnimationFrame(() => frameRef.current?.focus()); }, []);

  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey} className="text-[11px] flex flex-col gap-2 outline-none">
      {/* One bar, and it stays put: filter, view mode, progress. Everything that
          used to be repeated on each file's own toolbar lives here once. */}
      <div className="flex items-center gap-2 flex-wrap sticky top-0 z-20 py-1.5 px-1 -mx-1 rounded"
        style={{ background: "var(--bg)", borderBottom: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
        <span className="flex items-center gap-1.5 px-2 py-1 rounded shrink-0"
          style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          <span style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…"
            className="bg-transparent outline-none text-[10.5px] w-28" style={{ color: "var(--text2)" }} />
          {q && <button onClick={() => setQ("")} title="Clear" style={{ color: "var(--text3)" }}>×</button>}
        </span>
        <Btn onClick={() => onSplit(false)} small primary={!split} title="One column, with a “+ Comment” target on every line">Unified</Btn>
        <Btn onClick={() => onSplit(true)} small primary={split} title="Before and after, side by side">Split</Btn>
        <Btn onClick={() => onWrap(!wrap)} small primary={wrap} title="Wrap long lines rather than scrolling them">Wrap</Btn>
        <Btn onClick={() => setFolded(allFolded ? new Set() : new Set(shownFiles.map((f) => f.path)))} small>
          {allFolded ? "Expand all" : "Collapse all"}
        </Btn>
        <span className="ml-auto flex items-center gap-2 min-w-[150px]">
          <span className="tabular-nums shrink-0 text-[10px]" style={{ color: seenFiles.length === d.files.length ? "var(--success)" : "var(--text3)" }}>
            {seenFiles.length} of {d.files.length} viewed
          </span>
          <Bar parts={[{ pct: d.files.length ? (seenFiles.length / d.files.length) * 100 : 0, tint: seenFiles.length === d.files.length ? "var(--success)" : "var(--primary)" }]} />
        </span>
      </div>

      <div className="text-[10px] px-1" style={{ color: "var(--text3)" }}>
        <b>j/k</b> file · <b>n/p</b> hunk · <b>x</b> viewed · <b>↵</b> fold
        {q && <span> · showing {shownFiles.length} of {d.files.length}</span>}
      </div>

      {shownFiles.length === 0 && (
        <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>No file matches “{q}”.</div>
      )}

      {shownFiles.map((f) => {
        const done = seenFiles.includes(f.path);
        const open = !folded.has(f.path);
        const focused = sel === f.path;
        const nd = draftsFor(f.path);
        const change = byPath.get(f.path);
        return (
          <div key={f.path} data-file={focused ? "active" : undefined} className="rounded overflow-hidden"
            style={{
              border: `1px solid color-mix(in srgb, ${focused ? "var(--primary) 45%" : "var(--border) 30%"}, transparent)`,
              opacity: done && !open ? 0.72 : 1,
            }}>
            <div className="flex items-center gap-2 px-2.5 py-1.5"
              style={{ background: "color-mix(in srgb, var(--border) 12%, transparent)", borderBottom: open ? "1px solid color-mix(in srgb, var(--border) 25%, transparent)" : undefined }}>
              <button onClick={() => { onSel(f.path); toggleFold(f.path); }} className="flex-1 min-w-0 text-left flex items-center gap-2">
                <span className="shrink-0" style={{ color: "var(--text3)" }}>{open ? "▾" : "▸"}</span>
                <span className="truncate" style={{ ...CODE_FONT_STYLE, color: done ? "var(--text3)" : "var(--text)" }}>{f.path}</span>
                {f.status && f.status !== "modified" && <Chip text={f.status} tint="var(--text3)" />}
                {f.comments > 0 && <Chip text={`${f.comments} open`} tint="var(--warning)" />}
                {nd > 0 && <Chip text={`${nd} pending`} tint="var(--primary)" title="Queued in your review" />}
                <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--success)" }}>+{f.additions}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--error)" }}>−{f.deletions}</span>
              </button>
              {/* "Viewed" is state you keep for the length of a review, not a
                  one-off tick — a switch says that and a checkbox does not. */}
              <button onClick={() => onSeen(f.path)} title={done ? "Mark not viewed" : "Mark viewed"}
                aria-pressed={done}
                className="agx-btn shrink-0 flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: done ? "var(--success)" : "var(--text3)", border: `1px solid color-mix(in srgb, ${done ? "var(--success) 50%" : "var(--border) 45%"}, transparent)` }}>
                <span className="agx-sw" data-on={done ? "1" : "0"} />Viewed
              </button>
            </div>
            {open && (
              <LazyMount minHeight={Math.min(320, 40 + (f.additions + f.deletions) * 18)}>
                <div className="flex" style={{ maxHeight: 560, overflow: "auto" }}>
                  {!loaded ? <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>Loading the diff…</div>
                    : change ? <DiffPane file={change} split={split} wrap={wrap} onComment={(line) => onAddDraft(f.path, line)} />
                    : <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>No textual diff — binary, renamed, or too large to show</div>}
                </div>
              </LazyMount>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

/** Out to GitHub, for the one thing the panel does not show — the full history
 *  of an edit, a reaction, the blame behind a line. */
function GhLink({ href, title }: { href: string; title: string }) {
  // Nothing rather than a link we cannot vouch for: every one of these comes
  // out of an API response, and a link that does not navigate somewhere plain
  // is not one we should be offering.
  const safe = externalUrl(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" title={title}
      className="shrink-0 text-[10px] px-1 rounded"
      style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>↗</a>
  );
}

function Lane({ label, extra }: { label: string; extra?: string }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-2 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>
      <span>{label}</span>{extra && <span>{extra}</span>}
      <span className="flex-1 h-px" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }} />
    </div>
  );
}

function Card({ who, chip, when, tone, url, children }: {
  who: string; chip?: React.ReactNode; when?: string; tone?: "chg" | "appr" | "bot"; url?: string; children: React.ReactNode;
}) {
  const edge = tone === "chg" ? "var(--error)" : tone === "appr" ? "var(--success)" : tone === "bot" ? "var(--info)" : "var(--border)";
  return (
    <div className="rounded-md overflow-hidden mb-2"
      style={{ border: `1px solid color-mix(in srgb, ${edge} ${tone ? 40 : 28}%, transparent)` }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
        style={{ background: `color-mix(in srgb, ${edge} ${tone ? 10 : 14}%, transparent)`, borderBottom: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
        <Avatar login={who} size={17} />
        <b style={{ color: "var(--text)", fontWeight: 500 }}>{who}</b>
        {chip}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {when && <span className="text-[10px]" style={{ color: "var(--text3)" }}>{when}</span>}
          {url && <GhLink href={url} title="Open on GitHub" />}
        </span>
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  );
}

/**
 * The code a thread is about.
 *
 * Straight from the hunk GitHub stored with the comment. Reconstructing it from
 * the pull request's diff meant the snippet only appeared on tabs that had
 * already fetched that diff — so in the conversation, where the thread actually
 * reads, there was never any code at all. It also survives an outdated thread,
 * whose lines no longer exist in the current diff.
 *
 * Trimmed to the last few lines: a stored hunk runs thirty-odd lines and the
 * comment is about the end of it.
 */
function ThreadSnippet({ hunk, line }: { hunk?: string; line?: number | null }) {
  const rows = useMemo(() => {
    const all = (hunk || "").split(/\r?\n/).filter((l, i) => i > 0 || !l.startsWith("@@"));
    const tail = all.slice(-5);
    // Number the tail against the line the comment landed on, counting back
    // over everything that occupies a line on the new side.
    let n = typeof line === "number" ? line : NaN;
    const nums: (number | null)[] = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i]!.startsWith("-")) { nums[i] = null; continue; }
      nums[i] = Number.isNaN(n) ? null : n--;
    }
    return tail.map((text, i) => ({ text, no: nums[i] ?? null }));
  }, [hunk, line]);

  if (!hunk?.trim()) return null;
  return (
    <div className="text-[10.5px]" style={{ ...CODE_FONT_STYLE, borderBottom: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
      {rows.map((r, i) => (
        <div key={i} className="flex" style={{
          background: r.text.startsWith("+") ? "color-mix(in srgb, var(--success) 10%, transparent)"
            : r.text.startsWith("-") ? "color-mix(in srgb, var(--error) 10%, transparent)" : undefined,
        }}>
          <span className="shrink-0 text-right select-none tabular-nums px-2"
            style={{ width: 46, color: "var(--text3)", opacity: .7 }}>{r.no ?? ""}</span>
          <span className="min-w-0 flex-1 whitespace-pre overflow-x-auto pr-2 agx-scroll" style={{
            color: r.text.startsWith("+") ? "var(--success)" : r.text.startsWith("-") ? "var(--error)" : "var(--text2)",
          }}>{r.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function Thread({ t, onResolve, onReply, busy }: {
  t: PrThread; onResolve: (t: PrThread) => void; onReply: (t: PrThread) => void; busy: boolean;
}) {
  // The REST reply endpoint takes the numeric comment id. `id` is a GraphQL
  // node id (`PRRC_kwDO…`) and `Number()` of that is NaN — which is why reply
  // could never have worked before `databaseId` was asked for.
  const canReply = typeof t.comments[0]?.databaseId === "number";
  return (
    <div className="rounded-md overflow-hidden mb-2" style={{ border: "1px solid color-mix(in srgb, var(--border) 28%, transparent)" }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
        style={{ background: "color-mix(in srgb, var(--border) 14%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
        <span className="truncate" style={{ color: "var(--primary)" }}>{t.path}{t.line ? `:${t.line}` : ""}</span>
        {t.isOutdated && <Chip text="outdated" tint="var(--text3)" title="The code under this comment has changed since" />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {t.isResolved ? <Chip text="resolved" tint="var(--success)" /> : <Chip text="open" tint="var(--warning)" />}
          {t.url && <GhLink href={t.url} title="Open this thread on GitHub" />}
        </span>
      </div>
      <ThreadSnippet hunk={t.diffHunk} line={t.originalLine ?? t.line} />
      {t.comments.map((c, i) => (
        <div key={c.id} className="px-3 py-2"
          style={{ paddingLeft: i ? 26 : 12, background: i ? "color-mix(in srgb, var(--border) 9%, transparent)" : undefined }}>
          <div className="flex items-center gap-1.5 mb-1 text-[10px]">
            <Avatar login={c.author} size={15} />
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{c.author}</b>
            {c.isBot && <Chip text="automation" tint="var(--info)" />}
            <span className="ml-auto flex items-center gap-1.5" style={{ color: "var(--text3)" }}>
              {ago(c.createdAt)}
              {c.url && <GhLink href={c.url} title="Open this comment on GitHub" />}
            </span>
          </div>
          <Md body={c.body} />
        </div>
      ))}
      <div className="flex gap-1.5 px-3 py-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 20%, transparent)" }}>
        <Btn onClick={() => onReply(t)} disabled={busy || !canReply} small
          title={canReply ? undefined : "This thread has no comment to reply to"}>Reply</Btn>
        <Btn onClick={() => onResolve(t)} disabled={busy} ok={!t.isResolved} small>{t.isResolved ? "Unresolve" : "Resolve conversation"}</Btn>
      </div>
    </div>
  );
}

/**
 * The conversation, as one timeline.
 *
 * It used to be four lanes — humans, line threads, automation, raw — each a
 * separate pile under its own rule. That splits a verdict from its reasons and
 * makes "what happened here, in what order" unanswerable: you read a pile of
 * replies, then scrolled back up to find what they were replying to.
 *
 * Now everything that happened is one list in the order it happened, on a rail,
 * with a node per entry saying what kind of thing it was. A review still owns
 * the threads submitted with it, because that grouping IS the meaning: a
 * "requested changes" is a verdict and the threads under it are the reasons.
 */
function Conversation({ d, lanes, raw, onRaw, onResolve, onReply, onComment, busy }: {
  d: PrDetail;
  lanes: { humans: PrReview[]; botReviews: PrReview[]; humanComments: PrComment[]; bots: PrComment[] };
  raw: boolean; onRaw: (v: boolean) => void;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread) => void;
  onComment: (body: string) => Promise<boolean>; busy: boolean;
}) {
  const [newest, setNewest] = useState(false);
  const kb = Math.round(lanes.bots.reduce((n, c) => n + c.body.length, 0) / 1024);
  const reviewAuthors = new Set(lanes.humans.map((r) => r.author));
  const orphanThreads = d.threads.filter((t) => !reviewAuthors.has(t.comments[0]?.author ?? ""));

  type Entry = { at: string; key: string; node: React.ReactNode; body: React.ReactNode };
  const entries: Entry[] = [];

  for (const [i, r] of lanes.humans.entries()) {
    const mine = d.threads.filter((t) => t.comments[0]?.author === r.author);
    const tone = r.state === "CHANGES_REQUESTED" ? "chg" : r.state === "APPROVED" ? "appr" : undefined;
    entries.push({
      at: r.submittedAt, key: `r${i}`,
      node: <span style={{ color: tone === "chg" ? "var(--error)" : tone === "appr" ? "var(--success)" : "var(--text3)" }}>
        {r.state === "CHANGES_REQUESTED" ? "✕" : r.state === "APPROVED" ? "✓" : "💬"}</span>,
      body: (
        <>
          <Card who={r.author} when={ago(r.submittedAt)} url={r.url} tone={tone}
            chip={r.state === "CHANGES_REQUESTED" ? <Chip text="requested changes" tint="var(--error)" />
              : r.state === "APPROVED" ? <Chip text="approved" tint="var(--success)" /> : undefined}>
            {r.body ? <Md body={r.body} />
              : <span style={{ color: "var(--text3)" }}>({r.state.toLowerCase().replace("_", " ")}, no note)</span>}
          </Card>
          {mine.length > 0 && (
            <div className="pl-3 ml-2" style={{ borderLeft: "2px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
              {mine.map((t) => <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} busy={busy} />)}
            </div>
          )}
        </>
      ),
    });
  }
  for (const c of lanes.humanComments) {
    entries.push({
      at: c.createdAt, key: `c${c.id}`, node: <span style={{ color: "var(--text3)" }}>💬</span>,
      body: <Card who={c.author} when={ago(c.createdAt)} url={c.url}><Md body={c.body} /></Card>,
    });
  }
  for (const t of orphanThreads) {
    entries.push({
      at: t.comments[0]?.createdAt ?? "", key: `t${t.id}`,
      node: <span style={{ color: t.isResolved ? "var(--success)" : "var(--warning)" }}>{t.isResolved ? "✓" : "○"}</span>,
      body: <Thread t={t} onResolve={onResolve} onReply={onReply} busy={busy} />,
    });
  }
  for (const [i, r] of lanes.botReviews.entries()) {
    entries.push({
      at: r.submittedAt, key: `br${i}`, node: <span style={{ color: "var(--info)" }}>⌬</span>,
      body: <Card who={r.author} when={ago(r.submittedAt)} url={r.url} tone="bot"
        chip={<Chip text="automation" tint="var(--info)" />}><Md body={r.body} /></Card>,
    });
  }
  for (const c of lanes.bots) {
    entries.push({
      at: c.createdAt, key: `b${c.id}`, node: <span style={{ color: "var(--info)" }}>⌬</span>,
      body: (
        <Card who={c.author} when={ago(c.createdAt)} url={c.url} tone="bot" chip={<Chip text="automation" tint="var(--info)" />}>
          {raw
            ? <pre className="overflow-x-auto text-[10px] max-h-72 agx-scroll" style={{ ...CODE_FONT_STYLE, color: "var(--text3)" }}>{c.body}</pre>
            : <span style={{ color: "var(--text2)" }}>{c.digest || "(Nothing worth pulling out)"}</span>}
        </Card>
      ),
    });
  }

  entries.sort((a, b) => (newest ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)));

  /* The events between the comments. GitHub has no timestamp on either of these
     — "opened" is not on the detail payload and a force-push is a boolean —
     so they are anchored to the ends of the timeline rather than given a time
     they would be making up. */
  const opened = (
    <div key="opened" className="agx-tiny">
      <span className="agx-node">＋</span>
      <span><b>{d.author}</b> opened this pull request from <code style={{ ...CODE_FONT_STYLE, color: "var(--primary)" }}>{d.headRefName}</code> into <code style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>{d.baseRefName}</code></span>
    </div>
  );
  const forced = d.forcePushedSinceReview ? (
    <div key="forced" className="agx-tiny">
      <span className="agx-node" style={{ color: "var(--warning)" }}>↻</span>
      <span><b>{d.author}</b> force-pushed after the last review — <span style={{ color: "var(--warning)" }}>that review was for code that is no longer here</span></span>
    </div>
  ) : null;

  const composer = <Composer onSend={onComment} busy={busy} placeholder="Leave a comment — markdown works here" sendLabel="Comment" />;

  if (entries.length === 0) {
    return (
      <div className="text-[11px]">
        <div className="agx-tl">{opened}</div>
        <div className="text-[11px] mb-3" style={{ color: "var(--text3)" }}>Nobody has said anything yet.</div>
        {composer}
      </div>
    );
  }

  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2 mb-3 text-[10px]" style={{ color: "var(--text3)" }}>
        <span>One timeline — reviews, comments and threads in the order they happened</span>
        <span className="flex-1" />
        {lanes.bots.length > 0 && (
          <Btn small onClick={() => onRaw(!raw)}>
            {raw ? "Digest automation" : `Show automation in full · ${kb} KB`}
          </Btn>
        )}
        <Btn small onClick={() => setNewest(false)} primary={!newest}>Oldest</Btn>
        <Btn small onClick={() => setNewest(true)} primary={newest}>Newest</Btn>
      </div>
      <div className="agx-tl">
        {!newest && opened}
        {newest && forced}
        {entries.map((e) => (
          <div key={e.key} className="agx-ev">
            <span className="agx-node">{e.node}</span>
            {e.body}
          </div>
        ))}
        {!newest && forced}
        {newest && opened}
      </div>
      <div className="mt-3">{composer}</div>
    </div>
  );
}

/**
 * Write, preview, send. Shared by the conversation and by anywhere else that
 * takes markdown, so the two never drift into behaving differently.
 */
function Composer({ onSend, busy, placeholder, sendLabel }: {
  onSend: (body: string) => Promise<boolean>; busy: boolean; placeholder: string; sendLabel: string;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (ok) { setText(""); setPreview(false); }
  };

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 38%, transparent)" }}>
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
        <Btn onClick={() => setPreview(false)} small primary={!preview}>Write</Btn>
        <Btn onClick={() => setPreview(true)} small primary={preview}>Preview</Btn>
      </div>
      {preview ? (
        <div className="p-3 min-h-[80px]">{text.trim() ? <Md body={text} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}</div>
      ) : (
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          className="w-full p-3 text-[11.5px] outline-none resize-y bg-transparent agx-scroll"
          style={{ color: "var(--text)", lineHeight: 1.6 }}
        />
      )}
      <div className="flex items-center gap-2 px-2.5 py-2"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>Markdown · ⌘↵ to send</span>
        <span className="ml-auto">
          <Btn onClick={send} disabled={sending || busy || !text.trim()} primary small
            title={!text.trim() ? "Write something first" : undefined}>
            {sending ? "Sending…" : sendLabel}
          </Btn>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const CHECK_TINT: Record<PrCheck["state"], string> = {
  success: "var(--success)", failure: "var(--error)", pending: "var(--warning)",
  skipped: "var(--text3)", neutral: "var(--text3)",
};
const CHECK_GLYPH: Record<PrCheck["state"], string> = {
  success: "✓", failure: "✕", pending: "•", skipped: "⊘", neutral: "⊘",
};

/** "CI / Tests / django-tests" — the workflow is the prefix, and grouping by
 *  it turns fifty-nine rows into six things you can actually scan. */
function groupOf(k: PrCheck): string {
  if (k.workflow) return k.workflow;
  const parts = k.name.split(" / ");
  return parts.length > 1 ? parts.slice(0, -1).join(" / ") : "Checks";
}

function Checks({ d, onRerun, onAsk, busy }: { d: PrDetail; onRerun: () => void; onAsk?: (check: PrCheck) => void; busy: boolean }) {
  const c = d.checks;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [showSkipped, setShowSkipped] = useState(false);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, PrCheck[]>();
    for (const k of d.checksAll) {
      if (!showSkipped && (k.state === "skipped" || k.state === "neutral")) continue;
      const g = groupOf(k);
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(k);
    }
    const rank = (list: PrCheck[]) => (list.some((k) => k.state === "failure") ? 0 : list.some((k) => k.state === "pending") ? 1 : 2);
    return [...m.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  }, [d.checksAll, showSkipped]);

  const skippedCount = d.checksAll.filter((k) => k.state === "skipped" || k.state === "neutral").length;
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);

  return (
    <div className="text-[11px] flex flex-col gap-2">
      <div className="flex items-center gap-3 p-3 rounded-lg" style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
        <span className="shrink-0 rounded-full flex items-center justify-center text-[13px]"
          style={{ width: 26, height: 26, background: c.failure > 0 ? "var(--error)" : c.pending > 0 ? "var(--warning)" : "var(--success)", color: "var(--bg)" }}>
          {c.failure > 0 ? "✕" : c.pending > 0 ? "•" : "✓"}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
            {c.failure > 0 ? `${c.failure} check${c.failure === 1 ? "" : "s"} failing` : c.pending > 0 ? `${c.pending} still running` : "All checks have passed"}
          </span>
          <span className="block text-[11px] mt-0.5 tabular-nums" style={{ color: "var(--text3)" }}>
            {c.skipped} skipped · {c.success} successful · {c.failure} failing
          </span>
        </span>
        <span className="ml-auto shrink-0 flex items-center gap-2">
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy} small>Re-run failed</Btn>}
          <span className="text-[10px]" style={{ color: "var(--text3)" }}>{c.allDone ? "Notified once, not " + c.total : "You will be told once, at the end"}</span>
        </span>
      </div>
      <Bar parts={[
        { pct: pct(c.success), tint: "var(--success)" },
        { pct: pct(c.failure), tint: "var(--error)" },
        { pct: pct(c.pending), tint: "var(--warning)" },
        { pct: pct(c.skipped), tint: "color-mix(in srgb, var(--text3) 40%, transparent)" },
      ]} />

      {groups.map(([name, list]) => {
        const isOpen = openGroups[name] ?? list.some((k) => k.state === "failure" || k.state === "pending");
        const bad = list.filter((k) => k.state === "failure").length;
        const good = list.filter((k) => k.state === "success").length;
        return (
          <div key={name} className="rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 28%, transparent)" }}>
            <button onClick={() => setOpenGroups((o) => ({ ...o, [name]: !isOpen }))}
              className="w-full text-left flex items-center gap-2 px-2.5 py-1.5"
              style={{ background: "color-mix(in srgb, var(--border) 14%, transparent)" }}>
              <span style={{ color: "var(--text3)" }}>{isOpen ? "▾" : "▸"}</span>
              <b style={{ color: "var(--text)", fontWeight: 500 }}>{name}</b>
              {bad > 0 && <span style={{ color: "var(--error)" }}>{bad} ✕</span>}
              {good > 0 && <span style={{ color: "var(--success)" }}>{good} ✓</span>}
              <span className="ml-auto tabular-nums" style={{ color: "var(--text3)" }}>{list.length}</span>
            </button>
            {isOpen && list.map((k, i) => {
              const bad = k.state === "failure";
              const id = `${name}::${k.name}::${i}`;
              const expanded = bad && openCheck === id;
              return (
                <div key={id} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 16%, transparent)", background: bad ? "color-mix(in srgb, var(--error) 7%, transparent)" : undefined }}>
                  {/* A failing check is the one row on this tab you came for, so
                      it is the one row that opens into somewhere to go next. */}
                  <button onClick={() => bad && setOpenCheck(expanded ? null : id)} disabled={!bad}
                    className="w-full text-left flex items-center gap-2 px-2.5 py-1" style={{ cursor: bad ? "pointer" : "default" }}>
                    <span className="shrink-0 w-3 text-center" style={{ color: CHECK_TINT[k.state] }}>{CHECK_GLYPH[k.state]}</span>
                    <span className="truncate" style={{ color: k.state === "skipped" || k.state === "neutral" ? "var(--text3)" : "var(--text2)" }}>
                      {k.name.startsWith(name) ? k.name.slice(name.length).replace(/^\s*\/\s*/, "") || k.name : k.name}
                    </span>
                    <span className="ml-auto shrink-0 text-[9.5px] uppercase tracking-wide" style={{ color: CHECK_TINT[k.state] }}>{k.state}</span>
                    {bad && <span className="shrink-0" style={{ color: "var(--text3)" }}>{expanded ? "▾" : "▸"}</span>}
                  </button>
                  {expanded && (
                    <div className="flex items-center gap-1.5 flex-wrap px-2.5 pb-2 pt-0.5">
                      {onAsk && <Btn onClick={() => onAsk(k)} primary small title="Check the pull request out locally and hand the failure to Claude">✦ Ask Claude why</Btn>}
                      {k.url && (
                        <a href={externalUrl(k.url)} target="_blank" rel="noreferrer noopener" className="agx-btn text-[10px] px-2 py-0.5 rounded"
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>Open run ↗</a>
                      )}
                      <Btn onClick={onRerun} disabled={busy} small title="Re-run every failing check on this pull request">↻ Re-run failed</Btn>
                      <span className="text-[10px]" style={{ color: "var(--text3)" }}>The log itself lives on GitHub — this panel does not download run logs.</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {skippedCount > 0 && (
        <button onClick={() => setShowSkipped((v) => !v)} className="text-[10px] px-2.5 py-1.5 rounded self-start"
          style={{ color: "var(--text2)", border: "1px dashed color-mix(in srgb, var(--border) 50%, transparent)" }}>
          {showSkipped ? "Hide" : "Show"} {skippedCount} skipped
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// review submission
// ---------------------------------------------------------------------------

/**
 * Finishing a review: a verdict, a note, and everything queued while reading.
 *
 * A tab rather than a sheet, because reviewing is a place you go, not a dialog
 * you dismiss — and because it only exists on pull requests that are somebody
 * else's. The queued comments are the point: GitHub calls this a pending
 * review, and it exists so a reviewer leaves one notification rather than a
 * dozen. The comments and the verdict travel in a single request.
 */
function ReviewTab({ d, drafts, seen, busy, onDrop, onSubmit, onGoFiles }: {
  d: PrDetail; drafts: DraftComment[]; seen: number; busy: boolean;
  onDrop: (i: number) => void;
  onSubmit: (verb: "approve" | "request_changes" | "comment", body: string) => void;
  onGoFiles: () => void;
}) {
  const [verb, setVerb] = useState<"comment" | "approve" | "request_changes">("comment");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const nothing = !body.trim() && drafts.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {d.viewerRequested && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[11.5px]"
          style={{ border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)", background: "color-mix(in srgb, var(--warning) 9%, transparent)" }}>
          <Avatar login={d.author} size={18} />
          <span style={{ color: "var(--text2)" }}>
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{d.author}</b> requested your review on this pull request
          </span>
        </div>
      )}

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
          style={{ background: "color-mix(in srgb, var(--border) 12%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
          <b style={{ color: "var(--text)", fontWeight: 500 }}>Finish your review</b>
          <span style={{ color: "var(--text3)" }}>#{d.number}</span>
          <button onClick={onGoFiles} className="ml-auto tabular-nums text-[10px]" style={{ color: seen < d.files.length ? "var(--primary)" : "var(--text3)" }}>
            {seen}/{d.files.length} files viewed
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2">
          {drafts.length > 0 ? (
            <div className="rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider"
                style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>
                {drafts.length} pending comment{drafts.length === 1 ? "" : "s"} — sent with this review
              </div>
              {drafts.map((c, i) => (
                <div key={i} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]"
                  style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 18%, transparent)" }}>
                  <span className="shrink-0" style={{ ...CODE_FONT_STYLE, color: "var(--primary)" }}>{c.path.split("/").pop()}:{c.line}</span>
                  <span className="min-w-0 flex-1" style={{ color: "var(--text2)" }}>{c.body}</span>
                  <button onClick={() => onDrop(i)} className="shrink-0 text-[10px]" style={{ color: "var(--error)" }}>Drop</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
              No line comments queued. Open <button onClick={onGoFiles} style={{ color: "var(--primary)" }}>files</button> and
              use “+ Comment” on a hunk to attach one to a line.
            </div>
          )}

          {/* The verdict, chosen before the note is written — it is what the
              note is for, and each option says what submitting it does rather
              than leaving you to infer it from one word. */}
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))" }}>
            {([
              ["approve", "✓ Approve", "Submit and mark the pull request approved.", "var(--success)"],
              ["request_changes", "✕ Request changes", "Submit and block the merge until they land.", "var(--error)"],
              ["comment", "💬 Comment", "Submit without a verdict.", "var(--text)"],
            ] as const).map(([id, label, hint, tint]) => {
              const on = verb === id;
              const off = id !== "comment" && d.viewerDidAuthor;
              return (
                <button key={id} onClick={() => setVerb(id)} disabled={off}
                  aria-pressed={on}
                  title={off ? "GitHub does not let you approve or block your own pull request" : undefined}
                  className="agx-btn text-left rounded-lg px-2.5 py-2"
                  style={{
                    border: `1px solid color-mix(in srgb, ${on ? "var(--primary) 70%" : "var(--border) 42%"}, transparent)`,
                    background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent",
                    opacity: off ? 0.4 : 1, cursor: off ? "not-allowed" : "pointer",
                  }}>
                  <b className="block text-[12px]" style={{ color: tint, fontWeight: 600 }}>{label}</b>
                  <i className="block text-[10px] not-italic mt-0.5 leading-snug" style={{ color: "var(--text3)" }}>
                    {off ? "Not available on your own pull request" : hint}
                  </i>
                </button>
              );
            })}
          </div>

          <div className="flex gap-0 text-[10.5px]" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
            {(["write", "preview"] as const).map((m) => (
              <button key={m} onClick={() => setPreview(m === "preview")} className="px-3 py-1"
                style={{
                  color: (m === "preview") === preview ? "var(--text)" : "var(--text3)",
                  borderBottom: `2px solid ${(m === "preview") === preview ? "var(--primary)" : "transparent"}`,
                }}>{m === "preview" ? "Preview" : "Write"}</button>
            ))}
          </div>

          {preview ? (
            <div className="rounded p-2.5 min-h-[80px]" style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
              {body.trim() ? <Md body={body} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}
            </div>
          ) : (
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5}
              placeholder="Leave a comment — markdown works here."
              className="w-full rounded p-2.5 text-[11.5px] bg-transparent resize-y"
              style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", outline: "none" }} />
          )}

          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px]" style={{ color: "var(--text3)" }}>
              {verb !== "approve" && nothing
                ? "Nothing to submit yet — write a note, or queue a line comment from Files."
                : `Posted publicly to your team${drafts.length ? `, with ${drafts.length} line comment${drafts.length === 1 ? "" : "s"} — one notification, not ${drafts.length + 1}` : ""}.`}
            </span>
            <span className="ml-auto">
              <Btn onClick={() => onSubmit(verb, body)} disabled={busy || (verb !== "approve" && nothing)} primary
                title={verb !== "approve" && nothing ? "Say something, or queue a line comment" : undefined}>Submit review</Btn>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

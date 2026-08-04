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
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Portal } from "./Portal.tsx";
import { subscribePrJump, prJump, clearPrJump } from "../lib/prJump.ts";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import type {
  PrSummary, PrDetail, PrRepoId, PrThread, PrComment, PrReview, PrReviewer, PrCheck, GitRepoRef, FileChange,
  PrReaction, PrAuthorAssociation, PrEvent, PrCommit, PrFile, PrCheckJob,
} from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { depSpec } from "../../../shared/deps.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { SCROLLBAR_CSS, LINEBTN_CSS, CODE_FONT_STYLE, UnifiedDiff, SplitDiff, Toggle, LineMenuCtx, type LinePick, type LineSel } from "./ChangesModal.tsx";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import { Select } from "./Select.tsx";
import { parseBody, parseUnifiedDiff, newLineNumbers, diffKind, parseShieldBadge, type MdBlock, type ParsedFile } from "../lib/prBody.ts";
import { stepFileIndex } from "../lib/prNav.ts";
import { excerpt, findInDiffs, groupByFile, type Match } from "../lib/diffFind.ts";
import { PrFilterBar } from "./PrFilterBar.tsx";
import { Avatar } from "./Avatar.tsx";
import { PeekFile, type Peek } from "./PeekFile.tsx";
import { parseQuery, sortRows, buildFacets, activeCount, type RepoFacets } from "../lib/prFilter.ts";
import { getHighlighter, shikiTheme, ensureLanguage } from "../lib/highlight.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";

type Filter = "mine" | "review" | "all";
type Tab = "overview" | "conversation" | "commits" | "files" | "checks" | "review";
// The open/closed axis, orthogonal to the scope views. "closed" holds merged +
// closed, exactly like GitHub's own Closed tab; "all" is everything.
type StateSel = "open" | "closed" | "all";
const STATES: { id: StateSel; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

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
/** The unsent review itself — the verdict you picked and the note you typed,
 *  which used to live only in the Review tab's own state. Switching to Files to
 *  check one more thing threw both away, and there is no worse moment to lose a
 *  paragraph than after you have decided what it says. GitHub keeps it; so do
 *  we, per pull request, until it is sent. */
const REVIEW_KEY = "agentglass.pr.review";

/** A review written but not yet submitted. */
export interface ReviewDraft {
  verb: "comment" | "approve" | "request_changes";
  body: string;
}

/** Half-written comments, keyed by where they are being written. Neither queued
 *  nor sent — just typed, and until now thrown away by anything that closed the
 *  box: switching to Checks to see why it is red, and coming back to an empty
 *  composer, is the most expensive way this panel could waste a paragraph. */
const COMPOSE_KEY = "agentglass.pr.compose";
const readStash = (k: string): string => { try { return (JSON.parse(localStorage.getItem(COMPOSE_KEY) || "{}") as Record<string, string>)[k] ?? ""; } catch { return ""; } };
const writeStash = (k: string, v: string) => {
  try {
    const all = JSON.parse(localStorage.getItem(COMPOSE_KEY) || "{}") as Record<string, string>;
    // Deleted first either way, so a key that is being typed into moves to the
    // end of the object and the order below stays "least recently touched".
    delete all[k];
    if (v.trim()) all[k] = v;
    // Nothing ever deletes the stash for a pull request that got merged with a
    // half-written note still in it, so bound it: keys keep insertion order, so
    // the ones that fall off are the ones nobody has touched in longest.
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - 80))) delete all[old];
    localStorage.setItem(COMPOSE_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
};

/** A line comment written but not yet sent — GitHub's "pending review". */
export interface DraftComment {
  path: string;
  /** The last line of the comment — GitHub's `line`. */
  line: number;
  /** The first, when the comment covers a range. Absent for a single line. */
  startLine?: number;
  /** Which side of the diff: RIGHT is the new file, LEFT the old. */
  side?: "LEFT" | "RIGHT";
  body: string;
}

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
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 10%, transparent)` }}>{text}</span>
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
      className={`agx-btn rounded whitespace-nowrap disabled:opacity-40 ${small ? "text-[10px] px-2 py-0.5" : "text-[10.5px] px-2.5 py-1"}`}
      style={{
        // A plain button's label was --text2, a tier meant for labels beside
        // things — so "Comment" sat at the contrast of a caption next to the
        // button it competes with. It is a control: it reads at full strength,
        // and the border is what says it is the quieter of the two.
        color: primary ? "var(--bg)" : danger ? "var(--error)" : ok ? "var(--success)" : warn ? "var(--warning)" : "var(--text)",
        background: primary ? "var(--primary)" : warn ? "color-mix(in srgb, var(--warning) 16%, transparent)"
          // A quiet button still needs an edge you can find. Transparent on a
          // panel, with a border mixed at half strength, was a label with a
          // suggestion of a box — on the neutral themes, where --border is
          // close to the surface it sits on, it vanished entirely.
          : "color-mix(in srgb, var(--border) 30%, transparent)",
        border: `1px solid color-mix(in srgb, ${edge} ${primary ? 100 : warn ? 55 : 85}%, transparent)`,
        cursor: disabled ? "not-allowed" : "pointer",
        // The filled one carries the weight. On a neutral theme --primary is a
        // grey, so fill alone does not separate the two — the label has to say
        // which is which as well.
        fontWeight: primary ? 600 : warn ? 500 : 500,
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
/* A body fills the box it was given. There used to be a 78ch measure here,
   borrowed from prose typography, and it was the wrong rule twice over: this
   panel renders in a monospace face, so ch is a fixed pixel wall (measured at
   584px) rather than a measure that breathes, and it left a third of a card
   empty beside text that stopped in mid-air. GitHub caps nothing here either,
   so the same pull request read narrower in the app than on the page it came
   from. Reading comfort on a wide display is what the panel width is for. */
/* One timeline, one rail. The node says what kind of thing happened; the
   rail says they happened in an order. */
.agx-tl{position:relative;padding-left:26px}
.agx-tl::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;border-radius:2px;background:color-mix(in srgb,var(--border) 42%,transparent)}
.agx-ev{position:relative;margin-bottom:10px}
.agx-ev:last-child{margin-bottom:0}
.agx-node{position:absolute;left:-26px;top:6px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:9px;background:var(--bg);border:2px solid color-mix(in srgb,var(--text) 24%,transparent)}
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
.agx-inline-add{font-size:10px;padding:1px 6px;border-radius:5px;color:var(--text3);border:1px solid color-mix(in srgb,var(--text) 24%,transparent);transition:color .13s,border-color .13s,background .13s}
.agx-inline-add:hover:not(:disabled){color:var(--primary);border-color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,transparent)}
.agx-inline-add:disabled{opacity:.4;cursor:not-allowed}
/* the viewed switch on a file header — a checkbox does not read as a state you
   are keeping, and "viewed" is state you keep across a whole review */
.agx-sw{position:relative;width:24px;height:14px;border-radius:8px;flex:none;background:color-mix(in srgb,var(--border) 50%,transparent);transition:background .17s}
.agx-sw::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--text3);transition:transform .17s,background .17s}
.agx-sw[data-on="1"]{background:color-mix(in srgb,var(--success) 55%,transparent)}
.agx-sw[data-on="1"]::after{transform:translateX(10px);background:var(--success)}
.agx-hl pre{margin:0;padding:10px 12px;border-radius:8px;overflow-x:auto;background:color-mix(in srgb,var(--bg2) 55%,var(--bg)) !important;border:1px solid color-mix(in srgb,var(--border2) 60%,transparent)}
.agx-hl code{font-size:11.5px;line-height:1.65}
.agx-md .agx-hl{margin:0 0 .85em}
/* The body reads in the theme's brightest text, not a step below it. A pull
   request description is the longest thing anybody reads in this app, and it
   was set in --text2 — a grey chosen for labels, against a dark panel. The
   dimmer tiers still exist and still recede; they are for eyebrows, timestamps
   and hints, which is what "secondary" was supposed to mean. */
.agx-md{margin:0;line-height:1.7;font-size:12.5px;color:var(--text)}
.agx-md>*:first-child{margin-top:0}
.agx-md>*:last-child{margin-bottom:0}
.agx-md p{margin:0 0 .85em}
.agx-md h1,.agx-md h2,.agx-md h3,.agx-md h4,.agx-md h5,.agx-md h6{color:var(--text);font-weight:600;line-height:1.3;margin:1.5em 0 .5em}
.agx-md h1{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid color-mix(in srgb,var(--text) 16%,transparent)}
.agx-md h2{font-size:1.25em;padding-bottom:.25em;border-bottom:1px solid color-mix(in srgb,var(--text) 16%,transparent)}
.agx-md h3{font-size:1.1em}
.agx-md h4,.agx-md h5,.agx-md h6{font-size:1em;color:var(--text2)}
.agx-md a{color:var(--primary);text-underline-offset:2px}
.agx-md strong{color:var(--text);font-weight:600}
.agx-md del{opacity:.6}
/* An inline code span, as a chip you can actually see.
   The wash is mixed from --text, not from --border or a surface: a border is
   whatever a theme wants it to be, and on the neutral ones it sits a hair from
   the panel behind it, so a chip built out of it disappeared and a symbol read
   as ordinary prose. Mixing the *text* colour into transparent always moves
   away from the background, whichever direction the theme runs, so this is a
   step on a dark theme and a step on a light one without a second rule. */
.agx-md code{font-family:var(--diff-font,ui-monospace,monospace);font-size:.88em;background:color-mix(in srgb,var(--text) 13%,transparent);border:1px solid color-mix(in srgb,var(--text) 12%,transparent);padding:.1em .4em;border-radius:5px;color:var(--text)}
.agx-md pre{background:var(--bg);border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:6px;padding:.7em .9em;overflow-x:auto;margin:0 0 .9em}
.agx-md pre code{background:none;border:0;padding:0;font-size:.92em;line-height:1.55;color:var(--text)}
.agx-md blockquote{margin:0 0 .9em;padding:.15em 0 .15em .9em;border-left:3px solid color-mix(in srgb,var(--primary) 45%,transparent);color:var(--text2)}
.agx-md ul,.agx-md ol{margin:0 0 .85em;padding-left:1.5em}
.agx-md li{margin-bottom:.3em}
.agx-md li::marker{color:var(--primary)}
.agx-md .agx-task{list-style:none;padding-left:0}
.agx-md .agx-task li{display:flex;gap:.55em;align-items:flex-start}
.agx-md .agx-box{flex:none;width:13px;height:13px;margin-top:.28em;border-radius:3px;border:1px solid color-mix(in srgb,var(--text) 24%,transparent);display:inline-flex;align-items:center;justify-content:center;font-size:9px;line-height:1}
.agx-md .agx-box[data-on="1"]{background:var(--primary);border-color:var(--primary);color:var(--bg)}
/* A grid of boxes is how a spreadsheet looks, not how a table reads. Rules
   between rows only, a banded head, and one rounded edge around the whole
   thing — the shape GitHub settled on, and the one a coverage report needs to
   be scannable down a column. */
.agx-md .agx-tw{overflow-x:auto;margin:0 0 .9em;max-width:100%;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:8px}
.agx-md table{border-collapse:collapse;font-size:.95em;width:100%}
.agx-md th{text-align:left;padding:.55em .9em;background:color-mix(in srgb,var(--border) 22%,transparent);color:var(--text);font-weight:600;border:0;border-bottom:1px solid color-mix(in srgb,var(--text) 16%,transparent);white-space:nowrap}
.agx-md td{padding:.5em .9em;border:0;border-bottom:1px solid color-mix(in srgb,var(--text) 11%,transparent);vertical-align:top;color:var(--text)}
.agx-md tbody tr:last-child td{border-bottom:0}
.agx-md .agx-details{margin:0 0 .9em;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);border-radius:6px;padding:.5em .8em;background:color-mix(in srgb,var(--border) 8%,transparent)}
.agx-md .agx-details>summary{cursor:pointer;color:var(--text);font-weight:600;list-style:revert}
.agx-md .agx-details>div{margin-top:.7em}
.agx-md .agx-suggestion{margin:0 0 .9em;border:1px solid color-mix(in srgb,var(--success) 45%,transparent);border-radius:6px;overflow:hidden}
.agx-md .agx-suggestion-head{font-size:.8em;letter-spacing:.05em;text-transform:uppercase;padding:.35em .8em;color:var(--success);background:color-mix(in srgb,var(--success) 12%,transparent);display:flex;align-items:center;gap:.7em}
.agx-md .agx-suggestion-apply{margin-left:auto;text-transform:none;letter-spacing:0;font-size:.95em;padding:.1em .6em;border-radius:5px;border:1px solid color-mix(in srgb,var(--success) 50%,transparent);color:var(--success);cursor:pointer}
.agx-md .agx-suggestion-apply:disabled{opacity:.45;cursor:default}
.agx-md .agx-suggestion pre{margin:0;border:0;border-radius:0;background:color-mix(in srgb,var(--success) 6%,transparent)}
.agx-md .agx-alert{margin:0 0 .9em;padding:.6em .9em;border-left:3px solid;border-radius:0 6px 6px 0;display:flex;flex-direction:column;gap:.3em}
.agx-md .agx-alert>b{font-size:.82em;letter-spacing:.06em}
.agx-md hr{border:0;border-top:1px solid color-mix(in srgb,var(--text) 16%,transparent);margin:1.2em 0}
.agx-md figure{margin:0 0 .9em}
.agx-md figure img{max-width:100%;border-radius:6px;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);display:block}
.agx-md figcaption{font-size:.85em;color:var(--text3);margin-top:.35em}
`;

/** One markdown block. Images go through the proxy — GitHub's own attachment
 *  URLs answer 404 without the token, and those are the review's evidence. */
/**
 * A proposed replacement, with the button that takes it.
 *
 * GitHub has no API for this — their Apply button is web-only — so the server
 * writes the commit itself: read the file at the head of the branch, splice the
 * lines, commit through `createCommitOnBranch` with the head oid as a guard so
 * a concurrent push is refused rather than clobbered.
 */
function Suggestion({ text }: { text: string }) {
  const ctx = useContext(SuggestCtx);
  return (
    <div className="agx-suggestion">
      <div className="agx-suggestion-head">
        <span>Suggested change</span>
        {ctx && (
          <button onClick={() => ctx.apply(text)} disabled={ctx.busy}
            title="Commit this to the pull request's branch"
            className="agx-btn agx-suggestion-apply">Apply</button>
        )}
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

/** shields.io's own colour words, as this app's palette. */
const SHIELD_TINT: Record<string, string> = {
  brightgreen: "var(--success)", green: "var(--success)", success: "var(--success)",
  yellow: "var(--warning)", yellowgreen: "var(--warning)", orange: "var(--warning)", important: "var(--warning)",
  red: "var(--error)", critical: "var(--error)",
  blue: "var(--info)", informational: "var(--info)", lightblue: "var(--info)",
  lightgrey: "var(--text3)", lightgray: "var(--text3)", grey: "var(--text3)", gray: "var(--text3)", inactive: "var(--text3)",
};

/**
 * A CI badge, drawn from its URL.
 *
 * Two tones, like the real thing: the label sits on a neutral ground and the
 * value takes the colour, so `Coverage 75%` reads as one object and the number
 * is what the eye lands on. An unknown colour word falls back to a hex value if
 * shields was given one, and to the accent otherwise — never to nothing.
 */
function ShieldPill({ label, value, color }: { label: string; value: string; color: string }) {
  const tint = SHIELD_TINT[(color || "").toLowerCase()]
    ?? (/^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : "var(--primary)");
  return (
    <span className="inline-flex items-stretch rounded overflow-hidden align-middle mb-2 text-[10px] leading-none"
      title={label ? `${label}: ${value}` : value}>
      {label && (
        <span className="px-1.5 py-1" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}>{label}</span>
      )}
      <span className="px-1.5 py-1 font-semibold"
        style={{ background: tint, color: "var(--bg)" }}>{value}</span>
    </span>
  );
}

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
    // A shields.io badge is text pretending to be a picture. Drawn rather than
    // fetched: the proxy does not allow that host, so every CI comment opened
    // with a broken image where its headline number should have been.
    const badge = parseShieldBadge(b.src);
    if (badge) return <ShieldPill {...badge} />;
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
  if (b.kind === "details") {
    // A real disclosure. Bots fold their output into <details>, and until now
    // the tags came through escaped — the "collapsed" part of a collapsed
    // comment was the one thing that did not work.
    return (
      <details className="agx-details">
        <summary>{b.summary}</summary>
        <div>{b.blocks.map((inner, i) => <Block key={i} b={inner} />)}</div>
      </details>
    );
  }
  if (b.kind === "alert") {
    const tint = b.level === "caution" || b.level === "warning" ? "var(--warning)"
      : b.level === "important" ? "var(--primary)"
      : b.level === "tip" ? "var(--success)" : "var(--info)";
    return (
      <div className="agx-alert" style={{ borderColor: tint, background: `color-mix(in srgb, ${tint} 8%, transparent)` }}>
        <b style={{ color: tint }}>{b.level.toUpperCase()}</b>
        <span dangerouslySetInnerHTML={{ __html: b.html }} />
      </div>
    );
  }
  if (b.kind === "suggestion") return <Suggestion text={b.text} />;
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
        // ensureLanguage, not loadLanguage: the grammar is warmed so the first
        // line of the first file of this language is tokenized properly.
        await ensureLanguage(hl, id).catch(() => {});
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

/** Who `@` completes to and which issues `#` does, for the composer. A context
 *  for the same reason as RepoCtx: the composer is rendered from several places
 *  and none of them should have to carry this. */
export type Mentionables = { users: string[]; issues: { number: number; title: string }[] };
export const MentionCtx = createContext<Mentionables | null>(null);

/** The emoji names the composer offers. Same table the renderer uses. */
const EMOJI_NAMES: Record<string, string> = {
  tada: "🎉", rocket: "🚀", sparkles: "✨", bug: "🐛", fire: "🔥", warning: "⚠️",
  white_check_mark: "✅", x: "❌", "+1": "👍", "-1": "👎", eyes: "👀", heart: "❤️",
  pray: "🙏", clap: "👏", wrench: "🔧", memo: "📝", lock: "🔒", zap: "⚡",
  boom: "💥", art: "🎨", recycle: "♻️", bulb: "💡", mag: "🔍", robot: "🤖",
};

/** The `owner/name` these bodies belong to, so `#123` and bare SHAs can link
 *  somewhere real. A context because `Md` is rendered from a dozen places and
 *  threading a prop through all of them to reach the same value is noise. */
export const RepoCtx = createContext<string | undefined>(undefined);

/** How a suggestion block gets applied. Supplied by whichever thread the
 *  comment belongs to, because only it knows the file and the lines; a markdown
 *  block on its own knows neither. Null where there is nothing to apply to (a
 *  suggestion written in the PR body, say). */
export const SuggestCtx = createContext<{ apply: (text: string) => void; busy: boolean } | null>(null);

export function Md({ body, className }: { body: string; className?: string }) {
  const repo = useContext(RepoCtx);
  const blocks = useMemo(() => parseBody(body, repo), [body, repo]);
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

/**
 * The lines around a hunk, fetched on demand.
 *
 * A diff only carries what GitHub chose to send — three lines of context — so
 * the code just above a change is not in the payload at all and there is
 * nothing to reveal locally. Each expansion asks the server for that slice of
 * the file at this side of the pull request, twenty lines at a time, the way
 * GitHub's own chevrons work.
 */
function ExpandContext({ root, number, path, from, to, side = "RIGHT" }: {
  root: string; number: number; path: string; from: number; to: number; side?: "LEFT" | "RIGHT";
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (from > to) return null;
  const load = async () => {
    setBusy(true); setErr(null);
    const r = await api.prFileSlice(root, number, path, side, from, to).catch(() => null);
    setBusy(false);
    if (!r?.ok || !r.lines) { setErr(r?.error || "Could not read that part of the file"); return; }
    setLines(r.lines);
  };
  if (lines) {
    return (
      <div className="whitespace-pre px-3 py-0.5 text-[12px]" style={{ ...CODE_FONT_STYLE, color: "var(--text3)", background: "color-mix(in srgb, var(--border) 8%, transparent)" }}>
        {lines.join("\n")}
      </div>
    );
  }
  return (
    <button onClick={load} disabled={busy} title={`Show lines ${from}-${to}`}
      className="agx-btn w-full text-left px-3 py-0.5 text-[10.5px]"
      style={{ color: err ? "var(--error)" : "var(--text3)", background: "color-mix(in srgb, var(--border) 10%, transparent)" }}>
      {err ?? (busy ? "…" : `⌃⌄ Expand ${to - from + 1} line${to - from ? "s" : ""}`)}
    </button>
  );
}

/**
 * An image, before and after.
 *
 * A unified diff cannot say anything about a PNG — the file list reports it as
 * "no textual diff" and that is the end of it. Both sides are fetched by path
 * and shown next to each other, which is the whole question an image change
 * raises: what did it look like, and what does it look like now. Added and
 * deleted files simply have one side.
 */

function ImageDiff({ root, number, path, status }: {
  root: string; number: number; path: string; status: string;
}) {
  const [sides, setSides] = useState<{ left?: string; right?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const want: ("LEFT" | "RIGHT")[] =
      status === "added" ? ["RIGHT"] : status === "removed" || status === "deleted" ? ["LEFT"] : ["LEFT", "RIGHT"];
    Promise.all(want.map((side) => api.prFileSlice(root, number, path, side).then((r) => [side, r] as const).catch(() => [side, null] as const)))
      .then((res) => {
        if (!live) return;
        const out: { left?: string; right?: string } = {};
        for (const [side, r] of res) {
          // Text came back for an image: that is an SVG, which is both. Render
          // it from a data URL rather than round-tripping the bytes again.
          const url = r?.ok
            ? (r.url || (r.lines ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(r.lines.join("\n"))))}` : ""))
            : "";
          if (url) out[side === "LEFT" ? "left" : "right"] = api.prAssetUrl(url);
        }
        if (!out.left && !out.right) setErr("Could not read the image on either side");
        setSides(out);
      });
    return () => { live = false; };
  }, [root, number, path, status]);

  if (err) return <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>{err}</div>;
  if (!sides) return <Loading label="Loading the image…" size={18} />;
  const pane = (label: string, src?: string, tint?: string) => (
    <div className="flex-1 min-w-0 p-3 flex flex-col gap-1.5 items-start">
      <span className="text-[9.5px] uppercase tracking-wider" style={{ color: tint ?? "var(--text3)" }}>{label}</span>
      {src
        ? <img src={src} alt="" className="max-w-full rounded" style={{ maxHeight: 320, border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "repeating-conic-gradient(color-mix(in srgb, var(--border) 22%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px" }} />
        : <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>—</span>}
    </div>
  );
  return (
    <div className="flex flex-wrap w-full">
      {sides.left !== undefined || sides.right === undefined ? pane("before", sides.left, "var(--error)") : null}
      {sides.right !== undefined || sides.left === undefined ? pane("after", sides.right, "var(--success)") : null}
    </div>
  );
}

function DiffPane({ file, split, wrap, onPick, sel, expand, rowAfter, permalink }: {
  file: FileChange; split: boolean; wrap: boolean;
  onPick?: (p: LinePick) => void; sel?: LineSel;
  /** Renders the "expand" strip above each hunk, when the file is one we can
   *  fetch more of. Absent for a commit diff, which is not a pull request. */
  expand?: (hunkIndex: number) => React.ReactNode;
  /** Renders a review-comment thread inline, under the line it is anchored to.
   *  Called per row with the new/old line numbers; return null for lines with
   *  no comment. Absent for a commit diff, which carries no review threads. */
  rowAfter?: (newN: number | null | undefined, oldN: number | null | undefined) => React.ReactNode;
  /** A GitHub permalink to a line, for the "+" menu's Copy link. Present ⇒ this
   *  is a pull request, so the "+" opens the review menu. */
  permalink?: (line: number, side: "LEFT" | "RIGHT") => string | null;
}) {
  // Syntax highlighting, which this pane never had: `Code` reads the theme out
  // of `HiliteCtx`, and with no Provider above it every PR diff rendered as
  // plain monochrome text while the very same viewer in the changes modal came
  // out coloured. A very long diff drops the theme (not the parse) so a
  // thousand-line file does not spend its time colouring.
  const { hilite } = useDiffHighlight(file.file_path);
  const heavy = file.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000;
  return (
    <HiliteCtx.Provider value={heavy ? { ...hilite, theme: null } : hilite}>
      <LineMenuCtx.Provider value={onPick ? { permalink } : null}>
        {split
          ? <SplitDiff c={file} wrap={wrap} onPick={onPick} sel={sel} rowAfter={rowAfter} />
          : <UnifiedDiff c={file} wrap={wrap} onPick={onPick} sel={sel} hunkAction={expand} rowAfter={rowAfter} />}
      </LineMenuCtx.Provider>
    </HiliteCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// list row
// ---------------------------------------------------------------------------

/** Placeholder rows while the list is on its way.
 *
 *  A spinner says "wait"; these say "a list is coming, roughly this shape",
 *  which is the difference between a pane that feels slow and one that feels
 *  broken. `prefers-reduced-motion` drops the shimmer, not the placeholder. */
/**
 * Waiting, said properly.
 *
 * A line of text in the top-left corner of an otherwise empty pane does not
 * read as "working" — it reads as the whole answer, and a wrong-looking one.
 * A spinner in the middle of the space it is going to fill says where the
 * content will be and that something is still happening.
 *
 * Reduced motion gets a pulse rather than nothing: a ring that has stopped
 * turning reads as a spinner that has hung, which is the opposite of the
 * message.
 */
const LOADING_CSS = `
@keyframes agxspin{to{transform:rotate(360deg)}}
@keyframes agxbreathe{0%,100%{opacity:.3}50%{opacity:.85}}
.agx-spin{border-radius:50%;border:2px solid color-mix(in srgb,var(--text) 24%,transparent);border-top-color:var(--primary);animation:agxspin .7s linear infinite}
@media (prefers-reduced-motion:reduce){.agx-spin{animation:agxbreathe 1.6s ease-in-out infinite}}
`;

function Loading({ label, fill, size = 22 }: { label: string; fill?: boolean; size?: number }) {
  return (
    <div role="status" aria-live="polite"
      className={`flex flex-col items-center justify-center gap-2.5 ${fill ? "flex-1 min-h-0 self-stretch" : "w-full py-6"}`}
      style={{ color: "var(--text3)" }}>
      <span className="agx-spin shrink-0" style={{ width: size, height: size }} />
      <span className="text-[10.5px]">{label}</span>
    </div>
  );
}

function Skeletons({ n = 6 }: { n?: number }) {
  return (
    <div aria-hidden>
      <style>{`@keyframes agxpulse{0%,100%{opacity:.35}50%{opacity:.7}}
@media (prefers-reduced-motion:reduce){.agx-sk{animation:none!important}}`}</style>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="px-2.5 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)" }}>
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

/**
 * The list's columns, as one string.
 *
 * The heading row and every data row read this same constant, so they cannot
 * drift apart — headings that do not sit over their own values are worse than
 * no headings at all.
 */
const PR_GRID = "78px minmax(0,1fr) 118px 112px 84px 84px";

/**
 * Row backgrounds live here rather than in a `style` prop because an inline
 * background cannot be overridden by `:hover` — the highlighted row would be
 * the one row in the table that did not respond to the pointer.
 */
const PR_ROW_CSS = `
.agx-prrow:hover{background:color-mix(in srgb, var(--border) 16%, transparent)}
.agx-prrow[data-active="1"]{background:color-mix(in srgb, var(--primary) 12%, transparent)}
.agx-prrow[data-active="1"]:hover{background:color-mix(in srgb, var(--primary) 18%, transparent)}
`;

/** The state of a pull request as the one glyph the ID column has room for. */
function rowState(p: PrSummary): { tint: string; title: string } {
  if (p.state === "MERGED") return { tint: "var(--primary)", title: "Merged" };
  if (p.state === "CLOSED") return { tint: "var(--text3)", title: "Closed without merging" };
  if (p.isDraft) return { tint: "var(--text3)", title: "Draft" };
  return { tint: "var(--success)", title: "Open" };
}

/**
 * Who was asked to review, as faces.
 *
 * Empty and not-yet-known are different, and the column says so: a dash means
 * nobody was asked, a dimmed ellipsis means the second pass has not landed. The
 * faces come from the login through the app's avatar proxy; a team has no face
 * and gets its initials in a flat badge rather than a portrait of nobody.
 */
/**
 * One requested reviewer's face.
 *
 * A team has no avatar and no login, so asking the proxy for a portrait of
 * "platform" returns a broken image; it gets its initials in a flat badge
 * instead. Shared by the three places that draw a reviewer, which used to
 * disagree — only the list knew teams existed, because only the list was given
 * a shape that could say so.
 */
function ReviewerFace({ r, size }: { r: PrReviewer; size: number }) {
  if (!r.isTeam) return <Avatar login={r.login} size={size} />;
  return (
    <span className="rounded-full inline-flex items-center justify-center shrink-0" title={`${r.login} (team)`}
      style={{ width: size, height: size, fontSize: size * 0.42, color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 24%, transparent)" }}>
      {r.login.slice(0, 2).toUpperCase()}
    </span>
  );
}

function ReviewerStack({ p }: { p: PrSummary }) {
  const list = p.reviewers ?? [];
  if (list.length === 0) {
    const pending = p.checksLoaded === false;
    return (
      <span className="text-[10px]" style={{ color: "var(--text3)" }}
        title={pending ? "Still loading" : "Nobody has been asked to review"}>{pending ? "…" : "—"}</span>
    );
  }
  const shown = list.slice(0, 3);
  const rest = list.length - shown.length;
  return (
    <span className="flex items-center min-w-0" title={`Review requested from ${list.map((r) => r.login).join(", ")}`}>
      {shown.map((r, i) => (
        <span key={r.login} className="shrink-0 rounded-full" style={{ marginLeft: i === 0 ? 0 : -5, boxShadow: "0 0 0 1.5px var(--bg2)" }}>
          <ReviewerFace r={r} size={18} />
        </span>
      ))}
      {rest > 0 && <span className="ml-1 text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>+{rest}</span>}
    </span>
  );
}

function ChecksCell({ p }: { p: PrSummary }) {
  const c = p.checks;
  const loading = p.checksLoaded === false;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <Dot tint={loading ? "var(--text3)" : stateTint(p)}
        title={loading ? "Check states are still loading" : `${c.success} passed · ${c.failure} failed · ${c.skipped} skipped · ${c.pending} running`} />
      <span className="text-[10.5px] tabular-nums truncate" style={{ color: loading ? "var(--text3)" : "var(--text2)" }}>
        {/* Not yet fetched is not the same as none. Saying "no checks" here
            would be a claim about the repository rather than about us. */}
        {loading ? "Checks…"
          : c.total === 0 ? "No checks"
          : c.pending > 0 ? `${c.total - c.pending}/${c.total}`
          : c.failure > 0 ? `${c.failure} failing` : "Green"}
      </span>
    </span>
  );
}

function PrTableHead() {
  return (
    <div className="grid items-center gap-3 px-3 py-1.5 border-b shrink-0 sticky top-0 z-10 select-none"
      style={{
        gridTemplateColumns: PR_GRID,
        borderColor: "color-mix(in srgb, var(--text) 11%, transparent)",
        // The workspace panel this lives in is painted --bg2; a sticky heading
        // in --bg would read as a band of the wrong colour sliding over the
        // rows rather than as the table's own header.
        background: "var(--bg2)",
        color: "var(--text3)",
        fontSize: 9,
        letterSpacing: ".07em",
        textTransform: "uppercase",
      }}>
      <span>ID</span>
      <span>Title / context</span>
      <span>Reviewers</span>
      <span>Checks</span>
      <span>Updated</span>
      <span />
    </div>
  );
}

function PrRow({ p, active, onSelect, onReview }: {
  p: PrSummary; active: boolean; onSelect: () => void; onReview: () => void;
}) {
  const st = rowState(p);
  const shownLabels = p.labels.slice(0, 2);
  return (
    <div data-pr-row={p.number} data-active={active ? "1" : undefined} onClick={onSelect} role="button" tabIndex={-1}
      className="grid items-center gap-3 px-3 py-2 border-b cursor-pointer agx-prrow"
      style={{
        gridTemplateColumns: PR_GRID,
        borderColor: "color-mix(in srgb, var(--text) 11%, transparent)",
        boxShadow: active ? "inset 2px 0 0 var(--primary)" : undefined,
      }}>
      <span className="flex items-center gap-1 text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>
        <span title={st.title} style={{ color: st.tint }}>⇅</span>#{p.number}
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[12px]" style={{ color: "var(--text)" }}>{p.title}</span>
          {p.isCurrentBranch && <Chip text="here" tint="var(--primary)" title="This checkout is on that branch" />}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[10px]" style={{ color: "var(--text3)" }}>
          <span className="truncate shrink-0" style={{ maxWidth: 140 }}>{p.author}</span>
          {p.isDraft ? <Chip text="draft" tint="var(--text3)" /> : <ReviewChip d={p.reviewDecision} />}
          {shownLabels.map((l) => <Chip key={l.name} text={l.name} tint={l.color ? `#${l.color}` : "var(--primary)"} />)}
          {p.labels.length > shownLabels.length && (
            <span className="tabular-nums shrink-0" title={p.labels.map((l) => l.name).join(", ")}>+{p.labels.length - shownLabels.length}</span>
          )}
        </div>
      </div>

      <ReviewerStack p={p} />
      <ChecksCell p={p} />
      <span className="text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>{ago(p.updatedAt)}</span>

      {/* The row's one action, and the panel's whole reason to exist: hand the
          pull request to the chat rather than to a browser tab. It stops the
          click from also opening the row, which would bury the chat it just
          opened under a detail page nobody asked for. */}
      <button onClick={(e) => { e.stopPropagation(); onReview(); }}
        className="agx-btn text-[10px] px-2 py-1 rounded justify-self-end whitespace-nowrap"
        title="Hand this pull request to the chat for a local review"
        style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>
        Review →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

export function PrView({ active, onOpenChatWith, onReviewInTerminal, jumpTo }: {
  active: boolean;
  /** A search another panel asked us to land on — see lib/openPrs.ts. */
  jumpTo?: string | null;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  /** Hand the review to the user's own tmux instead of to the chat. */
  onReviewInTerminal?: (root: string, number: number) => void;
}) {
  const { ask, askText, dialog } = useDialogs();

  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");
  const [repo, setRepo] = useState<PrRepoId | null>(null);
  /** The panel opens on what is waiting on you, not on what you wrote — that
   *  is the question a review dashboard exists to answer. If nothing is waiting
   *  the first load falls through to your own pull requests once, so opening it
   *  never lands on an empty pane. */
  const [filter, setFilter] = useState<Filter>("review");
  const [stateSel, setStateSel] = useState<StateSel>("open");
  /** Cursors we have walked through. `[]` is page 1; each Next pushes the
   *  cursor that fetched the page we are about to show, so Previous is a pop.
   *  GitHub's cursors are opaque and only move forward, so a stack is the only
   *  way back. */
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages[pages.length - 1];
  const fellBack = useRef(false);
  // The filter query for the current scope tab — the single source of truth for
  // both the search box and every facet dropdown (parsed in lib/prFilter.ts).
  // Cleared when the scope changes so each tab (mine / review / all) starts
  // fresh; "all" can be hundreds of rows and a facet beats scrolling.
  const [query, setQuery] = useState("");
  // Somebody sent us here looking for a particular pull request. Applied on
  // each new request rather than once, so asking twice for two different cards
  // works the second time too.
  useEffect(() => { if (active && jumpTo) setQuery(jumpTo); }, [active, jumpTo]);
  // The query filters the rows already loaded LIVE and client-side (visiblePrs),
  // so typing is instant. The SERVER copy — which re-runs `gh` to search across
  // the pages the client does not hold — is debounced off it. Before this, every
  // keystroke was in loadList's deps, so every letter refetched from GitHub and
  // blanked the list mid-word: unusable, which is exactly what it looked like.
  const [serverQuery, setServerQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setServerQuery(query), 400);
    return () => clearTimeout(t);
  }, [query]);
  // A new server search is a new list — start it at page one, never continuing a
  // cursor that belonged to the previous query.
  useEffect(() => { setPages([]); }, [serverQuery]);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [listState, setListState] = useState<{ fetchedAt: number; loading: boolean; checksPending?: boolean; error?: string; needsAuth?: boolean; total?: number; hasNext?: boolean; cursor?: string | null; pageSize?: number }>({ fetchedAt: 0, loading: false });
  // Two different things, which the panel used to conflate. `selected` is the
  // pull request you are *in* — the list gives way to it, as a page.
  // `rowCursor` is only where the keyboard is in the list, so j/k can walk the
  // rows without opening (and fetching) every one it passes over. Named apart
  // from the pagination `cursor` above, which is a GitHub page token.
  const [selected, setSelected] = useState<number | null>(null);
  const [rowCursor, setRowCursor] = useState<number | null>(null);
  /** Whether the pull request's masthead has given its metadata back to the
   *  page. Reset whenever another pull request is opened, or the second one
   *  would open already collapsed with its scroll at the top. */
  const [condensed, setCondensed] = useState(false);
  /** A file being read whole, over the panel. Null when nothing is open. */
  const [peek, setPeek] = useState<Peek | null>(null);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  /** The description editor has taken the whole column. Lifted out of
   *  <Description> so the shell can hide the masthead, tabs and sidebar behind
   *  it — editing a body is a mode, not a box wedged into the read view. */
  const [editingBody, setEditingBody] = useState(false);
  /** Open a pull request as a page. Back returns to the list, cursor intact. */
  const openPr = useCallback((n: number) => { setRowCursor(n); setSelected(n); setTab("overview"); setCondensed(false); setEditingBody(false); }, []);
  const backToList = useCallback(() => { setSelected(null); setDetailErr(""); setEditingBody(false); }, []);

  /**
   * "Open this pull request", asked from somewhere that cannot reach this panel.
   *
   * The notification list in the top bar can be open over any view, and this
   * panel may not be mounted when a row is clicked — so the request is left in a
   * slot and picked up here, the same shape the issues panel uses to start a
   * terminal it cannot reach. Cleared on service, not on arrival, so one made
   * while this was still mounting is not dropped on the way in.
   *
   * The repo is checked rather than assumed. A number alone is not an identity:
   * `#16175` names a different pull request in every repository, and opening the
   * one with that number in whichever repo happens to be selected would be a
   * confident wrong answer. Mismatched, the request waits for the repo it named
   * — switching to it serves the request rather than losing it.
   */
  const jump = useSyncExternalStore(subscribePrJump, prJump, () => null);
  useEffect(() => {
    if (!jump || !repo) return;
    if (jump.repo !== repo.nameWithOwner) return;
    clearPrJump();
    openPr(jump.number);
  }, [jump, repo, openPr]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  // Automation comments render in full by default now that they render as
  // markdown rather than as their own source: the fold stays folded, so a 40 KB
  // coverage report is a badge and a summary line until you open it, which is
  // what the digest was protecting against in the first place. The digest is
  // still a click away for a timeline of nothing but CI.
  const [rawBots, setRawBots] = useState(true);
  const [seen, setSeen] = useState<Record<string, string[]>>(() => loadMap<string[]>(SEEN_KEY));
  const [drafts, setDrafts] = useState<Record<string, DraftComment[]>>(() => loadMap<DraftComment[]>(DRAFT_KEY));
  const [reviews, setReviews] = useState<Record<string, ReviewDraft>>(() => loadMap<ReviewDraft>(REVIEW_KEY));
  const [diff, setDiff] = useState("");
  const [selFile, setSelFile] = useState<string | null>(null);
  const [selCommit, setSelCommit] = useState<string | null>(null);
  // Which commits have their full message open. Separate from `selCommit`, so
  // reading the message costs nothing and does not fetch a diff.
  const [openMsgs, setOpenMsgs] = useState<Set<string>>(new Set());
  // The CI jobs behind this pull request's checks. Fetched only when the checks
  // tab is opened — it costs a couple of REST calls and most visits never look.
  const [jobs, setJobs] = useState<PrCheckJob[]>([]);
  // Fetched once per repo, cached server-side for five minutes: the composer
  // wants an instant dropdown, not a live directory.
  const [mentions, setMentions] = useState<Mentionables | null>(null);
  /** The repository's own labels, authors, milestones and branches. Derived
   *  from the loaded page before, which made the Author menu a list of whoever
   *  happened to be on page one. */
  const [facetOpts, setFacetOpts] = useState<RepoFacets | null>(null);
  useEffect(() => {
    if (!active || !root) return;
    let live = true;
    api.prFacets(root)
      .then((r) => { if (live && r.ok && r.data) setFacetOpts(r.data); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, root]);
  useEffect(() => {
    if (!active || !root) return;
    let live = true;
    api.prMentions(root)
      .then((r) => { if (live && r.ok && r.data) setMentions(r.data); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, root]);
  const toggleMsg = (oid: string) => setOpenMsgs((cur) => {
    const next = new Set(cur);
    if (next.has(oid)) next.delete(oid); else next.add(oid);
    return next;
  });
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
    api.prList(root, filter, stateSel, force, cursor, serverQuery).then((r) => {
      if (req !== listReq.current) return; // a newer request already won
      setRepo(r.repo);
      setPrs(r.prs);
      setListState({ fetchedAt: r.fetchedAt, loading: r.loading, checksPending: r.checksPending, error: r.error, needsAuth: r.needsAuth, total: r.total, hasNext: r.hasNext, cursor: r.cursor ?? null, pageSize: r.pageSize });
      // The keyboard cursor, never the open pull request. This lands on every
      // poll and on every scope switch, and when the list was a column beside a
      // detail pane, falling back to `prs[0]` only decided which one the pane
      // previewed. Now that a pull request is a page, the same line meant
      // picking a view — or just waiting through a refresh — opened whatever
      // happened to be first. A row is opened when somebody opens it.
      setRowCursor((cur) => (cur && r.prs.some((p) => p.number === cur) ? cur : null));
      // Nothing waiting on you: show your own instead of an empty pane. Once
      // only, so choosing "Needs my review" yourself is never overruled.
      if (want === "review" && stateSel === "open" && r.prs.length === 0 && !r.loading && !r.error && !fellBack.current) {
        fellBack.current = true;
        setFilter("mine");
      }
    }).catch((e) => {
      if (req !== listReq.current) return;
      setListState({ fetchedAt: 0, loading: false, error: String(e) });
    });
  }, [root, filter, stateSel, cursor, serverQuery]);

  /**
   * Switching filter empties the pane before anything is fetched.
   *
   * Otherwise the previous filter's selection stays on screen for the second or
   * two the new list takes, and you are reading one pull request under a tab
   * that says you are looking at another.
   */
  const lastScope = useRef<string>("");
  useEffect(() => {
    const scope = `${root}\u0000${filter}\u0000${stateSel}`;
    if (lastScope.current === scope) return; // re-render, not a switch
    const first = lastScope.current === "";
    lastScope.current = scope;
    if (first) return; // nothing on screen yet to clear
    listReq.current++;
    // Back to page one: a cursor belongs to the search it came from, and
    // carrying it into a different scope asks GitHub to continue a list that no
    // longer exists. The counts go too — they are per-state, and leaving them
    // up is how every pill read 0 after switching to Closed.
    setPages([]);
    setViewCounts({});
    // The rows STAY on screen while the new ones are fetched.
    //
    // Blanking them meant every switch showed a skeleton for as long as GitHub
    // took — about a second and a half, and the round trip is the floor, not
    // something a faster query removes. Keeping the previous list up (dimmed,
    // and labelled as loading) is what GitHub does, and it turns that second and
    // a half from a wait into a redraw. `listReq` still guards the answer, so a
    // slow reply for the scope you left can never land on the one you are in.
    setSelected(null);
    setDetail(null);
    setDetailErr("");
    setListState((st) => ({ ...st, loading: true }));
  }, [filter, root, stateSel]);

  // Polling pauses while the view is hidden — no point spending requests on a
  // pane nobody is looking at — and resumes on return. Resuming refreshes; it
  // does not reset.

  /**
   * Warm the states you are not looking at.
   *
   * Each state is its own cache entry on the server, so the first visit to
   * Closed or All paid the whole fetch — about a second and a half of GitHub —
   * while the user watched. Touching them once in the background makes the
   * switch instant. Staggered, because the point is to spend idle time, not to
   * queue three searches behind the one being waited on.
   */
  useEffect(() => {
    if (!active || !root || listState.loading) return;
    const others = (["open", "closed", "all"] as StateSel[]).filter((st) => st !== stateSel);
    const timers = others.map((st, i) => setTimeout(() => {
      void api.prList(root, filter, st, false).catch(() => {});
      void api.prCounts(root, st).catch(() => {});
    }, 1500 + i * 2000));
    return () => timers.forEach(clearTimeout);
  }, [active, root, filter, stateSel, listState.loading]);

  /**
   * Fetch the next page before it is asked for.
   *
   * Each page is its own entry in the server's cache, so touching it once means
   * Next answers from memory instead of waiting on GitHub. Deliberately after a
   * beat, and never while the current page is still loading: the point is to
   * spend the idle time, not to compete for it.
   */
  useEffect(() => {
    if (!active || !root || !listState.hasNext || !listState.cursor || listState.loading) return;
    const next = listState.cursor;
    const t = setTimeout(() => { void api.prList(root, filter, stateSel, false, next).catch(() => {}); }, 900);
    return () => clearTimeout(t);
  }, [active, root, filter, stateSel, listState.hasNext, listState.cursor, listState.loading]);

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
    let live = true;
    // One request for all five numbers, and they are the TRUE totals for the
    // current state — not a tally of the page on screen, which stopped being
    // the answer the moment the list got pages, and not a stale figure carried
    // over from a different state.
    api.prCounts(root, stateSel)
      .then((r) => { if (live && r.ok && r.counts) setViewCounts(r.counts as unknown as Record<string, number>); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, root, stateSel, listState.fetchedAt]);

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
  const visiblePrs = useMemo(() => sortRows(prs, filters), [prs, filters]);
  const facets = useMemo(() => buildFacets(prs, filters, facetOpts), [prs, filters, facetOpts]);

  /** What each view last counted.
   *
   *  Only the scope currently loaded has rows to count, so a view on another
   *  scope can only report what it last saw — the same deal the panel already
   *  makes for the list itself, which shows its own age rather than pretending
   *  to be live. A view that has never been loaded shows no number at all,
   *  because a made-up one next to "Failing" is worse than none: you would act
   *  on it. */
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  /**
   * Only the server's totals. Nothing is counted from the rows on screen.
   *
   * A tally of the current page under a pill that filters the whole repository
   * is not a smaller truth, it is a wrong one — it read "Yoshiofthewire 2" when
   * he has three, because the third is on page four.
   */
  const viewCount = useCallback((v: (typeof VIEWS)[number]): number | null => {
    const exact = viewCounts[v.id];
    return typeof exact === "number" ? exact : null;
  }, [viewCounts]);

  const activeView = VIEWS.find((v) => v.scope === filter && v.query === query.trim());

  // If the cursor's row is filtered out, move it to the first row still visible
  // rather than leaving a phantom highlight on a hidden PR — the same
  // reconciliation loadList does when the list itself changes. Only when a
  // cursor existed; never auto-places one out of the empty initial state. The
  // *open* pull request is deliberately left alone: you asked for that page, and
  // a filter typed underneath it is no reason to close it.
  useEffect(() => {
    if (rowCursor != null && !visiblePrs.some((p) => p.number === rowCursor)) {
      setRowCursor(visiblePrs[0]?.number ?? null);
    }
  }, [visiblePrs, rowCursor]);

  useEffect(() => {
    if (tab !== "checks" || !detail || !root) return;
    let live = true;
    setJobs([]);
    api.prCheckJobs(root, detail.number)
      .then((r) => { if (live && r.ok && r.jobs) setJobs(r.jobs); })
      .catch(() => {});
    return () => { live = false; };
  }, [tab, detail?.number, root]);

  // Keyboard nav over the list, keyboard-first like the files tab (which relies
  // on the same thing: App.tsx ignores bare letters while the workspace is open,
  // so j/k/n/p are free here). Selection is derived, not a second state.
  const listRef = useRef<HTMLDivElement>(null);
  const stepSel = (d: number) => {
    if (!visiblePrs.length) return;
    const i = visiblePrs.findIndex((p) => p.number === rowCursor);
    const ni = i < 0 ? (d > 0 ? 0 : visiblePrs.length - 1) : (i + d + visiblePrs.length) % visiblePrs.length;
    const n = visiblePrs[ni].number;
    setRowCursor(n);
    // Walking past the bottom of the viewport with j should not mean losing the
    // row you are on.
    requestAnimationFrame(() => {
      document.querySelector(`[data-pr-row="${n}"]`)?.scrollIntoView({ block: "nearest" });
    });
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
    // The list is a page now, so the keyboard needs a way in as well as a way
    // along: Enter opens the row the cursor is on.
    else if (e.key === "Enter" && rowCursor != null) { e.preventDefault(); e.stopPropagation(); openPr(rowCursor); }
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

  // One picker for the masthead's "＋" and the sidebar's ✎ both — lifted here
  // so it can open from the masthead on every tab, not only where the sidebar
  // renders.
  const fieldPicker = usePrFieldPicker(detail, root, act);

  const key = repo && detail ? `${repo.key}#${detail.number}` : "";
  // What GitHub already knows you have read, unioned with this browser's copy.
  // GitHub's is the authority — it also un-ticks a file that changed after you
  // marked it — but the local set still counts so a tick shows before the
  // round trip lands.
  const seenFiles = useMemo(() => {
    const local = key ? (seen[key] ?? []) : [];
    const remote = (detail?.files ?? []).filter((f) => f.viewed).map((f) => f.path);
    return [...new Set([...remote, ...local])];
  }, [key, seen, detail]);
  const myDrafts = key ? (drafts[key] ?? []) : [];
  const myReview: ReviewDraft = (key && reviews[key]) || { verb: "comment", body: "" };
  const hasReviewDraft = !!(key && reviews[key]);
  /** Hold the unsent review. Written through to storage on every keystroke —
   *  the whole point is that it survives a tab switch, a closed panel and a
   *  rebuild, and any of those can happen between one key and the next. */
  const setMyReview = useCallback((patch: Partial<ReviewDraft>) => {
    if (!key) return;
    setReviews((cur) => {
      const merged = { ...(cur[key] ?? { verb: "comment" as const, body: "" }), ...patch };
      // An empty note with the default verdict is not a draft — it is the
      // absence of one, and keeping it would leave a "you have a review in
      // progress" mark on every pull request you ever opened.
      const next = { ...cur };
      if (!merged.body.trim() && merged.verb === "comment") delete next[key];
      else next[key] = merged;
      saveMap(REVIEW_KEY, next);
      return next;
    });
  }, [key]);

  /**
   * Mark a file read, here and on GitHub.
   *
   * This used to be local only, so the tick disagreed with github.com, was lost
   * on another machine, and never un-ticked itself when the file changed under
   * you — all three of which GitHub's own state gets right. The local copy is
   * still written first so the switch answers instantly; the network call is
   * the one that makes it true anywhere else.
   */
  const toggleSeen = (path: string) => {
    if (!key) return;
    let nowViewed = false;
    setSeen((cur) => {
      const list = new Set(cur[key] ?? []);
      if (list.has(path)) list.delete(path); else { list.add(path); nowViewed = true; }
      const next = { ...cur, [key]: [...list] };
      saveMap(SEEN_KEY, next);
      return next;
    });
    const id = detail?.nodeId;
    if (id) void api.prFileViewed(root, id, path, nowViewed).catch(() => { /* local tick still stands */ });
  };

  /** Queue a line comment into the pending review. The body comes from the
   *  inline composer now, not a one-line dialog, so this just files it. */
  const addDraft = (path: string, line: number, startLine?: number, side?: "LEFT" | "RIGHT", body?: string) => {
    if (!body?.trim() || !key) return;
    setDrafts((cur) => {
      const next = { ...cur, [key]: [...(cur[key] ?? []), { path, line, ...(startLine && startLine !== line ? { startLine } : {}), ...(side ? { side } : {}), body: body.trim() }] };
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

  /** The same drop, addressed by the comment itself. A row in the diff holds
   *  the comment, not its position in a list it never sees — and an index is
   *  the wrong handle for something the user is pointing at. */
  const dropDraftItem = (dc: DraftComment) => {
    const i = myDrafts.indexOf(dc);
    if (i >= 0) dropDraft(i);
  };

  /**
   * One line comment, posted on its own.
   *
   * Sent as a COMMENT review carrying a single comment and no body, because
   * that is the request this panel already knows how to make and it lands the
   * remark on the line immediately. It shows on GitHub as a review with one
   * comment rather than as a lone comment — the difference is a line in the
   * timeline, not in where the remark ends up or who is notified.
   *
   * Deliberately does NOT touch the draft queue: this is the escape hatch for
   * "one typo, right here", which is exactly the case where being made to open
   * and submit a whole review is the wrong shape.
   */
  const postOneComment = async (
    path: string, line: number, startLine: number | undefined,
    side: "LEFT" | "RIGHT" | undefined, body: string,
  ): Promise<boolean> => {
    if (!body.trim()) return false;
    setBusy(true);
    try {
      const r = await api.prReviewWith(root, selected!, "comment", "", [
        { path, line, ...(startLine && startLine !== line ? { startLine } : {}), ...(side ? { side } : {}), body },
      ]);
      flash(r.ok, r.ok ? "Comment posted" : (r.error || "Could not post the comment"));
      if (r.ok) void loadDetail(selected!, true);
      return r.ok;
    } catch (e) { flash(false, String(e)); return false; }
    finally { setBusy(false); }
  };

  const submitReview = async (verb: "approve" | "request_changes" | "comment", body: string) => {
    if (!detail) return;
    const ok = await act("Review", () => api.prReviewWith(root, detail.number, verb, body, myDrafts));
    if (ok && key) {
      setDrafts((cur) => { const next = { ...cur, [key]: [] }; saveMap(DRAFT_KEY, next); return next; });
      // Sent is the one thing that clears it. Anything short of that — closing
      // the panel, switching tabs, a rebuild — leaves the draft where it was.
      setReviews((cur) => { const next = { ...cur }; delete next[key]; saveMap(REVIEW_KEY, next); return next; });
      setTab("conversation");
    }
  };

  const doMerge = async (method: MergeMethod = "squash") => {
    if (!detail) return;
    const head = detail.commits[detail.commits.length - 1]?.oid;
    const how = method === "squash" ? "Squash and merge" : method === "merge" ? "Create a merge commit" : "Rebase and merge";
    // The subject is offered for editing because it is what lands on the base
    // branch for ever. Rebase writes no commit of its own, so there is nothing
    // to name there and gh rejects the flag.
    let subject: string | undefined;
    if (method !== "rebase") {
      const t = await askText({
        title: `${how} #${detail.number} into ${detail.baseRefName}`,
        confirmLabel: how,
        input: { label: "Commit subject — this is permanent", initial: `${detail.title} (#${detail.number})` },
      });
      if (t == null) return;
      subject = t.trim() || undefined;
    } else {
      const ok = await ask({
        title: `Rebase and merge #${detail.number} into ${detail.baseRefName}?`,
        body: `${detail.title}\n\nEvery commit is replayed onto ${detail.baseRefName} with new SHAs, and no merge commit is written.`,
        confirmLabel: "Rebase & merge", danger: true,
      });
      if (!ok) return;
    }
    await act("Merge", () => api.prMerge(root, detail.number, method, { deleteBranch: true, headSha: head, subject }));
  };

  /**
   * Close, or reopen a closed one.
   *
   * The menu has offered "Reopen pull request" all along and then called close
   * with `reopen` left false, so reopening was unreachable from the UI while the
   * server supported it the whole time. The dialog was wrong in the same way,
   * asking "Close #N?" over a pull request that was already closed.
   */
  const doClose = async () => {
    if (!detail) return;
    const reopen = detail.state === "CLOSED";
    const ok = await ask({
      title: reopen ? `Reopen #${detail.number}?` : `Close #${detail.number}?`,
      body: reopen
        ? `${detail.title}\n\nIt goes back to open, with its comments and reviews intact.`
        : `${detail.title}\n\nClosed without merging. You can reopen it afterwards.`,
      confirmLabel: reopen ? "Reopen pull request" : "Close pull request", danger: !reopen,
    });
    if (!ok) return;
    await act(reopen ? "Reopen" : "Close", () => api.prClose(root, detail.number, reopen));
  };

  /**
   * Hand a pull request to the chat.
   *
   * Takes a number so a list row can do it without opening the pull request
   * first — the review prompt is built server-side from the number alone, so
   * making the row load a whole detail page just to reach this would be a
   * round trip spent on nothing.
   */
  const doLocalReview = async (n?: number) => {
    const num = n ?? detail?.number;
    if (num == null) return;
    setBusy(true);
    try {
      const r = await api.prReviewPrompt(root, num);
      if (!r.ok || !r.cwd || !r.prompt) { flash(false, r.error || "Could not prepare the review"); return; }
      if (onOpenChatWith) { onOpenChatWith(r.cwd, r.prompt, `Review #${num}`); flash(true, `#${num} is waiting in chat`); }
      else flash(false, "The chat is not available here");
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

  const doReply = async (t: PrThread, body: string): Promise<boolean> => {
    if (!detail) return false;
    const first = t.comments[0];
    if (typeof first?.databaseId !== "number" || !body.trim()) return false;
    return act("Reply", () => api.prReply(root, detail.number, first.databaseId as number, body));
  };
  /** Toggle an emoji. The node id is the GraphQL one, so the same call serves
   *  the body, a comment, a review and a line comment. */
  /**
   * Take a suggestion.
   *
   * Confirmed first: this writes a commit to somebody's branch, which is not
   * something to do on a stray click. The author of the comment is credited as
   * a co-author, as GitHub does.
   */
  const doApplySuggestion = async (t: PrThread, text: string) => {
    if (!detail || !t.line) return;
    const where = `${t.path}:${t.startLine && t.startLine !== t.line ? `${t.startLine}-${t.line}` : t.line}`;
    const ok = await ask({
      title: `Apply this suggestion to ${t.path.split("/").pop()}?`,
      body: `${where}\n\nCommits to ${detail.headRefName}, crediting ${t.comments[0]?.author ?? "the author"}. If anyone has pushed since this loaded, GitHub refuses rather than overwriting them.`,
      confirmLabel: "Apply suggestion",
    });
    if (!ok) return;
    await act("Suggestion", () => api.prApplySuggestion(root, detail.number, {
      path: t.path, line: t.line!, startLine: t.startLine ?? undefined,
      suggestion: text, author: t.comments[0]?.author,
    }));
  };

  const doReact = async (nodeId: string, content: string, on: boolean) => {
    if (!nodeId) return;
    await act(on ? "Reaction" : "Reaction removed", () => api.prReactTo(root, nodeId, content, on));
  };
  const doReviewers = async () => {
    if (!detail) return;
    // Logins, which is what the endpoint takes. A team arrives here under its
    // name for want of anywhere better to put it — exactly as it did when this
    // list was strings, so nothing about requesting one changes here.
    const cur = detail.reviewers.map((r) => r.login);
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

  /** Hand a failing check to the chat pointed at this project, with the job that
   *  broke named, so the answer is written against the code that failed rather
   *  than a guess from the name of the job. */
  const askClaudeAboutCheck = async (check: PrCheck) => {
    if (!detail || !onOpenChatWith) return;
    setBusy(true);
    try {
      const r = await api.prReviewPrompt(root, detail.number);
      if (!r.ok || !r.cwd) { flash(false, r.error || "Could not prepare the question"); return; }
      onOpenChatWith(r.cwd,
        `The check "${check.name}"${check.workflow ? ` in the ${check.workflow} workflow` : ""} is failing on pull request #${detail.number} (${detail.title}), on branch ${detail.headRefName}.\n\n` +
        `Read the failure with:  gh run view --log-failed --repo <this repo>  (or the run URL below)\n` +
        `Read the change with:  gh pr diff ${detail.number}\n\n` +
        `This working directory is the same project, but not the pull request. Work out why the job is failing and propose the fix. Do not change any files yet.` +
        (check.url ? `\n\nThe run is at ${check.url}.` : ""),
        `Check on #${detail.number}`);
      flash(true, `#${detail.number} is waiting in chat`);
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
  // You cannot review your own work, and you cannot review something that has
  // already merged or been closed — GitHub takes the review form away too.
  const canReview = !!d && !d.viewerDidAuthor && d.state === "OPEN";

  const TABS: { id: Tab; label: string; n?: number; warn?: boolean }[] = d ? [
    { id: "overview", label: "Overview" },
    { id: "conversation", label: "Conversation", n: lanes.humans.length + lanes.humanComments.length + d.threads.length + lanes.bots.length },
    { id: "commits", label: "Commits", n: d.commits.length },
    { id: "files", label: "Files", n: d.files.length },
    { id: "checks", label: "Checks", n: d.checks.total, warn: d.checks.failure > 0 },
    // The dot also means "you have a review written and not sent" — otherwise a
    // draft that survives everything else is invisible from every tab but its
    // own, which is the same as losing it.
    ...(canReview ? [{ id: "review" as Tab, label: "Review", n: myDrafts.length || undefined, warn: d.viewerRequested || hasReviewDraft }] : []),
  ] : [];

  return (
    <RepoCtx.Provider value={repo?.nameWithOwner}>
    <MentionCtx.Provider value={mentions}>
    <div className="flex flex-col h-full min-h-0">
      <style>{SCROLLBAR_CSS}{LINEBTN_CSS}{MD_CSS}{PR_ROW_CSS}{LOADING_CSS}</style>

      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <span className={viewTitleClass} style={{ color: "var(--text)" }}>Pull Requests</span>
        {/* No repo/worktree picker here: pull requests belong to the GitHub
            remote, and every worktree of a repo shares that one remote — so the
            picker only ever offered a dozen ways to look at the SAME list. The
            repo name, stated once, is all this header needs. */}
        {repo && <span className="text-[10px] truncate" style={{ color: "var(--text3)" }}>{repo.nameWithOwner}</span>}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {toast && <span className="text-[10px] max-w-[380px] truncate" style={{ color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</span>}
          {/* The loud "Loading pull requests…" is for a genuinely empty pane
              only. Once rows are up, the 20-second poll revalidates in the
              background every minute and a half — announcing that each time read
              as the list constantly reloading. With rows in hand it stays as the
              timestamp, and a quiet "· updating" is all a background refresh
              earns. */}
          <span className="text-[10px] tabular-nums" style={{ color: (listState.loading || listState.checksPending) && prs.length === 0 ? "var(--warning)" : "var(--text3)" }}>
            {prs.length === 0
              ? (listState.loading ? "Loading pull requests…"
                : listState.checksPending ? "Loading check states…"
                : listState.fetchedAt ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}` : "")
              : (listState.fetchedAt
                ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}${listState.loading || listState.checksPending ? " · updating" : ""}`
                : "")}
          </span>
          <Btn onClick={() => loadList(true)} disabled={busy} small>Refresh</Btn>
        </div>
      </div>

      {/* List or pull request, never both. The list used to live in a column
          narrow enough that a title was all it could fit, and everything worth
          scanning — who is waiting on it, whether CI is green, how old it is —
          had to be crushed onto a second line or dropped. Given the whole
          width it becomes a table you can read down a column of, and the pull
          request you pick gets the whole width in return. */}
      <div className="flex flex-1 min-h-0">
        {selected == null ? (
        <div className="flex flex-col min-h-0 flex-1 min-w-0">
          <div className="flex gap-1 flex-wrap px-2 py-1.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)" }}>
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
                style={{ color: "var(--text3)", border: "1px dashed color-mix(in srgb, var(--text) 16%, transparent)" }}>Custom</span>
            )}
            {/* Open / Closed / All — the state axis. "Closed" holds merged +
                closed, like GitHub's own Closed tab. */}
            <div className="ml-auto flex rounded-full overflow-hidden shrink-0 self-center" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
              {STATES.map((s) => (
                <button key={s.id} onClick={() => setStateSel(s.id)} title={`Show ${s.label.toLowerCase()} pull requests`}
                  className="agx-btn text-[10px] px-2 py-0.5"
                  style={{
                    color: stateSel === s.id ? "var(--bg)" : "var(--text3)",
                    background: stateSel === s.id ? "var(--primary)" : "transparent",
                  }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {repo && prs.length > 0 && (
            <PrFilterBar
              query={query}
              filters={filters}
              facets={facets}
              onQuery={setQuery}
              checksPending={listState.checksPending}
              shown={visiblePrs.length}
              total={listState.total ?? prs.length}
            />
          )}
          <div ref={listRef} tabIndex={-1} onKeyDown={onListKey} className="flex-1 overflow-y-auto min-h-0 agx-scroll outline-none">
            {listState.needsAuth ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                <div style={{ color: "var(--warning)" }}>{listState.error || "The GitHub CLI is not set up"}</div>
                {/* Two steps, and the second is the one people miss: an
                    installed gh that has never logged in reads exactly like a
                    missing one from here. The link is the project's own page,
                    not a package-manager line, because the reader's system is
                    not knowable from here. */}
                <div className="mt-2">
                  Pull requests come from <code>gh</code>. Install it (<code>{depSpec("gh")?.url}</code>), run <code>gh auth login</code>, then refresh.
                </div>
              </div>
            ) : !repo ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>{listState.error || "No GitHub remote on this repository"}</div>
            ) : prs.length === 0 ? (
              listState.loading ? <Skeletons /> : (
                <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                  {(() => {
                    const what = stateSel === "open" ? "open " : stateSel === "closed" ? "closed " : "";
                    return filter === "mine" ? `No ${what}pull requests of yours`
                      : filter === "review" ? "Nothing waiting on your review"
                      : `No ${what}pull requests`;
                  })()}
                </div>
              )
            ) : visiblePrs.length === 0 ? (
              <div className="p-3 text-[11px] flex flex-col items-start gap-1.5" style={{ color: "var(--text3)" }}>
                <span>No pull requests match {activeCount(filters) === 1 ? "this filter" : "these filters"}.</span>
                <button onClick={() => setQuery("")} className="text-[10.5px] px-2 py-0.5 rounded hover:bg-white/5" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)" }}>Clear filters</button>
              </div>
            ) : (
              // Dimmed, not blanked, while the next scope loads: you can still
              // read what is there, and it is obvious it is being replaced.
              <div style={{ opacity: listState.loading ? 0.45 : 1, transition: "opacity .15s" }}>
                <PrTableHead />
                {visiblePrs.map((p) => (
                  <PrRow key={p.number} p={p} active={p.number === rowCursor}
                    onSelect={() => openPr(p.number)} onReview={() => doLocalReview(p.number)} />
                ))}
              </div>
            )}
          </div>
          {/* Pages, because a repository has more pull requests than one screen
              of them and the panel used to stop at the first fifty with no way
              to say so. Cursors only move forward, so Previous walks a stack. */}
          {repo && (listState.hasNext || pages.length > 0) && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-t shrink-0 text-[10px]"
              style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)", color: "var(--text3)" }}>
              <button onClick={() => setPages((p) => p.slice(0, -1))} disabled={pages.length === 0 || listState.loading}
                className="agx-btn px-2 py-0.5 rounded disabled:opacity-35"
                style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>‹ Previous</button>
              <span className="tabular-nums">
                Page {pages.length + 1}
                {listState.total != null && listState.pageSize
                  ? ` of ${Math.max(1, Math.ceil(listState.total / listState.pageSize))} · ${listState.total} total`
                  : ""}
              </span>
              <button onClick={() => { if (listState.cursor) setPages((p) => [...p, listState.cursor!]); }}
                disabled={!listState.hasNext || !listState.cursor || listState.loading}
                className="agx-btn ml-auto px-2 py-0.5 rounded disabled:opacity-35"
                style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>Next ›</button>
            </div>
          )}
        </div>
        ) : (
        <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
          {/* Editing the description is a full-column mode: the editor covers
              the masthead, tabs, sidebar and footer, because none of them help
              you write, and the textarea wants every pixel of height. The
              overlay is `absolute inset-0` over a column that already has a
              definite height, so `h-full` inside it fills without a page
              scroll — the whole point of taking over. */}
          {editingBody && d && (
            <div className="absolute inset-0 z-30 flex flex-col" style={{ background: "var(--bg)" }}>
              <BodyEditor
                key={d.number}
                prNumber={d.number}
                initial={d.body}
                busy={busy}
                onOpenGithub={() => openExternal(d.url)}
                onCancel={() => setEditingBody(false)}
                onSave={async (body) => { const ok = await doEditBody(body); if (ok) setEditingBody(false); return ok; }}
              />
            </div>
          )}
          {/* The way back. A page you cannot leave is a trap, and the browser's
              Back button is not ours to borrow — this panel lives inside an
              app, not a tab. */}
          <button onClick={backToList}
            className="agx-btn flex items-center gap-1.5 px-3 py-1.5 border-b shrink-0 text-[10.5px] self-stretch justify-start"
            style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)", color: "var(--text3)" }}>
            <span>‹</span>
            <span>Pull requests</span>
            {repo && <span style={{ color: "var(--text3)", opacity: .6 }}>· {repo.nameWithOwner}</span>}
            {selected != null && <span className="tabular-nums" style={{ color: "var(--text2)" }}>· #{selected}</span>}
          </button>
          {!d ? (
            // An error is a message and belongs at the top where messages go; a
            // wait belongs in the middle of the space it is about to fill.
            detailErr
              ? <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{detailErr}</div>
              : <Loading label={`Loading #${selected}…`} fill />
          ) : (
            <>
              {/* `onLocalReview` is wrapped rather than passed by reference:
                  it lands on a click handler, and a bare reference would hand
                  the MouseEvent in as the pull request number. */}
              <Masthead
                d={d} busy={busy}
                onEditTitle={doEditTitle} onDraft={() => act(d.isDraft ? "Mark ready" : "Convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                onClose={doClose} onLocalReview={() => doLocalReview()}
                onReviewInTerminal={onReviewInTerminal && d ? () => onReviewInTerminal(root, d.number) : undefined}
                condensed={condensed}
                onLabels={doLabels} onReviewers={doReviewers} onCopyLink={doCopyLink}
                onEditField={fieldPicker.open}
              />
              {fieldPicker.node}
              <div className="flex border-b shrink-0 overflow-x-auto items-center" style={{ borderColor: "color-mix(in srgb, var(--text) 11%, transparent)" }}>
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
                  {hasReviewDraft && tab !== "review" && (
                    <button onClick={() => setTab("review")} title="A review written but not sent — it is kept until you send it">
                      <Chip text="draft review" tint="var(--primary)" />
                    </button>
                  )}
                  {d.viewerRequested && tab !== "review" && (
                    <Btn onClick={() => setTab("review")} primary small>Add your review</Btn>
                  )}
                </div>
              </div>

              {/* Prose on the left, metadata on the right — the arrangement
                  GitHub uses. There is no centred measure any more: capped at
                  1180 and centred, a wide window put a third of the panel of
                  empty gutter down the left-hand side while the description
                  wrapped early. The body fills what it is given (the 78ch
                  measure came out of MD_CSS for the same reason), so the
                  column starts at the left edge and the sidebar keeps the
                  right. Files/Checks/Commits already take the full width: a
                  diff and a check list want every pixel. */}
              <div className="flex-1 overflow-y-auto min-h-0 agx-scroll p-3"
                onScroll={(e) => {
                  // Hysteresis, not a threshold: a single line would flip the
                  // masthead open and shut on every pixel of a trackpad wobble,
                  // and it takes a row of the page with it each time.
                  const y = e.currentTarget.scrollTop;
                  setCondensed((was) => (was ? y > 24 : y > 72));
                }}>
                {(tab === "overview" || tab === "conversation") ? (
                  <div className="flex gap-4 items-start">
                    <div className="min-w-0 flex-1">
                      {tab === "overview" ? (
                        <Overview
                          d={d} busy={busy} openThreads={openThreads.length}
                          conversationCount={d.comments.length + d.reviews.length + d.threads.length}
                          onEditRequest={() => setEditingBody(true)}
                          onLocalReview={() => doLocalReview()} onMerge={doMerge} onClose={doClose}
                          onUpdateBranch={() => act("Update branch", () => api.prUpdateBranch(root, d.number))}
                          onRerun={() => act("Re-run checks", () => api.prRerun(root, d.number))}
                          onAutoMerge={() => act("Auto-merge", () => api.prMerge(root, d.number, "squash", { auto: true, deleteBranch: true }))}
                          onCancelAutoMerge={() => act("Auto-merge cancelled", () => api.prMerge(root, d.number, "squash", { disableAuto: true }))}
                          onDraft={() => act(d.isDraft ? "Mark ready" : "Convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                          onGoThreads={() => setTab("conversation")}
                        />
                      ) : (
                        <Conversation
                          d={d} lanes={lanes} raw={rawBots} onRaw={setRawBots} busy={busy} onComment={doComment}
                          onResolve={(t) => act(t.isResolved ? "Unresolve" : "Resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                          onReply={doReply}
                          onApply={doApplySuggestion}
                          onReact={doReact}
                        />
                      )}
                    </div>
                    <PrSidebar d={d} onEditField={fieldPicker.open} />
                  </div>
                ) : null}

                {tab === "commits" && (
                  <div className="text-[11px] flex flex-col gap-2">
                    {groupCommitsByDay(d.commits).map(([day, list]) => (
                      <div key={day}>
                        {/* Grouped by the day they landed, as GitHub does — a
                            long branch reads as a history rather than a list. */}
                        <div className="text-[10px] uppercase tracking-wider mb-1 pl-1" style={{ color: "var(--text3)" }}>{day}</div>
                        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
                          {list.map((c, i) => (
                            <div key={c.oid} style={i ? { borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" } : undefined}>
                              <button onClick={() => openCommit(selCommit === c.oid ? "" : c.oid)}
                                className="agx-btn w-full text-left flex items-center gap-2 px-2.5 py-2"
                                style={{
                                  opacity: c.isMerge ? 0.6 : 1,
                                  background: selCommit === c.oid ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent",
                                }}>
                                <span className="shrink-0 text-[9px]" style={{ color: "var(--text3)" }}>{selCommit === c.oid ? "▾" : "▸"}</span>
                                <span className="min-w-0 flex-1">
                                  {/* Subject only, in full. The rest of the
                                      message is behind the `…` button, exactly
                                      as GitHub does it: a long body should not
                                      push every other commit off the screen. */}
                                  <span className="block" style={{ color: "var(--text)" }}>
                                    {c.message}
                                    {c.body?.trim() && (
                                      <button
                                        onClick={(ev) => { ev.stopPropagation(); toggleMsg(c.oid); }}
                                        title={openMsgs.has(c.oid) ? "Hide the full message" : "Show the full commit message"}
                                        aria-expanded={openMsgs.has(c.oid)}
                                        className="agx-btn ml-1.5 align-middle text-[10px] px-1.5 rounded leading-none"
                                        style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>…</button>
                                    )}
                                  </span>
                                  {c.body?.trim() && openMsgs.has(c.oid) && (
                                    <span className="block mt-1.5 px-2 py-1.5 rounded text-[10.5px] whitespace-pre-wrap"
                                      style={{ ...CODE_FONT_STYLE, color: "var(--text2)", background: "color-mix(in srgb, var(--border) 14%, transparent)" }}>{c.body.trim()}</span>
                                  )}
                                  <span className="flex items-center gap-1.5 mt-0.5 text-[10px]" style={{ color: "var(--text3)" }}>
                                    {/* Everyone credited. A commit written with an
                                        agent says so here, exactly like GitHub. */}
                                    {(c.authors?.length ? c.authors : [c.author]).slice(0, 3).map((a) => (
                                      <Avatar key={a} login={a} size={14} />
                                    ))}
                                    <span className="truncate">{commitAuthorLine(c)}</span>
                                    {c.committedAt && <span>· {ago(c.committedAt)}</span>}
                                  </span>
                                </span>
                                {c.isMerge && <Chip text="merge" tint="var(--text3)" title="Trunk catch-up, not work to review" />}
                                {c.verified && <Chip text="verified" tint="var(--success)" title="Signature verified by GitHub" />}
                                {c.checks && (
                                  <span className="shrink-0 text-[11px]" title={`Checks on this commit: ${c.checks.toLowerCase()}`}
                                    style={{ color: c.checks === "SUCCESS" ? "var(--success)" : c.checks === "FAILURE" || c.checks === "ERROR" ? "var(--error)" : "var(--warning)" }}>
                                    {c.checks === "SUCCESS" ? "✓" : c.checks === "FAILURE" || c.checks === "ERROR" ? "✕" : "•"}
                                  </span>
                                )}
                                <span className="tabular-nums shrink-0 px-1.5 py-0.5 rounded" style={{ ...CODE_FONT_STYLE, fontSize: "10px", color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>{c.short}</span>
                              </button>
                              {selCommit === c.oid && (
                                <div className="my-2">
                                  {commitBusy ? <Loading label="Loading the diff…" size={18} />
                                    : commitFiles.length === 0 ? <div className="text-[10.5px] p-2" style={{ color: "var(--text3)" }}>This commit changed nothing textual</div>
                                    : <FileStack files={commitFiles} split={split} wrap={wrap} onSplit={setSplit} onWrap={setWrap} />}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {d.truncated?.commits && (
                      <div className="text-[10px] px-1" style={{ color: "var(--warning)" }}>
                        Showing the most recent {d.truncated.commits} commits — GitHub caps a page at that.
                      </div>
                    )}
                  </div>
                )}

                {tab === "files" && (
                  <FilesTab
                    d={d} root={root} byPath={byPath} loaded={!!diff} seenFiles={seenFiles} onSeen={toggleSeen}
                    sel={selFile} onSel={setSelFile} split={split} wrap={wrap} onSplit={setSplit} onWrap={setWrap}
                    drafts={myDrafts} onAddDraft={addDraft} onPostOne={postOneComment} onDropDraft={dropDraftItem}
                    onPeek={async (p) => {
                      // The pull request's copy, not the checkout's. A branch
                      // you do not have out means the path is either missing or
                      // a different version of itself, and opening that under
                      // this file's name is the quiet kind of wrong.
                      const r = await api.prFileTemp(root, d.number, p);
                      if (!r.ok || !r.file) { flash(false, r.error || "Could not fetch that file from GitHub"); return; }
                      setPeek({ root, path: r.file, label: `${p} · #${d.number} @ ${r.sha?.slice(0, 7)} · read-only` });
                    }}
                    busy={busy} onReply={doReply}
                    onApply={doApplySuggestion}
                    onResolve={(t) => act(t.isResolved ? "Unresolve" : "Resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                  />
                )}

                {tab === "checks" && (
                  <Checks
                    d={d} root={root} jobs={jobs} busy={busy}
                    onRerun={() => act("Re-run checks", () => api.prRerun(root, d.number))}
                    onRerunJobs={(what, id) => act("Re-run", () => api.prRerunJobs(root, what, id))}
                    onAsk={onOpenChatWith ? (k) => askClaudeAboutCheck(k) : undefined}
                  />
                )}

                {tab === "review" && canReview && (
                  <ReviewTab
                    d={d} drafts={myDrafts} seen={seenFiles.length} busy={busy}
                    draft={myReview} onDraft={setMyReview}
                    onDrop={dropDraft} onSubmit={submitReview} onGoFiles={() => setTab("files")}
                  />
                )}
              </div>

            </>
          )}
        </div>
        )}
      </div>
      {peek && <PeekFile peek={peek} onClose={() => setPeek(null)} />}
      {dialog}
    </div>
    </MentionCtx.Provider>
    </RepoCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

export type MergeMethod = "squash" | "merge" | "rebase";
const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash & merge",
  merge: "Merge commit",
  rebase: "Rebase & merge",
};

const MERGE_WHY: Record<string, string> = {
  BLOCKED: "A required review or check has not passed",
  BEHIND: "The base branch has moved — update the branch first",
  DIRTY: "There are conflicts with the base branch",
  UNSTABLE: "A check is failing",
  DRAFT: "This is a draft",
  HAS_HOOKS: "A repository hook is blocking the merge",
  UNKNOWN: "GitHub has not finished working it out",
};

function Overview({ d, busy, openThreads, conversationCount, onLocalReview, onMerge, onClose, onUpdateBranch, onRerun, onAutoMerge, onCancelAutoMerge, onDraft, onGoThreads, onEditRequest }: {
  d: PrDetail; busy: boolean; openThreads: number; conversationCount: number;
  onLocalReview: () => void; onMerge: (method: MergeMethod) => void; onClose: () => void; onUpdateBranch: () => void;
  onRerun: () => void; onAutoMerge: () => void; onCancelAutoMerge: () => void; onDraft: () => void; onGoThreads: () => void;
  onEditRequest: () => void;
}) {
  const c = d.checks;
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const canMerge = d.mergeState === "CLEAN";

  return (
    <div className="flex flex-col gap-3">
      {d.forcePushedSinceReview && (
        <div className="text-[10.5px] px-2.5 py-2 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          The author force-pushed after the last review — that review was for code that is no longer here.
        </div>
      )}

      {/* Merged and closed pull requests are history: there is nothing to merge,
          no branch to update, and no draft to go back to. Offering those buttons
          was not just clutter, it was a lie — "Merging is blocked, GitHub has
          not finished working it out" on a pull request that merged an hour ago.
          What is left is what GitHub leaves: what happened, and reopen. */}
      {d.state !== "OPEN" ? (
        <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          <div className="flex gap-2.5 items-start p-3">
            <span className="shrink-0 rounded-full flex items-center justify-center text-[13px]"
              style={{ width: 26, height: 26, background: d.state === "MERGED" ? "var(--primary)" : "color-mix(in srgb, var(--text3) 60%, transparent)", color: "var(--bg)" }}>
              {d.state === "MERGED" ? "⏣" : "⊘"}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
                {d.state === "MERGED" ? "Merged" : "Closed without merging"}
              </span>
              <span className="block text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>
                {d.state === "MERGED"
                  ? `${d.mergedBy ? `${d.mergedBy} merged ` : "Merged "}into ${d.baseRefName}${d.mergedAt ? ` ${ago(d.mergedAt)}` : ""}`
                  : `This branch was never merged into ${d.baseRefName}${d.closedAt ? ` · closed ${ago(d.closedAt)}` : ""}`}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap px-3 py-2.5"
            style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
            {d.state === "CLOSED" && <Btn onClick={onClose} disabled={busy} title="Put it back to open, with its comments and reviews intact">↺ Reopen</Btn>}
            <a href={externalUrl(d.url)} target="_blank" rel="noreferrer noopener" className="text-[10.5px] px-2.5 py-1 rounded"
              style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Open on GitHub ↗</a>
          </div>
        </section>
      ) : (
      <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
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

        <div style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
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
          style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
          {/* All three methods GitHub offers, not just squash. Which one a repo
              wants is a real decision — a release branch is merged, a tidy
              feature is squashed — and hard-coding squash made the other two
              unreachable even though the server supported them all along. */}
          <span className="flex items-center rounded overflow-hidden shrink-0" style={{ border: "1px solid var(--primary)" }}>
            <button onClick={() => onMerge(mergeMethod)} disabled={busy || !canMerge}
              title={canMerge ? `${MERGE_LABEL[mergeMethod]} and delete the branch` : MERGE_WHY[d.mergeState]}
              className="agx-btn text-[10.5px] px-2.5 py-1 disabled:opacity-40"
              style={{ background: "var(--primary)", color: "var(--bg)", fontWeight: 500 }}>
              {MERGE_LABEL[mergeMethod]}
            </button>
            <Select
              value={mergeMethod}
              onChange={(v: string) => setMergeMethod(v as MergeMethod)}
              options={[
                { value: "squash", label: "Squash and merge", hint: "one commit" },
                { value: "merge", label: "Create a merge commit", hint: "keeps every commit" },
                { value: "rebase", label: "Rebase and merge", hint: "no merge commit" },
              ]}
              title="Merge method"
              align="right"
              className="text-[10.5px] px-1.5 py-1 outline-none"
              style={{ background: "var(--primary)", color: "var(--bg)", borderLeft: "1px solid color-mix(in srgb, var(--bg) 35%, transparent)" }}
              placeholder=""
            />
          </span>
          {d.autoMerge
            ? <Btn onClick={onCancelAutoMerge} disabled={busy} warn title={`Armed by ${d.autoMerge.enabledBy}`}>Cancel auto-merge</Btn>
            : <Btn onClick={onAutoMerge} disabled={busy} title="Merge automatically once everything passes">Merge when green</Btn>}
          {/* Only when the branch is genuinely BEHIND its base. Rendered
              unconditionally, this amber button read as "you must sync" even
              right after a sync — GitHub recomputes through UNKNOWN and lands on
              BLOCKED (a locked branch, pending checks), never back to BEHIND, so
              the state it was reacting to was gone. GitHub itself offers it only
              when behind. Gated on viewerCanUpdate too (undefined = allow): a
              branch you cannot write to should not offer an action that only
              comes back "cannot change this locked branch". */}
          {d.mergeState === "BEHIND" && d.viewerCanUpdate !== false && (
            <Btn onClick={onUpdateBranch} disabled={busy} warn title="Merge the base branch into this one — this updates the branch on GitHub">↻ Update branch</Btn>
          )}
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy}>Re-run failed</Btn>}
          <span className="ml-auto flex gap-1.5">
            <Btn onClick={onDraft} disabled={busy} small>{d.isDraft ? "Mark ready" : "To draft"}</Btn>
            <Btn onClick={onClose} disabled={busy} danger small>Close</Btn>
          </span>
        </div>
      </section>
      )}

      <Description d={d} busy={busy} onEdit={onEditRequest} />

      <div className="flex gap-1.5 flex-wrap items-center">
        <Btn onClick={onLocalReview} disabled={busy} primary title="Open a chat with the review prompt ready. Reads only: no checkout, nothing written to this repository">Review with Claude</Btn>
        <a href={externalUrl(d.url)} target="_blank" rel="noreferrer noopener" className="text-[10.5px] px-2.5 py-1 rounded"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Open on GitHub ↗</a>
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
function Description({ d, busy, onEdit }: { d: PrDetail; busy: boolean; onEdit: () => void }) {
  return (
    <section className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>description</span>
        {/* Opening the editor is the shell's to do — it takes the whole column,
            so the click has to leave this box entirely. */}
        <span className="ml-auto"><Btn onClick={onEdit} disabled={busy} small>✎ Edit</Btn></span>
      </div>
      <div className="p-3">
        {/* No checklist meter. The boxes are right there, ticked or not, three
            lines below — a bar counting them said nothing the list did not, and
            it said it above the description, where the description should be. */}
        {d.body.trim() ? <Md body={d.body} /> : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No description.</div>}
      </div>
    </section>
  );
}

/** One toolbar key. `onMouseDown`-preventDefault is the whole trick: a plain
 *  click would blur the textarea first, wiping the selection the transform
 *  needs — so the button never takes focus, and the caret stays where it was. */
function TB({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="agx-btn rounded flex items-center justify-center text-[11px] w-7 h-7 shrink-0"
      style={{ color: "var(--text2)" }}>
      {children}
    </button>
  );
}
function TBSep() {
  return <span className="mx-1 h-4 w-px shrink-0" style={{ background: "color-mix(in srgb, var(--text) 14%, transparent)" }} />;
}

/**
 * The description editor, full-column. A GitHub-style formatting toolbar, and a
 * textarea that fills every pixel of height it is handed and cannot be dragged
 * bigger or smaller — the height belongs to the column, not to a resize grip.
 * Write/Preview and Cancel/Save stay pinned however long the body runs.
 *
 * Images still cannot be uploaded (GitHub has no public attachment API), so the
 * paperclip says so and offers the one thing that works — the same call the
 * comment composer makes.
 */
function BodyEditor({ prNumber, initial, busy, onSave, onCancel, onOpenGithub }: {
  prNumber: number; initial: string; busy: boolean;
  onSave: (body: string) => Promise<boolean>; onCancel: () => void; onOpenGithub: () => void;
}) {
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== initial;

  const save = async () => {
    if (!dirty) { onCancel(); return; }
    setSaving(true);
    // The parent flips edit-mode off when this resolves true; on false we stay
    // put with the text intact so nothing typed is lost to a failed save.
    await onSave(text);
    setSaving(false);
  };

  /** Every toolbar button ends here: read the selection, transform it, write it
   *  back, then re-select so you can keep typing. Without the reselect the caret
   *  jumps to the end and the toolbar is a one-click-only affair. */
  const edit = (fn: (sel: string, start: number, end: number) => { text: string; start: number; end: number }) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const r = fn(text.slice(s, e), s, e);
    setText(r.text);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.start, r.end); });
  };

  const wrap = (mark: string, ph = "text") => edit((sel, s, e) => {
    const body = sel || ph;
    const out = text.slice(0, s) + mark + body + mark + text.slice(e);
    const start = s + mark.length;
    return { text: out, start, end: start + body.length };
  });

  const code = () => edit((sel, s, e) => {
    const before = text.slice(0, s), after = text.slice(e);
    if (sel.includes("\n") || sel === "") {
      const body = sel || "code";
      const out = before + "```\n" + body + "\n```" + after;
      const start = before.length + 4;
      return { text: out, start, end: start + body.length };
    }
    const out = before + "`" + sel + "`" + after;
    return { text: out, start: s + 1, end: s + 1 + sel.length };
  });

  const link = () => edit((sel, s, e) => {
    const label = sel || "text";
    const out = text.slice(0, s) + "[" + label + "](url)" + text.slice(e);
    const start = s + 1 + label.length + 2; // caret lands on `url`
    return { text: out, start, end: start + 3 };
  });

  /** Line-prefix tools (headings, quote, lists). A toggle: if every touched
   *  line already carries its prefix, strip it — same as GitHub's toolbar. */
  const prefixLines = (mark: (i: number) => string) => edit((sel, s, e) => {
    const startOfLine = text.lastIndexOf("\n", s - 1) + 1;
    const head = text.slice(0, startOfLine);
    const block = text.slice(startOfLine, e);
    const after = text.slice(e);
    const lines = block.split("\n");
    const marks = lines.map((_, i) => mark(i));
    const on = lines.every((l, i) => l.startsWith(marks[i]));
    const out = lines.map((l, i) => on ? l.slice(marks[i].length) : marks[i] + l).join("\n");
    return { text: head + out + after, start: startOfLine, end: startOfLine + out.length };
  });

  const mention = () => edit((sel, s, e) => {
    const out = text.slice(0, s) + "@" + sel + text.slice(e);
    return { text: out, start: s + 1, end: s + 1 + sel.length };
  });

  // Drag/paste: a text file drops in as a fenced block; an image cannot (no
  // public GitHub upload API), so it says so and points at GitHub — same shape
  // as the comment composer, and as the paperclip below.
  const TEXTY = /\.(md|txt|log|json|jsonc|ya?ml|toml|ini|csv|tsv|diff|patch|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|cs|sh|bash|zsh|sql|html?|css|scss|xml)$/i;
  const takeFiles = async (files: File[]) => {
    if (!files.length) return;
    const img = files.find((f) => f.type.startsWith("image/"));
    if (img) { setAttachNote(img.name); return; }
    const parts: string[] = [];
    for (const f of files.slice(0, 4)) {
      if (!TEXTY.test(f.name) && !f.type.startsWith("text/")) continue;
      const lang = (f.name.split(".").pop() ?? "").toLowerCase();
      parts.push(`**${f.name}**\n\n\`\`\`${lang}\n${(await f.text()).slice(0, 60_000)}\n\`\`\``);
    }
    if (parts.length) setText((t) => (t ? t + "\n\n" : "") + parts.join("\n\n"));
  };

  return (
    <div className="flex flex-col h-full min-h-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void takeFiles([...e.dataTransfer.files]); }}
      onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); void takeFiles(fs); } }}>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>Editing description</span>
        <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>· #{prNumber}</span>
        {dirty && <span className="text-[8.5px] uppercase tracking-[.13em]" style={{ color: "var(--warning)" }}>unsaved</span>}
        <span className="ml-auto flex gap-1">
          <Btn onClick={() => setPreview(false)} small primary={!preview}>Write</Btn>
          <Btn onClick={() => setPreview(true)} small primary={preview}>Preview</Btn>
        </span>
      </div>

      {!preview && (
        <div className="flex items-center gap-0.5 px-2 py-1 shrink-0 flex-wrap"
          style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <TB title="Heading" onClick={() => prefixLines(() => "### ")}>H</TB>
          <TB title="Bold" onClick={() => wrap("**")}><b>B</b></TB>
          <TB title="Italic" onClick={() => wrap("_")}><i>I</i></TB>
          <TBSep />
          <TB title="Quote" onClick={() => prefixLines(() => "> ")}>&ldquo;</TB>
          <TB title="Code" onClick={code}>&lt;/&gt;</TB>
          <TB title="Link" onClick={link}>🔗</TB>
          <TBSep />
          <TB title="Numbered list" onClick={() => prefixLines((i) => `${i + 1}. `)}>1.</TB>
          <TB title="Bulleted list" onClick={() => prefixLines(() => "- ")}>•</TB>
          <TB title="Task list" onClick={() => prefixLines(() => "- [ ] ")}>☑</TB>
          <TBSep />
          <TB title="Attach an image" onClick={() => setAttachNote("An image")}>📎</TB>
          <TB title="Mention" onClick={mention}>@</TB>
        </div>
      )}

      {attachNote && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[10.5px] shrink-0"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <span className="min-w-0 truncate"><b>{attachNote}</b> can't be attached from here — GitHub has no public upload API for attachments.</span>
          <button onClick={onOpenGithub} className="agx-btn ml-auto shrink-0 px-2 py-0.5 rounded"
            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>Attach on GitHub ↗</button>
          <button onClick={() => setAttachNote(null)} className="agx-btn shrink-0 px-1" style={{ color: "var(--text3)" }} aria-label="Dismiss">×</button>
        </div>
      )}

      {preview ? (
        <div className="flex-1 min-h-0 overflow-y-auto agx-scroll p-3">
          {text.trim() ? <Md body={text} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }}
          className="flex-1 min-h-0 w-full p-3 text-[12px] outline-none resize-none agx-scroll"
          style={{ ...CODE_FONT_STYLE, background: "transparent", color: "var(--text2)", lineHeight: 1.6 }}
        />
      )}

      <div className="flex items-center gap-1.5 px-3 py-2 shrink-0"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>Markdown · ⌘↵ save · Esc cancel</span>
        <span className="ml-auto flex gap-1.5">
          <Btn onClick={onCancel} disabled={saving} small>Cancel</Btn>
          <Btn onClick={save} disabled={saving || busy || !dirty} primary small>{saving ? "Saving…" : "Save"}</Btn>
        </span>
      </div>
    </div>
  );
}

/**
 * A dropdown that closes on an outside click, on Escape, and on choosing
 * something. All three, because a menu that only closes one of those ways is
 * the kind of thing you only notice when it is stuck open over the diff.
 */
function Menu({ label, title, children, align = "right", primary }: {
  label: string; title?: string; children: (close: () => void) => React.ReactNode; align?: "left" | "right";
  /** For a menu that is an action rather than an overflow — it has to read as
   *  the thing you came here to press, not as a place other things are kept. */
  primary?: boolean;
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
      <Btn onClick={() => setOpen((v) => !v)} title={title} small primary={primary}>{label}</Btn>
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
/**
 * The right-hand column, as GitHub has it.
 *
 * Two things at once. It carries the metadata that had nowhere to live —
 * reviewers, assignees, labels, milestone, the issues this closes, who is
 * taking part — and it occupies the space to the right of the prose, which is
 * the reason the reading column can be a fixed, comfortable width instead of
 * stretching to the window and leaving half the panel empty.
 */
function SidebarSection({ title, onEdit, children }: { title: string; onEdit?: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <div className="py-2.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>{title}</span>
        {onEdit && (
          <button onClick={onEdit} title={`Edit ${title.toLowerCase()}`} aria-label={`Edit ${title.toLowerCase()}`}
            className="agx-btn ml-auto text-[10px] px-1 rounded hover:bg-white/5" style={{ color: "var(--text3)" }}>✎</button>
        )}
      </div>
      {children}
    </div>
  );
}

/** Reviewers and assignees are both lists of people. Only a reviewer can be a
 *  team, so an assignee is one with nothing to flag. */
function SidebarPeople({ people, empty }: { people: PrReviewer[]; empty: string }) {
  if (!people.length) return <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{empty}</span>;
  return (
    <div className="flex flex-col gap-1">
      {people.map((p) => (
        <span key={p.login} className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text2)" }}>
          <ReviewerFace r={p} size={16} />{p.login}
        </span>
      ))}
    </div>
  );
}

type PickOption = { value: string; label: string; sub?: string; color?: string; avatar?: string };

/**
 * A GitHub-style chooser: a filter box over a list you tick, instead of a
 * comma-separated line you have to type logins into from memory. The options
 * are the repository's own — `api.prFacets` (labels, assignees, milestones) and
 * `api.prMentions` (collaborators, for reviewers), both cached server-side — so
 * the list is the real set, not whoever happened to appear on the page.
 *
 * Rendered through a Portal and positioned `fixed` under its trigger: the
 * sidebar it opens from scrolls and is only 248px wide, so an absolutely-placed
 * menu would be clipped. Multi-select commits the diff once, when it closes —
 * the way GitHub's label menu does — so ticking four labels is one write, not
 * four. Single-select (milestone) commits on the click.
 */
function FieldPicker({ anchor, title, hint, multi, loading, options, selected, onCommit, onClose }: {
  anchor: DOMRect; title: string; hint: string; multi: boolean; loading: boolean;
  options: PickOption[]; selected: string[];
  onCommit: (next: string[]) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState<string[]>(selected);
  const [q, setQ] = useState("");
  const selRef = useRef(sel); selRef.current = sel;
  const box = useRef<HTMLDivElement>(null);

  const commitClose = useCallback(() => { onCommit(selRef.current); onClose(); }, [onCommit, onClose]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) commitClose(); };
    // Escape abandons without writing; an outside click or a resize commits, so
    // the change you made by ticking is not silently lost by looking away.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", commitClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", commitClose);
    };
  }, [commitClose, onClose]);

  const toggle = (v: string) => {
    if (!multi) { onCommit([v]); onClose(); return; }
    setSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);
  };

  const t = q.trim().toLowerCase();
  const shown = t ? options.filter((o) => o.label.toLowerCase().includes(t) || o.value.toLowerCase().includes(t) || !!o.sub?.toLowerCase().includes(t)) : options;

  const W = 300;
  const left = Math.round(Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8)));
  const top = Math.round(Math.min(anchor.bottom + 6, window.innerHeight - 140));
  const maxH = Math.max(200, window.innerHeight - top - 12);

  return (
    <Portal>
      <div ref={box} className="fixed rounded-lg overflow-hidden flex flex-col"
        style={{ left, top, width: W, maxHeight: maxH, border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", background: "color-mix(in srgb, var(--bg2) 98%, black)", boxShadow: "0 18px 44px -18px rgba(0,0,0,.8)" }}>
        <div className="px-3 pt-2 pb-1.5 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <div className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>{title}</div>
          <div className="text-[10px]" style={{ color: "var(--text3)" }}>{hint}</div>
        </div>
        <div className="p-1.5 shrink-0">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
            className="w-full px-2 py-1 rounded text-[11px] outline-none"
            style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }} />
        </div>
        <div className="overflow-y-auto agx-scroll flex-1 min-h-0 pb-1">
          {loading ? (
            <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text3)" }}>Loading…</div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text3)" }}>No matches.</div>
          ) : shown.map((o) => {
            const on = sel.includes(o.value);
            return (
              <button key={o.value || "∅"} onClick={() => toggle(o.value)}
                className="agx-mi w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
                style={{ color: "var(--text2)" }}>
                <span className="w-3.5 shrink-0 text-center" style={{ color: on ? "var(--primary)" : "transparent" }}>✓</span>
                {o.color != null && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${o.color}` }} />}
                {o.avatar != null && <Avatar login={o.avatar} size={16} />}
                <span className="truncate">{o.label}</span>
                {o.sub && <span className="truncate text-[10px] shrink-0 ml-auto" style={{ color: "var(--text3)" }}>{o.sub}</span>}
              </button>
            );
          })}
        </div>
        {multi && (
          <div className="p-1.5 shrink-0 flex" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
            <button onClick={commitClose} className="agx-btn ml-auto px-2.5 py-1 rounded text-[10.5px]"
              style={{ background: "var(--primary)", color: "var(--bg)" }}>Done</button>
          </div>
        )}
      </div>
    </Portal>
  );
}

type Facets = { authors: string[]; assignees: string[]; labels: { name: string; color: string }[]; milestones: string[]; bases: string[] };
type Mentions = { users: string[]; issues: { number: number; title: string }[] };
type SidebarField = "reviewers" | "assignees" | "labels" | "milestone";

type PrAct = (label: string, fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => Promise<boolean>;

/**
 * One picker for the whole pull request, shared by the masthead's inline "＋"
 * buttons and the sidebar's ✎ — lifted here because the masthead shows on every
 * tab while the sidebar only shows on two, so a picker owned by the sidebar
 * could not open from the masthead on the Files tab.
 *
 * Returns `open(field, event)` for a trigger to call and the picker `node` to
 * render once. The options are fetched lazily the first time any picker opens
 * (both endpoints are cached server-side, so the second open is instant), and
 * each write goes through the same add/remove endpoints, diffed against what
 * the PR has now.
 */
function usePrFieldPicker(d: PrDetail | null, root: string, act: PrAct) {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [mentions, setMentions] = useState<Mentions | null>(null);
  const [loading, setLoading] = useState(false);
  const [picker, setPicker] = useState<{ field: SidebarField; anchor: DOMRect } | null>(null);

  const ensureOptions = useCallback(async () => {
    if (facets && mentions) return;
    setLoading(true);
    const [f, m] = await Promise.all([api.prFacets(root), api.prMentions(root)]);
    if (f.ok && f.data) setFacets(f.data);
    if (m.ok && m.data) setMentions(m.data);
    setLoading(false);
  }, [root, facets, mentions]);

  const open = useCallback((field: SidebarField, e: React.MouseEvent<HTMLButtonElement>) => {
    setPicker({ field, anchor: e.currentTarget.getBoundingClientRect() });
    void ensureOptions();
  }, [ensureOptions]);
  const close = () => setPicker(null);

  // The picker holds its selection locally and hands back the final set; here
  // we diff it against what the PR has now and write just the delta — the shape
  // the endpoints already take.
  const commit = (was: string[], label: string, fn: (add: string[], remove: string[]) => Promise<{ ok: boolean; error?: string; detail?: string }>) => (next: string[]) => {
    const add = next.filter((x) => !was.includes(x));
    const remove = was.filter((x) => !next.includes(x));
    if (add.length || remove.length) void act(label, () => fn(add, remove));
  };

  let node: React.ReactNode = null;
  if (picker && d) {
    const a = picker.anchor;
    if (picker.field === "labels") {
      const was = d.labels.map((l) => l.name);
      node = <FieldPicker anchor={a} title="Apply labels" hint="Tick to add or remove" multi loading={loading}
        options={(facets?.labels ?? []).map((l) => ({ value: l.name, label: l.name, color: l.color }))}
        selected={was} onClose={close} onCommit={commit(was, "Labels", (add, remove) => api.prLabels(root, d.number, add, remove))} />;
    } else if (picker.field === "reviewers") {
      const was = d.reviewers.map((r) => r.login);
      node = <FieldPicker anchor={a} title="Request reviewers" hint="Collaborators on this repository" multi loading={loading}
        options={(mentions?.users ?? []).map((u) => ({ value: u, label: u, avatar: u }))}
        selected={was} onClose={close} onCommit={commit(was, "Reviewers", (add, remove) => api.prReviewers(root, d.number, add, remove))} />;
    } else if (picker.field === "assignees") {
      const was = d.assignees;
      node = <FieldPicker anchor={a} title="Assign people" hint="Up to 10 assignees" multi loading={loading}
        options={(facets?.assignees ?? []).map((u) => ({ value: u, label: u, avatar: u }))}
        selected={was} onClose={close} onCommit={commit(was, "Assignees", (add, remove) => api.prAssignees(root, d.number, add, remove))} />;
    } else {
      // Milestone is one-of, not many: picking commits at once, and a leading
      // "No milestone" entry clears it — passing "" to the endpoint, exactly as
      // the old free-text dialog did.
      const was = d.milestone ? [d.milestone] : [""];
      node = <FieldPicker anchor={a} title="Set milestone" hint="Choose one, or clear it" multi={false} loading={loading}
        options={[{ value: "", label: "No milestone" }, ...(facets?.milestones ?? []).map((m) => ({ value: m, label: m }))]}
        selected={was} onClose={close}
        onCommit={(next) => { const title = next[0] ?? ""; if (title !== (d.milestone ?? "")) void act("Milestone", () => api.prMilestone(root, d.number, title)); }} />;
    }
  }

  return { open, node };
}

function PrSidebar({ d, onEditField }: {
  d: PrDetail;
  onEditField: (field: SidebarField, e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    /**
     * Pinned, because it is reference rather than reading.
     *
     * Who is reviewing this, what it is labelled, which milestone it is in —
     * these are the things you look up *while* reading the description, and
     * they were scrolling away with it. On a PR whose body runs to several
     * screens (this app's own do) they were gone by the second one, and the way
     * back was to scroll to the top and lose your place in the prose.
     *
     * `items-start` on the row is what makes this work: a stretched flex child
     * is already as tall as the column beside it, and an element that fills its
     * container has nothing to stick within. The tab strip is a sibling ABOVE
     * the scroll container rather than inside it, so `top-0` is the top of the
     * scrollport and nothing overlaps.
     *
     * The height cap and its scrollbar are a safety valve, not the usual case:
     * five short sections fit anywhere, but a PR with thirty reviewers must not
     * pin a list whose bottom cannot then be reached.
     */
    <aside className="sticky top-0 shrink-0 w-[248px] pl-4 hidden lg:block overflow-y-auto agx-scroll overscroll-contain"
      style={{ borderLeft: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", maxHeight: "calc(100vh - 6rem)" }}>
      <SidebarSection title="Reviewers" onEdit={(e) => onEditField("reviewers", e)}>
        <SidebarPeople people={d.reviewers} empty="No reviewers" />
      </SidebarSection>
      <SidebarSection title="Assignees" onEdit={(e) => onEditField("assignees", e)}>
        <SidebarPeople people={d.assignees.map((login) => ({ login }))} empty="No one assigned" />
      </SidebarSection>
      <SidebarSection title="Labels" onEdit={(e) => onEditField("labels", e)}>
        {d.labels.length
          ? <div className="flex flex-wrap gap-1">{d.labels.map((l) => <Chip key={l.name} text={l.name} tint={l.color ? `#${l.color}` : "var(--primary)"} />)}</div>
          : <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>None yet</span>}
      </SidebarSection>
      <SidebarSection title="Milestone" onEdit={(e) => onEditField("milestone", e)}>
        <span className="text-[11px]" style={{ color: d.milestone ? "var(--text2)" : "var(--text3)" }}>{d.milestone || "No milestone"}</span>
      </SidebarSection>
      {d.linkedIssues.length > 0 && (
        <SidebarSection title="Development">
          <div className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: "var(--text3)" }}>Merging this closes:</span>
            {d.linkedIssues.map((i) => (
              <a key={i.number} href={externalUrl(i.url)} target="_blank" rel="noreferrer noopener"
                className="text-[11px] truncate" style={{ color: "var(--primary)" }} title={i.title}>#{i.number} {i.title}</a>
            ))}
          </div>
        </SidebarSection>
      )}
      {d.participants.length > 0 && (
        <SidebarSection title={`${d.participants.length} participant${d.participants.length === 1 ? "" : "s"}`}>
          <div className="flex flex-wrap gap-1">
            {d.participants.map((p) => <span key={p} title={p}><Avatar login={p} size={20} /></span>)}
          </div>
        </SidebarSection>
      )}
      {d.autoMerge && (
        <SidebarSection title="Auto-merge">
          <span className="text-[10.5px]" style={{ color: "var(--warning)" }}>
            Armed by {d.autoMerge.enabledBy} ({d.autoMerge.method.toLowerCase()})
          </span>
        </SidebarSection>
      )}
    </aside>
  );
}

/**
 * How a pull request's own state looks: colour, word and glyph.
 *
 * Merged is purple, closed is grey, draft is grey, open is green — GitHub's
 * palette, because everyone already reads it. A closed pull request wearing the
 * green of a passing build (which is what tinting by check verdict did) says
 * exactly the wrong thing.
 */
function prStateBadge(d: { state: PrSummary["state"]; isDraft: boolean }): { tint: string; state: string; glyph: string } {
  if (d.state === "MERGED") return { tint: "var(--primary)", state: "Merged", glyph: "⏣" };
  if (d.state === "CLOSED") return { tint: "var(--text3)", state: "Closed", glyph: "⊘" };
  if (d.isDraft) return { tint: "var(--text3)", state: "Draft", glyph: "◌" };
  return { tint: "var(--success)", state: "Open", glyph: "◉" };
}

function Masthead({ d, busy, onEditTitle, onDraft, onClose, onLocalReview, onReviewInTerminal, onLabels, onReviewers, onCopyLink, onEditField, condensed }: {
  d: PrDetail; busy: boolean;
  onEditTitle: () => void; onDraft: () => void; onClose: () => void; onLocalReview: () => void;
  /** Absent when the workspace has no terminal to send it to. */
  onReviewInTerminal?: () => void;
  /** Scrolled past the top: the metadata folds away and the title stays. */
  condensed?: boolean;
  /** The typed dialog behind the overflow menu; the inline ＋ buttons use the
   *  picker instead. */
  onLabels: () => void; onReviewers: () => void; onCopyLink: () => void;
  /** Opens the shared reviewer/label picker anchored to the clicked ＋. */
  onEditField: (field: SidebarField, e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  // The PR's own state, which is not the same thing as its check verdict —
  // colouring a merged pull request by whether CI went green says nothing about
  // it being merged. GitHub's palette: open green, merged purple, closed grey,
  // draft grey; each with its own glyph so the state reads without the word.
  const { tint, state, glyph } = prStateBadge(d);
  const [copied, setCopied] = useState(false);
  const copyNumber = () => {
    navigator.clipboard?.writeText(`#${d.number}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
      .catch(() => { /* no clipboard permission */ });
  };
  return (
    <div className="px-3 pt-2.5 pb-2 shrink-0" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-[9.5px] px-1.5 py-0.5 rounded-full align-middle inline-flex items-center gap-1"
            style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>
            <span aria-hidden>{glyph}</span>{state}
          </span>
          <span className="text-[14px] leading-snug ml-2" style={{ color: "var(--text)" }}>
            {/* A button, not just text: clicking copies "#NNNNN" to paste as a
                cross-reference, and it looks pressable so that is discoverable. */}
            <button onClick={copyNumber} aria-live="polite"
              title={copied ? "Copied!" : `Copy #${d.number}`}
              className="agx-btn tabular-nums align-middle inline-flex items-center gap-1 mr-1.5 px-1.5 py-0.5 rounded-md text-[12px]"
              style={{ color: copied ? "var(--success)" : "var(--text2)", border: `1px solid color-mix(in srgb, ${copied ? "var(--success) 50%" : "var(--border) 55%"}, transparent)`, background: "color-mix(in srgb, var(--border) 14%, transparent)" }}>
              #{d.number}
              <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>{copied ? "✓" : "⧉"}</span>
            </button>
            {d.title}
          </span>
        </div>
        {/* Out of the menu and onto the masthead. This is the one action here
            that is the reason the panel exists — handing a pull request to an
            agent instead of to a browser tab — and it was three clicks deep
            behind a ⋯ that also holds "Close pull request". Beside the menu
            rather than inside it. */}
        {/* Two places the same review can happen, and they are not a setting:
            the chat renders from the transcript and keeps the pane out of
            sight, the terminal gives you the session itself, attached, in a tab
            beside your shells. Which one you want depends on whether you intend
            to watch or to join in. */}
        <Menu label="✦ Review with Claude ▾" title="Review this pull request" primary>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); onLocalReview(); }}>💬 In the chat</MenuItem>
              {onReviewInTerminal && (
                <MenuItem onClick={() => { close(); onReviewInTerminal(); }}>▸_ In a terminal tab</MenuItem>
              )}
            </>
          )}
        </Menu>
        <Menu label="⋯" title="More actions">
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); onEditTitle(); }}>✎ Edit title</MenuItem>
              {/* Requesting a review or flipping the draft flag are things you do
                  to a pull request that is still going. On a merged one GitHub
                  does not offer them either. */}
              {d.state === "OPEN" && <>
                <MenuItem onClick={() => { close(); onReviewers(); }}>◍ Request a review</MenuItem>
                <MenuItem onClick={() => { close(); onDraft(); }}>◌ {d.isDraft ? "Mark ready for review" : "Convert to draft"}</MenuItem>
              </>}
              <MenuItem onClick={() => { close(); onLabels(); }}>⌗ Edit labels</MenuItem>
              <MenuSep />
              <MenuItem onClick={() => { close(); onCopyLink(); }}>🔗 Copy link</MenuItem>
              <MenuItem onClick={() => { close(); openExternal(d.url); }}>↗ Open on GitHub</MenuItem>
              {d.state !== "MERGED" && <>
                <MenuSep />
                <MenuItem onClick={() => { close(); onClose(); }} danger={d.state !== "CLOSED"}>
                  {d.state === "CLOSED" ? "↺ Reopen pull request" : "✕ Close pull request"}
                </MenuItem>
              </>}
            </>
          )}
        </Menu>
      </div>

      {/* Packed left and wrapping, not stretched to fill: six fields spread
          across a wide pane put Milestone a screen away from Author, and the
          eye has to travel the whole width to read one header.

          Folded away once you start reading. Author, branch, reviewers and the
          rest answer questions you ask on arrival, not questions you ask while
          scrolling a diff — and they were taking a fifth of the window to keep
          answering them. The title, the number and the state stay, because
          those are what tell you which pull request you are still in. */}
      {!condensed && (
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
            : d.reviewers.map((r) => <span key={r.login} className="flex items-center gap-1"><ReviewerFace r={r} size={14} />{r.login}</span>)}
          <button onClick={(e) => onEditField("reviewers", e)} disabled={busy} title="Request a review" className="agx-inline-add">＋</button>
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
      )}

      {!condensed && (
      <div className="flex gap-1 flex-wrap mt-2.5 items-center">
        {d.labels.map((l) => <Chip key={l.name} text={l.name} tint={l.color ? `#${l.color}` : "var(--primary)"} />)}
        <button onClick={(e) => onEditField("labels", e)} disabled={busy} className="agx-inline-add" style={{ borderStyle: "dashed" }}>＋ Label</button>
      </div>
      )}
    </div>
  );
}

function Reason({ tint, glyph, children, action }: { tint: string; glyph: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
      style={{ color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
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
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 10%, transparent)" }}>
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
          style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", maxHeight: 520 }}>
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

/** A directory node in the changed-files tree. */
type TreeNode = { name: string; path: string; dirs: Map<string, TreeNode>; files: PrFile[] };

/** Generated files GitHub holds behind a "Load diff" button — lockfiles,
 *  minified bundles, source maps. Nobody reads these line by line, and a
 *  4,000-row lockfile is not what the tab should spend its frame budget on. */
const GENERATED_RE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|flake\.lock)$|\.min\.(js|css)$|\.(map|lock)$/i;
function needsLoadDiff(f: PrFile): boolean {
  return GENERATED_RE.test(f.path) || f.additions + f.deletions > 1500;
}

/** The extension a file is filed under in the facet menu — the last `.suffix`
 *  of the basename, lower-cased (`pnpm-lock.yaml` → `.yaml`). A dotfile or a
 *  file with no extension (`Dockerfile`, `.gitignore`) is filed under its own
 *  name, which is what GitHub does too. */
function fileExt(path: string): string {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : base;
}

/** A one-glyph status marker for the changed-files tree, coloured the way GitHub
 *  colours them: added green, removed red, renamed/copied blue, and a muted ±
 *  for a plain modification. `changeType` arrives lower-cased from the server. */
function statusGlyph(status: string): { ch: string; tint: string; title: string } {
  switch (status) {
    case "added": return { ch: "+", tint: "var(--success)", title: "Added" };
    case "removed":
    case "deleted": return { ch: "−", tint: "var(--error)", title: "Deleted" };
    case "renamed": return { ch: "→", tint: "var(--primary)", title: "Renamed" };
    case "copied": return { ch: "⧉", tint: "var(--primary)", title: "Copied" };
    default: return { ch: "±", tint: "var(--text3)", title: "Modified" };
  }
}

/** Group changed paths into directories, then collapse the runs of single-child
 *  directories the way GitHub does (`web/src/lib` on one row, not three). */
function buildFileTree(files: PrFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) { next = { name: dir, path: node.path ? `${node.path}/${dir}` : dir, dirs: new Map(), files: [] }; node.dirs.set(dir, next); }
      node = next;
    }
    node.files.push(f);
  }
  const squash = (n: TreeNode): TreeNode => {
    let cur = n;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0]!;
      cur = { ...only, name: `${cur.name}/${only.name}`.replace(/^\//, "") };
    }
    return { ...cur, dirs: new Map([...cur.dirs].map(([k, v]) => [k, squash(v)])) };
  };
  return { ...root, dirs: new Map([...root.dirs].map(([k, v]) => [k, squash(v)])) };
}

function FileTree({ node, sel, onPick, onPeek, seen, drafts, depth = 0 }: {
  node: TreeNode; sel: string | null; onPick: (p: string) => void;
  /** Open the whole file in an editor, over the panel. The diff shows what
   *  changed; this is for the times the answer is in the part that did not. */
  onPeek?: (p: string) => void;
  seen: (p: string) => boolean; drafts: (p: string) => number; depth?: number;
}) {
  return (
    <>
      {[...node.dirs.values()].map((dir) => (
        <div key={dir.path}>
          <div className="truncate text-[10px] px-1 py-0.5" style={{ paddingLeft: 6 + depth * 10, color: "var(--text3)" }} title={dir.path}>
            {dir.name}
          </div>
          <FileTree node={dir} sel={sel} onPick={onPick} onPeek={onPeek} seen={seen} drafts={drafts} depth={depth + 1} />
        </div>
      ))}
      {node.files.map((f) => {
        const base = f.path.split("/").pop() ?? f.path;
        const on = sel === f.path;
        const n = drafts(f.path);
        return (
          <button key={f.path} onClick={() => onPick(f.path)}
            // Alt-click opens it whole, which is the gesture that costs nothing
            // to learn because it costs nothing to not know.
            onAuxClick={(e) => { if (e.button === 1 && onPeek) { e.preventDefault(); onPeek(f.path); } }}
            title={`${f.path}${f.status ? ` · ${f.status}` : ""}${onPeek ? " · alt-click to open the whole file" : ""}`}
            onClickCapture={(e) => { if (e.altKey && onPeek) { e.preventDefault(); e.stopPropagation(); onPeek(f.path); } }}
            className="agx-btn w-full text-left flex items-center gap-1 py-0.5 rounded truncate hover:bg-white/5 agx-peekrow"
            style={{
              paddingLeft: 6 + depth * 10, paddingRight: 4,
              background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined,
              color: seen(f.path) ? "var(--text3)" : "var(--text2)",
            }}>
            {/* Which files are new, which changed — the status marker GitHub puts
                on every row of its tree, so an added file reads as added without
                opening it. */}
            {(() => { const g = statusGlyph(f.status); return <span className="shrink-0 text-center leading-none" style={{ width: 11, fontSize: 9, color: g.tint }} title={g.title}>{g.ch}</span>; })()}
            <span className="truncate text-[10.5px]">{base}</span>
            {n > 0 && <span className="ml-auto text-[9px] shrink-0" style={{ color: "var(--warning)" }}>{n}</span>}
            {f.comments > 0 && <span className="ml-auto text-[9px] shrink-0" style={{ color: "var(--primary)" }}>{f.comments}</span>}
            {seen(f.path) && <span className="ml-auto text-[9px] shrink-0" style={{ color: "var(--success)" }}>✓</span>}
          </button>
        );
      })}
    </>
  );
}

/**
 * The changed-files filter, GitHub's funnel: a menu of the extensions present in
 * this diff (each with its own count) and a toggle for whether files you have
 * already marked viewed still show. `hiddenExts` is the set to leave out — empty
 * means every extension is on, which is why the boxes all start ticked.
 */
function FilesFilterMenu({ facets, hiddenExts, onToggleExt, onClearExts, showViewed, onToggleViewed, viewedCount }: {
  facets: { ext: string; count: number }[];
  hiddenExts: string[]; onToggleExt: (e: string) => void; onClearExts: () => void;
  showViewed: boolean; onToggleViewed: () => void; viewedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Keep the panel on screen when the funnel sits near the right edge.
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 236) });
    }
  }, [open]);
  const active = hiddenExts.length > 0 || !showViewed;
  const box = (on: boolean) => ({ width: 14, height: 14, borderRadius: 4, border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`, background: on ? "var(--primary)" : "transparent", color: "var(--bg)" });
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((o) => !o)} title="Filter changed files"
        aria-label="Filter changed files" aria-haspopup="menu" aria-expanded={open}
        className="agx-btn shrink-0 grid place-items-center rounded"
        style={{ width: 24, height: 22, color: active ? "var(--primary)" : "var(--text3)", border: `1px solid color-mix(in srgb, ${active || open ? "var(--primary)" : "var(--border) 45%"}, transparent)` }}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5h12L9.3 9v4L6.7 14.3V9L2 3.5Z" /></svg>
      </button>
      {open && (
        <Portal>
          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div role="menu" className="fixed p-1.5 rounded-xl flex flex-col overflow-hidden text-[11px]"
            style={{ top: pos.top, left: pos.left, minWidth: 216, maxHeight: "min(60vh, 420px)", zIndex: 9999, background: "color-mix(in srgb, var(--bg2) 97%, black)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)", backdropFilter: "blur(18px)" }}>
            <div className="px-2 pt-1 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>File extensions</div>
            <div className="flex flex-col gap-0.5 overflow-y-auto agw-noscrollbar">
              {facets.map((f) => {
                const on = !hiddenExts.includes(f.ext);
                return (
                  <button key={f.ext} role="menuitemcheckbox" aria-checked={on} onClick={() => onToggleExt(f.ext)}
                    className="px-2 py-1.5 rounded-lg text-left flex items-center gap-2 hover:bg-white/5">
                    <span aria-hidden className="shrink-0 grid place-items-center text-[9px]" style={box(on)}>{on ? "✓" : ""}</span>
                    <span className="flex-1 truncate" style={{ ...CODE_FONT_STYLE, color: on ? "var(--text)" : "var(--text3)" }}>{f.ext}</span>
                    <span className="tabular-nums shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{f.count}</span>
                  </button>
                );
              })}
            </div>
            <button role="menuitemcheckbox" aria-checked={showViewed} onClick={onToggleViewed}
              className="mt-1 px-2 py-1.5 rounded-lg text-left flex items-center gap-2 hover:bg-white/5"
              style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
              <span aria-hidden className="shrink-0 grid place-items-center text-[9px]" style={box(showViewed)}>{showViewed ? "✓" : ""}</span>
              <span className="flex-1" style={{ color: "var(--text2)" }}>Viewed files</span>
              <span className="tabular-nums shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{viewedCount}</span>
            </button>
            {hiddenExts.length > 0 && (
              <button onClick={onClearExts} className="mt-0.5 px-2 py-1 rounded-lg text-left text-[10.5px] hover:bg-white/5" style={{ color: "var(--text3)" }}>Reset extensions</button>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}

/**
 * Search the code of a whole review, GitHub-style — the answer to "where else
 * is this called?" without opening thirteen files and searching each one.
 *
 * Deliberately not the browser's Ctrl+F, which is blind here: files fold when
 * you mark them viewed, diffs are lazy-mounted, and a big file is held behind a
 * button — so most of the review is not in the DOM to be found. This searches
 * the diffs in memory, which are all there, and then opens what it found.
 */
function FindBar({ value, onChange, inputRef, listRef, hits, groups, at, onGo, onClose, fileCount, loaded }: {
  value: string; onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  listRef: React.RefObject<HTMLDivElement>;
  hits: Match[]; groups: { path: string; matches: Match[] }[]; at: number;
  onGo: (i: number) => void; onClose: () => void;
  fileCount: number; loaded: boolean;
}) {
  const edge = "1px solid color-mix(in srgb, var(--text) 20%, transparent)";
  const typed = value.trim().length >= 2;
  // The index each group's first match sits at, so a row knows its own place in
  // the flat list without the render doing arithmetic per row.
  let running = 0;
  const numbered = groups.map((g) => { const from = running; running += g.matches.length; return { ...g, from }; });
  const nav = (dir: 1 | -1) => onGo(at + dir);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md"
        style={{ background: "var(--bg)", border: edge }}>
        <span className="shrink-0" style={{ color: "var(--primary)" }}>⌕</span>
        <input
          ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={`Search the code of ${fileCount} file${fileCount === 1 ? "" : "s"}…`}
          spellCheck={false} autoComplete="off"
          className="flex-1 min-w-0 bg-transparent outline-none text-[11px]"
          style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}
          onKeyDown={(e) => {
            // Held here rather than on the frame: while you are typing, the
            // frame never sees a key, and Enter has to mean "next" for this to
            // feel like every other find bar ever built.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
            else if (e.key === "Enter") { e.preventDefault(); nav(e.shiftKey ? -1 : 1); }
            else if (e.key === "ArrowDown") { e.preventDefault(); nav(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); nav(-1); }
          }}
        />
        <span className="shrink-0 tabular-nums text-[10px] px-1" style={{ color: hits.length ? "var(--text2)" : "var(--text3)" }}>
          {!typed ? "" : hits.length ? `${at + 1} / ${hits.length}` : "no match"}
        </span>
        <span className="shrink-0 flex items-center gap-1">
          <button onClick={() => nav(-1)} disabled={!hits.length} title="Previous match (⇧↵)"
            className="agx-btn text-[11px] leading-none px-1.5 py-1 rounded"
            style={{ border: edge, color: hits.length ? "var(--text2)" : "var(--text4)" }}>↑</button>
          <button onClick={() => nav(1)} disabled={!hits.length} title="Next match (↵)"
            className="agx-btn text-[11px] leading-none px-1.5 py-1 rounded"
            style={{ border: edge, color: hits.length ? "var(--text2)" : "var(--text4)" }}>↓</button>
          <button onClick={onClose} title="Close (Esc)"
            className="agx-btn text-[11px] leading-none px-1.5 py-1 rounded"
            style={{ border: edge, color: "var(--text2)" }}>✕</button>
        </span>
      </div>

      {/* The results, not just a counter: seeing the four lines it matched is
          usually the whole answer, and beats being teleported to the first one
          and having to press Enter to survey the rest. */}
      {typed && (
        <div ref={listRef} className="agx-scroll rounded-md overflow-y-auto"
          style={{ maxHeight: "38vh", background: "var(--bg)", border: edge }}>
          {!hits.length ? (
            <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
              {loaded ? <>Nothing matches “{value.trim()}” in this review.</> : <>Still loading the diffs — search will answer once they are in.</>}
            </div>
          ) : (
            <>
              {numbered.map((g) => (
                <div key={g.path}>
                  <div className="sticky top-0 z-[1] px-2.5 py-1 flex items-center gap-2"
                    style={{ background: "color-mix(in srgb, var(--text) 7%, var(--bg))", borderBottom: "1px solid color-mix(in srgb, var(--text) 12%, transparent)" }}>
                    <span className="truncate text-[10.5px]" style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{g.path}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[10px]" style={{ color: "var(--text3)" }}>{g.matches.length}</span>
                  </div>
                  {g.matches.map((m, i) => {
                    const idx = g.from + i;
                    const on = idx === at;
                    const e = excerpt(m);
                    return (
                      <button key={idx} data-hit={on ? "on" : undefined} onClick={() => onGo(idx)}
                        className="w-full text-left flex items-baseline gap-2 px-2.5 py-[3px] hover:bg-white/5"
                        style={{
                          background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined,
                          // A rail, not a border: the row keeps its height and
                          // the list does not jog by a pixel as you walk it.
                          boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
                        }}>
                        <span className="shrink-0 tabular-nums text-[10px] w-[52px] text-right"
                          style={{ color: m.side === "LEFT" ? "var(--error)" : "var(--text3)" }}>
                          {m.side === "LEFT" ? "−" : ""}{m.line}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-[10.5px]" style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>
                          {e.before}
                          <span style={{ background: "color-mix(in srgb, var(--primary) 38%, transparent)", color: "var(--text)", borderRadius: 2, padding: "0 1px" }}>{e.hit}</span>
                          {e.after}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {/* findInDiffs stops at 500. A list that quietly ended early is
                  how you conclude a symbol is used nowhere else. */}
              {hits.length >= 500 && (
                <div className="px-2.5 py-1.5 text-[10px]" style={{ color: "var(--warning)" }}>
                  First 500 matches — narrow the search to see the rest.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The file header's exact height. Fixed rather than whatever its padding adds
 *  up to, so the one pinned bar in this view has a height the scroll maths can
 *  rely on instead of measure. */
const FILE_HEAD_H = 30;

function FilesTab({ d, root, byPath, loaded, seenFiles, onSeen, sel, onSel, split, wrap, onSplit, onWrap, drafts, onAddDraft, onPostOne, onDropDraft, onPeek, onResolve, onReply, onApply, busy }: {
  d: PrDetail; root: string; byPath: Map<string, FileChange>; loaded: boolean;
  seenFiles: string[]; onSeen: (p: string) => void;
  sel: string | null; onSel: (p: string | null) => void;
  split: boolean; wrap: boolean; onSplit: (v: boolean) => void; onWrap: (v: boolean) => void;
  drafts: DraftComment[]; onAddDraft: (path: string, line: number, startLine?: number, side?: "LEFT" | "RIGHT", body?: string) => void;
  /** Post one line comment on its own, now — the other half of what GitHub
   *  offers at the box, beside holding it for a review. */
  onPostOne: (path: string, line: number, startLine: number | undefined, side: "LEFT" | "RIGHT" | undefined, body: string) => Promise<boolean>;
  /** Discard a pending comment from where it is shown, rather than only from
   *  the Review tab it is otherwise buried in. */
  onDropDraft: (d: DraftComment) => void;
  /** Open a file whole, over the panel, in an editor. */
  onPeek?: (path: string) => void;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread, body: string) => Promise<boolean>;
  onApply?: (t: PrThread, text: string) => void; busy: boolean;
}) {
  const draftsFor = (p: string) => drafts.filter((x) => x.path === p).length;
  /** This file's pending comments, keyed the way a diff row asks for them:
   *  the side letter and the line, so a row can find its own without scanning
   *  the whole list on every render. */
  const pendingBy = (p: string) => {
    const m = new Map<string, DraftComment[]>();
    for (const dc of drafts) {
      if (dc.path !== p) continue;
      const k = `${dc.side === "LEFT" ? "L" : "R"}${dc.line}`;
      const arr = m.get(k) ?? [];
      arr.push(dc);
      m.set(k, arr);
    }
    return m;
  };
  // For the "+" menu's Copy link: a blob permalink at the PR head commit.
  const repoName = useContext(RepoCtx);
  const headSha = d.commits.length ? d.commits[d.commits.length - 1].oid : "";
  // The text of one line as it stands in the diff — used to seed a "Suggest
  // change" with the line it is about, the way GitHub prefills the block.
  const lineTextAt = (path: string, line: number, side: "LEFT" | "RIGHT"): string => {
    const ch = byPath.get(path);
    if (!ch) return "";
    for (const h of ch.hunks) {
      let oldN = h.oldStart, newN = h.newStart;
      for (const raw of h.lines) {
        if (raw.startsWith("\\")) continue;
        const tag = raw[0], text = raw.slice(1);
        if (tag === "+") { if (side === "RIGHT" && newN === line) return text; newN++; }
        else if (tag === "-") { if (side === "LEFT" && oldN === line) return text; oldN++; }
        else { if ((side === "RIGHT" && newN === line) || (side === "LEFT" && oldN === line)) return text; oldN++; newN++; }
      }
    }
    return "";
  };
  /**
   * The line, or range of lines, a comment is being written about.
   *
   * A plain click starts at that line; shift-click extends from it, which is
   * GitHub's gesture for "this whole block". Kept here rather than in the diff
   * component so the highlight survives a re-render of the file and so only one
   * file can be mid-selection at a time.
   */
  const [selRange, setSelRange] = useState<{ path: string; sel: LineSel } | null>(null);
  // Which line has a NEW-comment composer open, and (for Suggest change) the
  // text it opened with. The composer renders inline under the line via the same
  // rowAfter slot the threads use — GitHub's placement, not a modal.
  const [composing, setComposing] = useState<{ path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT"; initial?: string } | null>(null);
  /** Where a half-written comment is kept: this pull request, this file, this
   *  line. Not the range — a comment stretched over lines 12–18 is still being
   *  written about the line you clicked. */
  const composeStashKey = (path: string, side: "LEFT" | "RIGHT", line: number) =>
    `${root}#${d.number}|${path}|${side === "LEFT" ? "L" : "R"}${line}`;
  // Cancel is the one thing that means "I do not want this". Everything else —
  // closing the box, changing tabs, a rebuild — keeps it.
  const cancelCompose = () => {
    if (composing) writeStash(composeStashKey(composing.path, composing.side, composing.line), "");
    setComposing(null); setSelRange(null);
  };

  /** Turn the open composer into a suggestion, seeded with the line it is
   *  about — what the menu's "Suggest change" used to do, moved to where you
   *  can decide it with the code in front of you. */
  const suggestHere = (f: PrFile, c: NonNullable<typeof composing>) => {
    const body = lineTextAt(f.path, c.line, c.side);
    setComposing({ ...c, initial: `\`\`\`suggestion\n${body}\n\`\`\`\n` });
  };

  const pickLine = (path: string, pk: LinePick) => {
    const cur = selRange?.path === path ? selRange.sel : null;
    if (pk.shift && cur && cur.side === pk.side) {
      const sel = { start: cur.start, end: pk.line, side: pk.side };
      const line = Math.max(sel.start, sel.end), startLine = Math.min(sel.start, sel.end);
      setSelRange({ path, sel });
      setComposing({ path, line, startLine: startLine !== line ? startLine : undefined, side: pk.side });
      return;
    }
    // A single line: mark it (a following shift-click can stretch the range) and
    // open the composer under it. "Suggest change" seeds a ```suggestion block.
    setSelRange({ path, sel: { start: pk.line, end: pk.line, side: pk.side } });
    const initial = pk.mode === "suggest" ? "```suggestion\n" + lineTextAt(path, pk.line, pk.side) + "\n```\n" : undefined;
    setComposing({ path, line: pk.line, side: pk.side, initial });
  };
  /** Unresolved first: a resolved thread is history, an open one is a question. */
  const threadsFor = (p: string) => d.threads.filter((t) => t.path === p)
    .sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
  const frameRef = useRef<HTMLDivElement>(null);
  /**
   * How tall the sticky toolbar is, right now.
   *
   * Anything scrolled to — a file picked in the tree, the next hunk, the next
   * file under j/k — otherwise lands underneath it: `scrollIntoView` aligns to
   * the top of the scroll box and knows nothing about a bar floating over that
   * top. Measured rather than guessed, because the bar wraps to two rows on a
   * narrow panel, and fed to `scroll-margin-top`, which is the property
   * `scrollIntoView` actually honours.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(76);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarH(el.offsetHeight + 10);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /**
   * Scroll a file (or any element) to just under the sticky bar.
   *
   * `scrollIntoView` aligns to the top of the scrollport, and the bar floats
   * over that top, so the thing you asked for lands behind it. `scroll-margin`
   * is the documented cure and did not take here, so this does the arithmetic
   * itself against the real scroll container: where the element sits inside it,
   * minus the bar's measured height.
   */
  const scrollUnderBar = (el: Element | null | undefined) => {
    if (!el) return;
    const sc = el.closest<HTMLElement>(".agx-scroll");
    if (!sc) { el.scrollIntoView({ block: "start" }); return; }
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTo({ top: Math.max(0, top - (barRef.current?.offsetHeight ?? 76) - 8), behavior: "smooth" });
  };
  /**
   * Scroll to a file and STAY on it while the diffs above it mount.
   *
   * Diffs are lazy-mounted (see LazyMount): a file below the fold is a short
   * placeholder until it scrolls near, then it swaps in its real, taller
   * content. A one-shot scroll to the last file therefore landed on where the
   * file was BEFORE the files above it grew — "the end of what's loaded so far",
   * never the file. So this re-aligns every frame, snapping the target back under
   * the bar as the placeholders above it fill in, until its position stops moving
   * (or a ~40-frame ceiling). The element is re-queried each frame because the
   * mount replaces its node. Instant, not smooth: a smooth scroll and a moving
   * target fight each other.
   */
  const scrollToFileStable = (getEl: () => Element | null | undefined) => {
    const first = getEl();
    const sc = first?.closest<HTMLElement>(".agx-scroll");
    if (!sc) { scrollUnderBar(first); return; }
    let ticks = 0, lastTop = NaN;
    const align = () => {
      const el = getEl();
      if (!el) return;
      const rel = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      sc.scrollTop = Math.max(0, sc.scrollTop + rel - (barRef.current?.offsetHeight ?? 76) - 8);
      const now = el.getBoundingClientRect().top;
      if ((Number.isNaN(lastTop) || Math.abs(now - lastTop) > 1) && ++ticks < 40) {
        lastTop = now;
        requestAnimationFrame(align);
      }
    };
    requestAnimationFrame(align);
  };
  const [q, setQ] = useState("");
  /*
   * Finding a word across every file, which the browser's own Ctrl+F cannot do
   * here: a file folds when you mark it viewed and the diff is windowed, so
   * half the matches live in nodes that do not exist yet. "Where else is this
   * helper called?" is the question a review asks most, and until now the only
   * way to answer it was to open thirteen files and search each one.
   */
  const [find, setFind] = useState<string | null>(null);
  const [findAt, setFindAt] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const findListRef = useRef<HTMLDivElement>(null);
  // The facet filter: extensions to leave OUT (empty = show every extension),
  // and whether files already marked viewed still show. Both scope one review of
  // one PR.
  const [hiddenExts, setHiddenExts] = useState<string[]>([]);
  const [showViewed, setShowViewed] = useState(true);
  // Folded, not opened: every file is open by default and this records the ones
  // you have put away. Seeded with the files too big to be a sensible default.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // A generated or very large diff is held behind a "Load diff" button even when
  // its file is open — GitHub does the same — so a lockfile does not render a
  // thousand rows nobody reads. This records the ones you asked to load anyway.
  const [loadedDiffs, setLoadedDiffs] = useState<Set<string>>(new Set());
  // Reset per PR — keyed on the NUMBER, not on `d.files`. The 20-second poll
  // hands back a fresh `d.files` array each time; depending on it here meant
  // every background refresh wiped the folds you had made and the filter you had
  // typed, and the re-expansion jumped the page back to the top mid-review.
  useEffect(() => {
    setQ(""); setHiddenExts([]); setShowViewed(true); setLoadedDiffs(new Set());
    setFind(null); setFindAt(0);
    setFolded(new Set(d.files.filter((f) => f.additions + f.deletions > BIG_FILE_LINES).map((f) => f.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.number]);
  // A file already marked viewed arrives folded. Coming back to a half-read
  // review used to reopen every file you had already ticked off, so the eleven
  // you were done with were back in the way and the two still to read were
  // somewhere below them. Marking a file viewed folds it; finding it already
  // viewed should mean the same thing.
  //
  // Once per file, not once per poll: `foldedOnce` is what stops the twenty
  // second refresh from re-folding a viewed file you have deliberately opened
  // back up to look at again.
  const foldedOnce = useRef<Set<string>>(new Set());
  useEffect(() => { foldedOnce.current = new Set(); }, [d.number]);
  useEffect(() => {
    const late = seenFiles.filter((p) => !foldedOnce.current.has(p));
    if (!late.length) return;
    for (const p of late) foldedOnce.current.add(p);
    setFolded((cur) => new Set([...cur, ...late]));
  }, [seenFiles]);

  const extFacets = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of d.files) { const e = fileExt(f.path); m.set(e, (m.get(e) ?? 0) + 1); }
    return [...m.entries()].map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
  }, [d.files]);
  const viewedCount = useMemo(() => d.files.filter((f) => seenFiles.includes(f.path)).length, [d.files, seenFiles]);

  /** Matches for the current find, across every file the list is showing —
   *  computed from the diffs already in hand, so it costs a pass over memory
   *  and no network at all. */
  const findHits = useMemo(() => {
    if (!find || find.trim().length < 2) return [];
    return findInDiffs(d.files.map((f) => ({ path: f.path, change: byPath.get(f.path) })), find);
  }, [find, d.files, byPath]);
  const findGroups = useMemo(() => groupByFile(findHits), [findHits]);

  /** Open a match: unfold the file it is in, load the diff if it was held back,
   *  select the line so the eye lands ON it rather than somewhere in the right
   *  region, and scroll it under the bar. */
  const goToMatch = useCallback((m: Match) => {
    setFolded((cur) => { const n = new Set(cur); n.delete(m.path); return n; });
    setLoadedDiffs((cur) => new Set(cur).add(m.path));
    onSel(m.path);
    setSelRange({ path: m.path, sel: { side: m.side, start: m.line, end: m.line } });
    requestAnimationFrame(() => {
      // Aim for the line, settle for the file. A diff below the fold is still a
      // LazyMount placeholder when this runs, so the row does not exist yet;
      // the aligner re-queries every frame, and picks the line up the moment it
      // mounts. Scoped to the file — "R412" exists in most of them.
      scrollToFileStable(() => {
        const host = frameRef.current?.querySelector(`[data-path="${CSS.escape(m.path)}"]`);
        return host?.querySelector(`[data-ln="${m.side === "LEFT" ? "L" : "R"}${m.line}"]`) ?? host;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSel]);

  /** Step through the results. The index is the cursor; everything else — which
   *  file is open, where the page is — follows from it. */
  const goToIndex = useCallback((i: number) => {
    if (!findHits.length) return;
    const n = ((i % findHits.length) + findHits.length) % findHits.length;
    setFindAt(n);
    goToMatch(findHits[n]!);
  }, [findHits, goToMatch]);

  // A new query starts at its first hit rather than wherever the last one left
  // the cursor, which would be an index into a list that no longer exists.
  useEffect(() => { setFindAt(0); }, [find]);
  // Keep the active result in view in the list as Enter walks past the bottom.
  useEffect(() => {
    findListRef.current?.querySelector('[data-hit="on"]')?.scrollIntoView({ block: "nearest" });
  }, [findAt]);

  /**
   * Ctrl+F, the key everyone already presses.
   *
   * On `window`, not on the frame: the point is that it works wherever you are
   * on the page, and the frame only sees keys when something inside it has
   * focus. The browser's own find is preventDefault'd away — it cannot see
   * folded files or unmounted rows, so leaving it in place would answer "no
   * results" for a word that is in four files.
   */
  useEffect(() => {
    const onWinKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      // A terminal owns its own keys — a peeked file is being read in nvim, and
      // Ctrl+F there is page-down.
      if ((e.target as HTMLElement)?.closest?.(".xterm")) return;
      e.preventDefault();
      setFind((cur) => cur ?? "");
      requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
    };
    window.addEventListener("keydown", onWinKey);
    return () => window.removeEventListener("keydown", onWinKey);
  }, []);

  const shownFiles = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return d.files.filter((f) => {
      if (needle && !f.path.toLowerCase().includes(needle)) return false;
      if (hiddenExts.length && hiddenExts.includes(fileExt(f.path))) return false;
      if (!showViewed && seenFiles.includes(f.path)) return false;
      return true;
    });
  }, [d.files, q, hiddenExts, showViewed, seenFiles]);

  const toggleFold = (p: string) => setFolded((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  // Marking a file viewed folds it away, and un-marking opens it back up — the
  // pairing GitHub uses, so "viewed" clears a read diff off the screen instead of
  // leaving it in the way.
  const seenAndFold = (path: string) => {
    const wasViewed = seenFiles.includes(path);
    onSeen(path);
    setFolded((cur) => {
      const next = new Set(cur);
      if (wasViewed) next.delete(path); else next.add(path);
      return next;
    });
    // Marking a file viewed collapses it, and everything under it jumps up by
    // however tall it was — so the file you move on to arrives already scrolled
    // to wherever the last one happened to end. Put the next one at the top,
    // which is the only place a file you have not read yet should start.
    //
    // Only on the way in: unfolding is you going back to look at something, and
    // moving the page under that would be taking the click away from you.
    if (wasViewed) return;
    const i = shownFiles.findIndex((f) => f.path === path);
    // The last file has no next — hold the one just folded, rather than
    // throwing the page to the bottom of a list that has just got shorter.
    const target = shownFiles[i + 1]?.path ?? path;
    requestAnimationFrame(() => {
      scrollToFileStable(() => document.querySelector(`[data-path="${target}"]`));
    });
  };
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
    scrollToFileStable(() => frameRef.current?.querySelector('[data-file="active"]'));
  };
  const jumpHunk = (dir: 1 | -1) => {
    const frame = frameRef.current;
    if (!frame) return;
    // The page's scroller, the same one scrollUnderBar uses. It used to look for
    // `[data-vscroll]`, the per-file inner scroller — which no longer exists now
    // that files scroll with the page, so every jump was measured against the
    // wrong box.
    const sc = frame.closest<HTMLElement>(".agx-scroll") ?? frame;
    const heads = Array.from(sc.querySelectorAll<HTMLElement>("[data-hunk]"));
    if (!heads.length) return;
    const scTop = sc.getBoundingClientRect().top;
    const cur = sc.scrollTop;
    const tops = heads.map((h) => h.getBoundingClientRect().top - scTop + cur);
    // Compare against the first line the reader can actually see, not the raw
    // scrollTop: the sticky bar covers `barH` of it, so a hunk sitting under
    // the bar counts as already passed and "next" would skip the one you are
    // looking for. The same offset comes back off the destination, which is
    // why this cannot use scroll-margin like the others do.
    const eye = cur + barH;
    const target = dir === 1 ? tops.find((t) => t > eye + 4) : [...tops].reverse().find((t) => t < eye - 4);
    sc.scrollTo({ top: Math.max(0, (target ?? (dir === 1 ? tops[tops.length - 1] : tops[0])) - barH - 2), behavior: "smooth" });
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
    else if (k === "x") { e.preventDefault(); e.stopPropagation(); if (sel) seenAndFold(sel); }
    else if (k === "enter" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (sel) toggleFold(sel); }
  };
  // Focus the frame when the files tab mounts, so the keys work without a click
  // first — the same first-frame focus the changes modal does.
  useEffect(() => { requestAnimationFrame(() => frameRef.current?.focus()); }, []);

  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey} className="text-[11px] flex flex-col gap-2 outline-none">
      {/* One bar, and it stays put: filter, view mode, progress. Everything that
          used to be repeated on each file's own toolbar lives here once.

          A header band, not a floating slab. It used to be the app's darkest
          tone (--bg), rounded, and inset — a dark card hovering over the --bg2
          panel it sits on, which read as not belonging to the app. Now it is
          full-bleed to the panel edges, square, and the panel's OWN --bg2, so it
          reads as one continuous header with the tab row above it, parted only
          by a hairline like every other toolbar here. The box-shadow paints the
          12px the scroll container insets above it (its p-3) in the same tone,
          so nothing bleeds through while it is pinned. */}
      <div ref={barRef} className="flex flex-col gap-1 sticky top-0 z-30 -mx-3 px-3 py-2"
        style={{ background: "var(--bg2)", boxShadow: "0 -12px 0 var(--bg2)", borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 px-2 py-1 rounded shrink-0"
          style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          <span style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…"
            className="bg-transparent outline-none text-[10.5px] w-28" style={{ color: "var(--text)" }} />
          {q && <button onClick={() => setQ("")} title="Clear" style={{ color: "var(--text3)" }}>×</button>}
        </span>
        <FilesFilterMenu
          facets={extFacets} hiddenExts={hiddenExts}
          onToggleExt={(e) => setHiddenExts((cur) => cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e])}
          onClearExts={() => setHiddenExts([])}
          showViewed={showViewed} onToggleViewed={() => setShowViewed((v) => !v)}
          viewedCount={viewedCount}
        />
        {/* The filter to its left narrows the LIST by path; this searches the
            CODE. Two different questions, so they are two different controls —
            and the shortcut is on the button because nobody reads a legend. */}
        <Btn small primary={find !== null}
          title="Search the code of every file in this review (Ctrl+F)"
          onClick={() => {
            if (find !== null) { setFind(null); return; }
            setFind("");
            requestAnimationFrame(() => findRef.current?.focus());
          }}>⌕ Search code</Btn>
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
      {find !== null && (
        <FindBar
          value={find} onChange={setFind} inputRef={findRef} listRef={findListRef}
          hits={findHits} groups={findGroups} at={findAt}
          onGo={goToIndex} onClose={() => { setFind(null); frameRef.current?.focus(); }}
          fileCount={d.files.length} loaded={loaded}
        />
      )}
      <div className="text-[10px]" style={{ color: "var(--text3)" }}>
        <b>j/k</b> file · <b>n/p</b> hunk · <b>x</b> viewed · <b>↵</b> fold · <b>⌃F</b> search code
        {shownFiles.length !== d.files.length && <span> · showing {shownFiles.length} of {d.files.length}</span>}
      </div>
      </div>

      {/* Tree on the left, diffs on the right — the arrangement GitHub uses, and
          the only way to keep your bearings in a change that touches thirty
          files. The tree is the navigator; the stack is still the reading. */}
      <div className="flex gap-3 items-start">
        {shownFiles.length > 4 && (
          <aside className="shrink-0 w-[190px] sticky top-[68px] z-10 max-h-[calc(100vh-160px)] overflow-y-auto agx-scroll hidden md:block pr-1"
            style={{ borderRight: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
            <FileTree
              node={buildFileTree(shownFiles)} sel={sel}
              onPick={(path) => { onSel(path); setFolded((cur) => { const n = new Set(cur); n.delete(path); return n; }); scrollToFileStable(() => frameRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)); }}
              seen={(path) => seenFiles.includes(path)}
              drafts={draftsFor} onPeek={onPeek}
            />
          </aside>
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-2">
      {shownFiles.length === 0 && (
        <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>
          {q ? `No file matches “${q}”.` : "No files match the current filter."}
        </div>
      )}
      {/* A file list that quietly disagreed with the header count is how nobody
          noticed the hundred-and-first file was missing. Say it. */}
      {d.truncated?.files ? (
        <div className="text-[10px] px-1 py-1" style={{ color: "var(--warning)" }}>
          {d.truncated.files} more file{d.truncated.files === 1 ? "" : "s"} changed than GitHub will return on one page — open it on GitHub to see the rest.
        </div>
      ) : null}

      {shownFiles.map((f) => {
        const done = seenFiles.includes(f.path);
        const open = !folded.has(f.path);
        const focused = sel === f.path;
        const nd = draftsFor(f.path);
        const pendingHere = pendingBy(f.path);
        const change = byPath.get(f.path);
        // Anchor each thread inline, under the line it is about — GitHub's
        // placement. A thread whose line is not in the diff (outdated, or a
        // context line the hunks do not reach) has no row to sit under, so it
        // keeps its home in the list under the file rather than vanishing.
        const inlineThreads = new Map<number, PrThread[]>();
        const belowThreads: PrThread[] = [];
        for (const t of threadsFor(f.path)) {
          const anchored = t.line != null && !t.isOutdated &&
            !!change?.hunks.some((h) => t.line! >= h.newStart && t.line! <= h.newStart + h.newLines - 1);
          if (anchored) { const arr = inlineThreads.get(t.line!) ?? []; arr.push(t); inlineThreads.set(t.line!, arr); }
          else belowThreads.push(t);
        }
        return (
          <div key={f.path} data-file={focused ? "active" : undefined} data-path={f.path} className="rounded"
            style={{
              // `overflow: clip`, not `hidden`: hidden turns the card into its own
              // scroll container, which would pin the sticky header below to the
              // card instead of the page. clip keeps the rounded corners without
              // that side effect, so the header can stick against the page scroll.
              overflow: "clip",
              border: `1px solid color-mix(in srgb, ${focused ? "var(--primary) 45%" : "var(--border) 30%"}, transparent)`,
              opacity: done && !open ? 0.72 : 1,
              // Hunk headers do not stick here. Two pinned bars stacked on one
              // scroll always leave a row cut in half between them — first the
              // `@@` sat over the file's name, then over a line of code — and
              // there is no offset that removes it, only one that moves it.
              // GitHub pins the file header and lets the hunks scroll, and one
              // pinned thing per file is the shape that has no seam.
              //
              // The standalone diff viewer keeps its sticky hunks: it has no
              // file header above them, so nothing to collide with. Hence a
              // variable defaulting to `sticky` rather than a change to it.
              ["--agx-hunk-pos" as string]: "static",
            }}>
            {/* The file's own header stays put while you read its diff — the
                GitHub behaviour, so the code under the cursor always has a name
                above it. Opaque (the tint mixed into --bg, not laid over
                transparent) so the diff cannot bleed through it while pinned, and
                pinned just under the toolbar. */}
            <div className="flex items-center gap-2 px-2.5 sticky z-20"
              style={{
                top: Math.max(0, barH - 10),
                height: FILE_HEAD_H,
                background: "color-mix(in srgb, var(--border) 12%, var(--bg))",
                borderBottom: open ? "1px solid color-mix(in srgb, var(--border) 25%, transparent)" : undefined,
              }}>
              <button onClick={() => { onSel(f.path); toggleFold(f.path); }} className="flex-1 min-w-0 text-left flex items-center gap-2">
                <span className="shrink-0" style={{ color: "var(--text3)" }}>{open ? "▾" : "▸"}</span>
                <span className="truncate" style={{ ...CODE_FONT_STYLE, color: done ? "var(--text3)" : "var(--text)" }}>{f.path}</span>
                {f.status && f.status !== "modified" && <Chip text={f.status} tint="var(--text3)" />}
                {f.comments > 0 && <Chip text={`${f.comments} open`} tint="var(--warning)" />}
                {nd > 0 && <Chip text={`${nd} pending`} tint="var(--primary)" title="Queued in your review" />}
                <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--success)" }}>+{f.additions}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--error)" }}>−{f.deletions}</span>
              </button>
              {/* The diff shows what changed. Often the answer is in the part
                  that did not — the function three lines above, the import at
                  the top — and reaching it meant finding a terminal, getting it
                  into the right checkout, and typing the path, by which point
                  you have lost the list you were working from. */}
              {onPeek && (
                <button onClick={() => onPeek(f.path)} title="Open the whole file in an editor"
                  className="agx-btn shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
                  ⧉ Open
                </button>
              )}
              {/* "Viewed" is state you keep for the length of a review, not a
                  one-off tick — a switch says that and a checkbox does not. */}
              <button onClick={() => seenAndFold(f.path)} title={done ? "Mark not viewed" : "Mark viewed"}
                aria-pressed={done}
                className="agx-btn shrink-0 flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: done ? "var(--success)" : "var(--text3)", border: `1px solid color-mix(in srgb, ${done ? "var(--success) 50%" : "var(--border) 45%"}, transparent)` }}>
                <span className="agx-sw" data-on={done ? "1" : "0"} />Viewed
              </button>
            </div>
            {open && (
              needsLoadDiff(f) && !loadedDiffs.has(f.path) ? (
                /* Generated or huge — held behind a button, GitHub-style, so a
                   lockfile does not render a thousand rows on open. */
                <div className="p-4 flex flex-col items-center gap-2.5 text-center" style={{ background: "color-mix(in srgb, var(--border) 4%, transparent)" }}>
                  <div className="w-full max-w-[520px] flex flex-col items-start gap-1.5 mb-1" aria-hidden>
                    {[62, 90, 74, 44, 82].map((w, i) => <div key={i} className="rounded" style={{ height: 8, width: `${w}%`, background: "color-mix(in srgb, var(--border) 30%, transparent)" }} />)}
                  </div>
                  <Btn small primary onClick={() => setLoadedDiffs((s) => new Set(s).add(f.path))}>Load diff</Btn>
                  <span className="text-[10px]" style={{ color: "var(--text3)" }}>
                    {GENERATED_RE.test(f.path) ? "Generated file — not rendered by default." : `Large file (${f.additions + f.deletions} changed lines) — load when you need it.`}
                  </span>
                </div>
              ) : (
              <LazyMount minHeight={Math.min(320, 40 + (f.additions + f.deletions) * 18)}>
                {/* No inner scroller: a scroll box inside the page scroll is
                    how a click in the tree lands on a file you then cannot
                    scroll, and it is not what GitHub does. Long files are
                    folded by default instead, which is the honest cap. */}
                <div className="flex" style={{ overflowX: "auto" }}>
                  {/* An image first, and a file with no hunks second.
                      `gh pr diff` still emits a header for a binary file — just
                      "Binary files … differ" and nothing else — so the parser
                      produces an entry with zero hunks. Testing `change` before
                      the image put every PNG down the text path and rendered an
                      empty diff pane, which is why the image viewer never
                      appeared at all. */}
                  {!loaded ? <Loading label="Loading the diff…" size={18} />
                    : diffKind(f.path, change?.hunks.length ?? 0) === "image"
                      ? <ImageDiff root={root} number={d.number} path={f.path} status={f.status} />
                    : change?.hunks.length ? (
                      <DiffPane
                        file={change} split={split} wrap={wrap}
                        onPick={(pk) => pickLine(f.path, pk)}
                        sel={selRange?.path === f.path ? selRange.sel : null}
                        permalink={repoName && headSha ? (line) => `https://github.com/${repoName}/blob/${headSha}/${f.path}#L${line}` : undefined}
                        rowAfter={(inlineThreads.size || pendingHere.size || composing?.path === f.path) ? (newN, oldN) => {
                          const ts = newN != null ? inlineThreads.get(newN) : null;
                          // A queued comment has to be visible where it was
                          // written. It used to exist only as a number on the
                          // file's header and a row in the Review tab, so
                          // writing one and returning to the diff showed nothing
                          // at all — the line looked exactly as it had before,
                          // and the only way to check was to leave.
                          const pend = pendingHere.get(`${newN != null ? "R" : "L"}${newN ?? oldN}`) ?? [];
                          const composeHere = composing?.path === f.path &&
                            ((composing.side === "RIGHT" && composing.line === newN) || (composing.side === "LEFT" && composing.line === oldN));
                          if (!ts?.length && !pend.length && !composeHere) return null;
                          const pfx = composing?.side === "LEFT" ? "L" : "R";
                          // Bounded and pinned to the left so it reads at a sane
                          // width and stays put while the code scrolls sideways.
                          return (
                            <div className="flex flex-col gap-2 my-1.5 px-2" style={{
                              // A positioning wrapper and nothing else. It used
                              // to carry a tinted background and rules of its
                              // own, so a composer sat as a box inside a
                              // slightly wider box — two frames, neither
                              // aligned to the other, which is most of why this
                              // read as older than the app around it. One
                              // visible container: the card below.
                              position: "sticky", left: 0,
                              width: split ? "min(560px, 46vw)" : "min(900px, 92vw)",
                            }}>
                              {ts?.map((t) => <Thread key={t.id} t={t} inline onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} />)}
                              {pend.map((dc, i) => (
                                <div key={`p${i}`} className="rounded-lg overflow-hidden text-[11.5px]" style={{
                                  background: "var(--bg2)",
                                  border: "1px dashed color-mix(in srgb, var(--warning) 55%, transparent)",
                                }}>
                                  {/* Dashed and amber: this is written and not
                                      sent. A solid card would read as posted,
                                      which is the one thing it is not. */}
                                  <div className="px-2.5 py-1 flex items-center gap-2 text-[10px]"
                                    style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--warning)" }}>
                                    <span>Pending — sent when you submit the review</span>
                                    <button onClick={() => onDropDraft(dc)} title="Discard this pending comment"
                                      className="agx-btn ml-auto px-1.5 py-0.5 rounded text-[10px]"
                                      style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}>Drop</button>
                                  </div>
                                  <div className="px-2.5 py-2"><Md body={dc.body} /></div>
                                </div>
                              ))}
                              {composeHere && composing && (
                                <div className="rounded-lg overflow-hidden" style={{
                                  // The one box. Sat on the panel rather than
                                  // on a tint of its own, and lifted off the
                                  // diff by a shadow the way every other
                                  // floating surface in this app is.
                                  background: "var(--bg2)",
                                  border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)",
                                  boxShadow: "0 12px 30px -14px var(--shadow)",
                                }}>
                                  {/* The line's own actions live here, beside the
                                      box, rather than in a menu you had to get
                                      through to reach the box. Suggesting is a
                                      thing you decide with the code in front of
                                      you, not before you have seen it. */}
                                  <div className="px-3 py-2 text-[11px] flex items-center gap-2" style={{
                                    background: "color-mix(in srgb, var(--border) 22%, transparent)",
                                    borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)",
                                    color: "var(--text)",
                                  }}>
                                    <span className="min-w-0 truncate">
                                      {composing.startLine ? `Comment on lines ${pfx}${composing.startLine}–${composing.line}` : `Add a comment on line ${pfx}${composing.line}`}
                                    </span>
                                    <span className="ml-auto flex items-center gap-1 shrink-0">
                                      <button onClick={() => suggestHere(f, composing)} title="Prefill a suggestion block with this line"
                                        className="agx-btn px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>± Suggest</button>
                                      <button onClick={() => { if (repoName && headSha) void navigator.clipboard?.writeText(`https://github.com/${repoName}/blob/${headSha}/${f.path}#L${composing.line}`); }}
                                        disabled={!repoName || !headSha}
                                        title="Copy a link to this line on GitHub"
                                        className="agx-btn px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>🔗</button>
                                    </span>
                                  </div>
                                  <div className="p-2.5 flex flex-col gap-2">
                                    {/* Two outcomes, the way GitHub has them: post
                                        this one now, or hold it for the review you
                                        are building. Before, everything queued —
                                        so a one-line "typo here" needed a whole
                                        review submitted around it. */}
                                    {/* Neither button is filled, which is what
                                        GitHub does and the reason its pair does
                                        not mislead. Ours had the fill on "Add to
                                        review" — the one that posts nothing —
                                        so the button that looked like the action
                                        was the one that quietly queued a draft.
                                        Equal weight; you read the labels. */}
                                    <Composer initial={composing.initial} autoFocus={!split} busy={busy}
                                      stash={composeStashKey(f.path, composing.side, composing.line)}
                                      placeholder="Leave a comment — markdown works here"
                                      sendLabel={draftsFor(f.path) || drafts.length ? "Add to review" : "Start a review"}
                                      sendTitle="Hold this until you submit the review — the author is notified once, at the end"
                                      quiet
                                      onSend={async (b) => { onAddDraft(f.path, composing.line, composing.startLine, composing.side, b); cancelCompose(); return true; }}
                                      secondary={{
                                        label: "Comment",
                                        title: "Post this now, on its own — the author is notified straight away",
                                        onSend: async (b) => {
                                          const ok = await onPostOne(f.path, composing.line, composing.startLine, composing.side, b);
                                          if (ok) cancelCompose();
                                          return ok;
                                        },
                                      }} />
                                    <button onClick={cancelCompose} className="agx-btn self-start px-2 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Cancel</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        } : undefined}
                        expand={(hi) => {
                          // The gap between the end of the previous hunk and the
                          // start of this one — the lines GitHub did not send.
                          const h = change.hunks[hi];
                          if (!h) return null;
                          const prev = hi > 0 ? change.hunks[hi - 1] : null;
                          const prevEnd = prev ? prev.newStart + prev.newLines - 1 : 0;
                          const from = Math.max(prevEnd + 1, h.newStart - 20);
                          const to = h.newStart - 1;
                          if (to < from) return null;
                          return <ExpandContext root={root} number={d.number} path={f.path} from={from} to={to} />;
                        }}
                      />
                    )
                    : <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>No textual diff — binary, renamed, or too large to show</div>}
                </div>
              </LazyMount>
              )
            )}
            {/* The conversation about THIS file, under it. The count in the
                header said threads existed but you had to leave for the
                conversation tab to read them, which is the wrong way round
                while you are looking at the code they are about. */}
            {open && belowThreads.length > 0 && (
              <div className="px-2.5 py-2 flex flex-col gap-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 6%, transparent)" }}>
                {/* Not anchored to a visible line — outdated threads, or ones on
                    context the diff does not reach — so they live under the file
                    rather than inline. */}
                <div className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Other comments</div>
                {belowThreads.map((t) => (
                  <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} />
                ))}
              </div>
            )}
          </div>
        );
      })}
        </div>
      </div>
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
      style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>↗</a>
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

/** The eight GitHub allows, with the glyph each one renders as. */
const REACTION_EMOJI: { content: string; glyph: string; title: string }[] = [
  { content: "THUMBS_UP", glyph: "👍", title: "Like" },
  { content: "THUMBS_DOWN", glyph: "👎", title: "Dislike" },
  { content: "LAUGH", glyph: "😄", title: "Laugh" },
  { content: "HOORAY", glyph: "🎉", title: "Hooray" },
  { content: "CONFUSED", glyph: "😕", title: "Confused" },
  { content: "HEART", glyph: "❤️", title: "Heart" },
  { content: "ROCKET", glyph: "🚀", title: "Rocket" },
  { content: "EYES", glyph: "👀", title: "Eyes" },
];

/**
 * Emoji on a comment, as GitHub has them: the ones already pressed are shown
 * with their tally, and a `+` opens the rest. Acknowledging with a reaction is
 * how a thread stays short — the alternative is another comment saying "agreed".
 */
function Reactions({ nodeId, reactions, onReact }: {
  nodeId?: string; reactions?: PrReaction[]; onReact?: (nodeId: string, content: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // Eight emoji at ~26px plus the padding; enough to keep the row on screen
  // when the button sits near the right edge.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(6, Math.min(r.left, window.innerWidth - 240)) });
  }, [open]);
  const has = reactions ?? [];
  if (!onReact || !nodeId) {
    if (!has.length) return null;
    return (
      <div className="flex gap-1 flex-wrap mt-2">
        {has.map((r) => <span key={r.content} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text2)" }}>{REACTION_EMOJI.find((e) => e.content === r.content)?.glyph ?? "•"} {r.count}</span>)}
      </div>
    );
  }
  return (
    <div className="flex gap-1 flex-wrap items-center mt-2">
      {has.map((r) => {
        const e = REACTION_EMOJI.find((x) => x.content === r.content);
        return (
          <button key={r.content} onClick={() => onReact(nodeId, r.content, !r.viewerHasReacted)}
            title={r.viewerHasReacted ? "Remove your reaction" : e?.title}
            className="agx-btn text-[10px] px-1.5 py-0.5 rounded-full tabular-nums"
            style={{
              border: `1px solid ${r.viewerHasReacted ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
              background: r.viewerHasReacted ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
              color: r.viewerHasReacted ? "var(--primary-hover)" : "var(--text2)",
            }}>
            {e?.glyph ?? "•"} {r.count}
          </button>
        );
      })}
      <button ref={btnRef} onClick={() => setOpen((v) => !v)} title="Add a reaction" aria-label="Add a reaction"
        aria-haspopup="menu" aria-expanded={open}
        className="agx-btn text-[10px] px-1.5 py-0.5 rounded-full"
        style={{ border: "1px dashed color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text3)" }}>☺ +</button>
      {/* Through a portal, like every other menu here. Absolutely positioned it
          was a child of the comment card, and the card clips its own rounded
          corners — so the picker opened *inside* the comment and came out as a
          sliver. Fixed coordinates off the button keep it beside the button
          while belonging to nobody's overflow. */}
      {open && (
        <Portal>
          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div role="menu" className="fixed flex gap-0.5 p-1 rounded-lg"
            style={{
              top: pos.top, left: pos.left, zIndex: 9999,
              background: "color-mix(in srgb, var(--bg2) 97%, black)",
              border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)",
              boxShadow: "0 24px 60px -18px rgba(0,0,0,.7)",
              backdropFilter: "blur(18px)",
            }}>
            {REACTION_EMOJI.map((e) => {
              const mine = has.find((r) => r.content === e.content)?.viewerHasReacted ?? false;
              return (
                <button key={e.content} title={e.title}
                  onClick={() => { onReact(nodeId, e.content, !mine); setOpen(false); }}
                  className="agx-btn text-[13px] px-1 rounded hover:bg-white/10">{e.glyph}</button>
              );
            })}
          </div>
        </Portal>
      )}
    </div>
  );
}

/** OWNER / MEMBER / CONTRIBUTOR — how much weight a remark carries, at a glance. */
function AssocChip({ a }: { a?: PrAuthorAssociation }) {
  if (!a || a === "NONE" || a === "MANNEQUIN") return null;
  const label = a === "FIRST_TIME_CONTRIBUTOR" || a === "FIRST_TIMER" ? "first-time" : a.toLowerCase();
  const tint = a === "OWNER" || a === "MEMBER" ? "var(--primary)" : "var(--text3)";
  return <Chip text={label} tint={tint} title={`GitHub says this author is ${label}`} />;
}

function Card({ who, chip, when, tone, url, edited, assoc, nodeId, reactions, onReact, children }: {
  who: string; chip?: React.ReactNode; when?: string; tone?: "chg" | "appr" | "bot"; url?: string;
  edited?: string | null; assoc?: PrAuthorAssociation;
  nodeId?: string; reactions?: PrReaction[]; onReact?: (nodeId: string, content: string, on: boolean) => void;
  children: React.ReactNode;
}) {
  const edge = tone === "chg" ? "var(--error)" : tone === "appr" ? "var(--success)" : tone === "bot" ? "var(--info)" : "var(--border)";
  return (
    <div className="rounded-md overflow-hidden mb-2"
      style={{ border: `1px solid color-mix(in srgb, ${edge} ${tone ? 40 : 28}%, transparent)` }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]"
        style={{ background: `color-mix(in srgb, ${edge} ${tone ? 10 : 14}%, transparent)`, borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        <Avatar login={who} size={17} />
        <b style={{ color: "var(--text)", fontWeight: 500 }}>{who}</b>
        <AssocChip a={assoc} />
        {chip}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {when && <span className="text-[10px]" style={{ color: "var(--text3)" }}>{when}</span>}
          {/* GitHub says "edited" here, and it matters: the words you are
              reading may not be the words that were replied to. */}
          {edited && <span className="text-[10px]" title={`Edited ${ago(edited)}`} style={{ color: "var(--text3)" }}>· edited</span>}
          {url && <GhLink href={url} title="Open on GitHub" />}
        </span>
      </div>
      <div className="px-3 py-2.5">
        {children}
        <Reactions nodeId={nodeId} reactions={reactions} onReact={onReact} />
      </div>
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
    <div className="text-[10.5px]" style={{ ...CODE_FONT_STYLE, borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
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

function Thread({ t, onResolve, onReply, onApply, busy, inline }: {
  t: PrThread; onResolve: (t: PrThread) => void; onReply: (t: PrThread, body: string) => Promise<boolean>;
  onApply?: (t: PrThread, text: string) => void; busy: boolean;
  /** Rendered anchored under its line in the diff, not in the file's thread
   *  list: drop the path (obvious from where it sits) and the duplicated code
   *  snippet (the line is right above it). */
  inline?: boolean;
}) {
  // The REST reply endpoint takes the numeric comment id. `id` is a GraphQL
  // node id (`PRRC_kwDO…`) and `Number()` of that is NaN — which is why reply
  // could never have worked before `databaseId` was asked for.
  const canReply = typeof t.comments[0]?.databaseId === "number";
  const [replying, setReplying] = useState(false);
  // A suggestion inside this thread knows the file and the lines because the
  // thread does. An outdated thread is refused: its lines have moved, so the
  // range in hand no longer points where the comment meant.
  const suggest = useMemo(
    () => (onApply && !t.isOutdated && t.line ? { apply: (text: string) => onApply(t, text), busy } : null),
    [onApply, t, busy],
  );
  return (
    <SuggestCtx.Provider value={suggest}>
    <div className={`rounded-md overflow-hidden ${inline ? "" : "mb-2"}`} style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
        style={{ background: "color-mix(in srgb, var(--border) 14%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        <span className="truncate" style={{ color: "var(--primary)" }}>
          {inline
            ? (t.startLine && t.line && t.startLine !== t.line ? `Lines ${t.startLine}–${t.line}` : t.line ? `Line ${t.line}` : "Comment")
            : `${t.path}${t.line ? `:${t.line}` : ""}`}
        </span>
        {t.isOutdated && <Chip text="outdated" tint="var(--text3)" title="The code under this comment has changed since" />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {t.isResolved ? <Chip text="resolved" tint="var(--success)" /> : <Chip text="open" tint="var(--warning)" />}
          {t.url && <GhLink href={t.url} title="Open this thread on GitHub" />}
        </span>
      </div>
      {!inline && <ThreadSnippet hunk={t.diffHunk} line={t.originalLine ?? t.line} />}
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
      <div className="flex flex-col gap-2 px-3 py-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        {/* Reply with the full markdown composer — Write/Preview, mentions, the
            lot — the same box GitHub gives you, not a one-line prompt. Collapsed
            to a slim affordance until you mean it. */}
        {canReply && (replying ? (
          <Composer
            onSend={async (b) => { const ok = await onReply(t, b); if (ok) setReplying(false); return ok; }}
            busy={busy} placeholder="Reply — markdown works here" sendLabel="Reply" autoFocus
            stash={`reply|${t.id}`}
          />
        ) : (
          <button onClick={() => setReplying(true)}
            className="agx-btn w-full text-left px-3 py-1.5 rounded-lg text-[11px]"
            style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "color-mix(in srgb, var(--border) 8%, transparent)" }}>
            Reply…
          </button>
        ))}
        <div className="flex gap-1.5">
          {replying && <Btn onClick={() => setReplying(false)} small>Cancel</Btn>}
          <Btn onClick={() => onResolve(t)} disabled={busy} ok={!t.isResolved} small>{t.isResolved ? "Unresolve" : "Resolve conversation"}</Btn>
        </div>
      </div>
    </div>
    </SuggestCtx.Provider>
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
/** "X and claude committed", or "X, Y and 2 others" — how GitHub credits a
 *  commit that carries Co-authored-by trailers. */
function commitAuthorLine(c: PrCommit): string {
  const who = c.authors?.length ? c.authors : (c.author ? [c.author] : []);
  if (who.length === 0) return "unknown";
  if (who.length === 1) return `${who[0]} committed`;
  if (who.length === 2) return `${who[0]} and ${who[1]} committed`;
  return `${who[0]}, ${who[1]} and ${who.length - 2} other${who.length - 2 === 1 ? "" : "s"} committed`;
}

/** Commits under the day they landed, newest day last (the branch's own order). */
function groupCommitsByDay(commits: PrCommit[]): [string, PrCommit[]][] {
  const out: [string, PrCommit[]][] = [];
  for (const c of commits) {
    const day = c.committedAt
      ? new Date(c.committedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "Undated";
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(c);
    else out.push([day, [c]]);
  }
  return out;
}

const EVENT_GLYPH: Record<string, string> = {
  "force-push": "↻", renamed: "✎", labeled: "🏷", unlabeled: "🏷",
  assigned: "👤", unassigned: "👤", "review-requested": "👁", "review-request-removed": "👁",
  "ready-for-review": "◉", "convert-to-draft": "◌", merged: "⏣", closed: "✕", reopened: "↺",
  "cross-referenced": "🔗", milestoned: "◈", demilestoned: "◈", "head-ref-deleted": "⌫",
  "auto-merge-enabled": "⏱", "auto-merge-disabled": "⏱",
};
const EVENT_TINT: Record<string, string> = {
  "force-push": "var(--warning)", merged: "var(--primary)", closed: "var(--error)",
  reopened: "var(--success)", "ready-for-review": "var(--success)",
};

/** One non-comment event, written the way GitHub words it. */
function TimelineEvent({ e }: { e: PrEvent }) {
  const who = <b style={{ color: "var(--text)" }}>{e.actor || "somebody"}</b>;
  const mono = (t: string) => <code style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{t}</code>;
  const said = (() => {
    switch (e.kind) {
      case "force-push": return <>{who} force-pushed {e.detail ? mono(e.detail) : null}</>;
      case "renamed": return <>{who} changed the title to “{e.detail}”</>;
      case "labeled": return <>{who} added the <Chip text={e.detail || ""} tint={e.tint ? `#${e.tint}` : "var(--primary)"} /> label</>;
      case "unlabeled": return <>{who} removed the <Chip text={e.detail || ""} tint="var(--text3)" /> label</>;
      case "assigned": return <>{who} assigned <b style={{ color: "var(--text2)" }}>{e.detail}</b></>;
      case "unassigned": return <>{who} unassigned <b style={{ color: "var(--text2)" }}>{e.detail}</b></>;
      case "review-requested": return <>{who} requested a review from <b style={{ color: "var(--text2)" }}>{e.detail}</b></>;
      case "review-request-removed": return <>{who} withdrew the review request for {e.detail}</>;
      case "ready-for-review": return <>{who} marked this ready for review</>;
      case "convert-to-draft": return <>{who} converted this to a draft</>;
      case "merged": return <>{who} merged this into {mono(e.detail || "")}</>;
      case "closed": return <>{who} closed this</>;
      case "reopened": return <>{who} reopened this</>;
      case "cross-referenced": return <>{who} mentioned this in {e.detail}</>;
      case "milestoned": return <>{who} added this to the {e.detail} milestone</>;
      case "demilestoned": return <>{who} removed this from the {e.detail} milestone</>;
      case "head-ref-deleted": return <>{who} deleted the {mono(e.detail || "")} branch</>;
      case "auto-merge-enabled": return <>{who} armed auto-merge</>;
      case "auto-merge-disabled": return <>{who} cancelled auto-merge{e.detail ? ` (${e.detail})` : ""}</>;
      default: return <>{who} did something</>;
    }
  })();
  const inner = <span>{said} <span style={{ color: "var(--text3)" }}>· {ago(e.at)}</span></span>;
  return (
    <div className="agx-tiny">
      {e.url ? <a href={externalUrl(e.url)} target="_blank" rel="noreferrer noopener" style={{ color: "inherit" }}>{inner}</a> : inner}
    </div>
  );
}

function Conversation({ d, lanes, raw, onRaw, onResolve, onReply, onComment, onReact, onApply, busy }: {
  d: PrDetail;
  lanes: { humans: PrReview[]; botReviews: PrReview[]; humanComments: PrComment[]; bots: PrComment[] };
  raw: boolean; onRaw: (v: boolean) => void;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread, body: string) => Promise<boolean>;
  onApply?: (t: PrThread, text: string) => void;
  onComment: (body: string) => Promise<boolean>;
  onReact: (nodeId: string, content: string, on: boolean) => void;
  busy: boolean;
}) {
  const [newest, setNewest] = useState(false);
  const [who, setWho] = useState<"all" | "human" | "bot">("all");
  const kb = Math.round(lanes.bots.reduce((n, c) => n + c.body.length, 0) / 1024);
  const reviewAuthors = new Set(lanes.humans.map((r) => r.author));
  const orphanThreads = d.threads.filter((t) => !reviewAuthors.has(t.comments[0]?.author ?? ""));

  /** Who said it, so the timeline can be narrowed to one kind of voice. An
   *  `event` is nobody speaking — a push, a label — and belongs to neither
   *  side, so it shows in the whole timeline and in no filtered view. */
  type Lane = "human" | "bot" | "event";
  type Entry = { at: string; key: string; lane: Lane; node: React.ReactNode; body: React.ReactNode };
  const entries: Entry[] = [];

  for (const [i, r] of lanes.humans.entries()) {
    const mine = d.threads.filter((t) => t.comments[0]?.author === r.author);
    const tone = r.state === "CHANGES_REQUESTED" ? "chg" : r.state === "APPROVED" ? "appr" : undefined;
    entries.push({
      at: r.submittedAt, key: `r${i}`, lane: "human",
      node: <span style={{ color: tone === "chg" ? "var(--error)" : tone === "appr" ? "var(--success)" : "var(--text3)" }}>
        {r.state === "CHANGES_REQUESTED" ? "✕" : r.state === "APPROVED" ? "✓" : "💬"}</span>,
      body: (
        <>
          <Card who={r.author} when={ago(r.submittedAt)} url={r.url} tone={tone}
            edited={r.editedAt} assoc={r.association} nodeId={r.nodeId} reactions={r.reactions} onReact={onReact}
            chip={r.state === "CHANGES_REQUESTED" ? <Chip text="requested changes" tint="var(--error)" />
              : r.state === "APPROVED" ? <Chip text="approved" tint="var(--success)" /> : undefined}>
            {r.body ? <Md body={r.body} />
              : <span style={{ color: "var(--text3)" }}>({r.state.toLowerCase().replace("_", " ")}, no note)</span>}
          </Card>
          {mine.length > 0 && (
            <div className="pl-3 ml-2" style={{ borderLeft: "2px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
              {mine.map((t) => <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} />)}
            </div>
          )}
        </>
      ),
    });
  }
  for (const c of lanes.humanComments) {
    entries.push({
      at: c.createdAt, key: `c${c.id}`, lane: "human", node: <span style={{ color: "var(--text3)" }}>💬</span>,
      body: <Card who={c.author} when={ago(c.createdAt)} url={c.url}
        edited={c.editedAt} assoc={c.association} nodeId={c.nodeId} reactions={c.reactions} onReact={onReact}><Md body={c.body} /></Card>,
    });
  }
  for (const t of orphanThreads) {
    entries.push({
      at: t.comments[0]?.createdAt ?? "", key: `t${t.id}`, lane: "human",
      node: <span style={{ color: t.isResolved ? "var(--success)" : "var(--warning)" }}>{t.isResolved ? "✓" : "○"}</span>,
      body: <Thread t={t} onResolve={onResolve} onReply={onReply} onApply={onApply} busy={busy} />,
    });
  }
  for (const [i, r] of lanes.botReviews.entries()) {
    entries.push({
      at: r.submittedAt, key: `br${i}`, lane: "bot", node: <span style={{ color: "var(--info)" }}>⌬</span>,
      body: <Card who={r.author} when={ago(r.submittedAt)} url={r.url} tone="bot"
        nodeId={r.nodeId} reactions={r.reactions} onReact={onReact}
        chip={<Chip text="automation" tint="var(--info)" />}><Md body={r.body} /></Card>,
    });
  }
  for (const c of lanes.bots) {
    entries.push({
      at: c.createdAt, key: `b${c.id}`, lane: "bot", node: <span style={{ color: "var(--info)" }}>⌬</span>,
      body: (
        <Card who={c.author} when={ago(c.createdAt)} url={c.url} tone="bot" chip={<Chip text="automation" tint="var(--info)" />}
          nodeId={c.nodeId} reactions={c.reactions} onReact={onReact}>
          {/* Rendered, not dumped. In full these used to be a <pre> of the raw
              source, so a coverage report arrived as `<!-- Pytest Coverage
              Comment -->` and a wall of pipe characters — the one shape of
              comment that most needs a table to be a table. It goes through the
              same Md as everything else: the table renders, the <details> folds,
              and the shields.io badge becomes a pill instead of a broken image. */}
          {raw
            ? <Md body={c.body} />
            : <span style={{ color: "var(--text2)" }}>{c.digest || "(Nothing worth pulling out)"}</span>}
        </Card>
      ),
    });
  }

  // The events between the remarks: pushes, renames, labels, the merge itself.
  // Without them the conversation reads as if nothing happened between comments
  // — the force-push that invalidated a review simply is not there.
  for (const [i, e] of d.timeline.entries()) {
    entries.push({
      at: e.at, key: `e${i}`, lane: "event",
      node: <span style={{ color: EVENT_TINT[e.kind] ?? "var(--text3)" }}>{EVENT_GLYPH[e.kind] ?? "•"}</span>,
      body: <TimelineEvent e={e} />,
    });
  }

  entries.sort((a, b) => (newest ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)));

  // Events are not remarks, so they are not counted — Humans plus Bots adds up
  // to All, which is the sum a reader checks. They still show in the whole
  // timeline, where the push that invalidated a review is part of the story.
  const humanCount = entries.filter((e) => e.lane === "human").length;
  const botCount = entries.filter((e) => e.lane === "bot").length;
  const shown = who === "all" ? entries : entries.filter((e) => e.lane === who);

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
  /* The real force-push events now come from the timeline with their own
     timestamps, so this is only the *warning* that the newest one invalidated a
     review — a judgement the raw event cannot make. */
  const forced = d.forcePushedSinceReview ? (
    <div key="forced" className="agx-tiny">
      <span className="agx-node" style={{ color: "var(--warning)" }}>↻</span>
      <span style={{ color: "var(--warning)" }}>The last review was for code that is no longer here — it was force-pushed over</span>
    </div>
  ) : null;

  const composer = <Composer onSend={onComment} busy={busy} placeholder="Leave a comment — markdown works here" sendLabel="Comment" onOpenGithub={() => openExternal(d.url)} stash={`say|${d.url}`} />;

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
        <span>One timeline — reviews, comments, threads and events in the order they happened</span>
        {d.truncated?.comments ? (
          <span style={{ color: "var(--warning)" }}>· showing the most recent {d.truncated.comments}</span>
        ) : null}
        <span className="flex-1" />
        {lanes.bots.length > 0 && (
          <Btn small onClick={() => onRaw(!raw)}>
            {raw ? "Digest automation" : `Show automation in full · ${kb} KB`}
          </Btn>
        )}
        <Btn small onClick={() => setNewest(false)} primary={!newest}>Oldest</Btn>
        <Btn small onClick={() => setNewest(true)} primary={newest}>Newest</Btn>
      </div>
      {/* Whose remarks. On a real pull request the machines outnumber the people
          two to one, and the review that blocks the merge is somewhere under
          forty coverage reports — "Humans" is the whole reason this tab is
          readable. Counts are on the buttons because an empty result should be
          predictable before it is clicked, not a surprise after — and a
          "Humans 0" is the most useful thing this row can say, so it shows
          wherever there is automation at all rather than only where both sides
          spoke. */}
      {botCount > 0 && (
        <div className="flex mb-3 rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          {([["all", "All", humanCount + botCount], ["human", "Humans", humanCount], ["bot", "Bots", botCount]] as const).map(([id, label, n]) => (
            <button key={id} onClick={() => setWho(id)}
              className="agx-btn flex-1 text-[10.5px] py-1.5 flex items-center justify-center gap-1.5"
              style={{
                color: who === id ? "var(--text)" : "var(--text3)",
                background: who === id ? "color-mix(in srgb, var(--border) 30%, transparent)" : "transparent",
              }}>
              {label}<span className="tabular-nums opacity-70">{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="agx-tl">
        {!newest && opened}
        {newest && forced}
        {shown.map((e) => (
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
function Composer({ onSend, busy, placeholder, sendLabel, sendTitle, quiet, onOpenGithub, initial, autoFocus, secondary, stash }: {
  onSend: (body: string) => Promise<boolean>; busy: boolean; placeholder: string; sendLabel: string;
  /** What the main button promises, when the label alone cannot say it. */
  sendTitle?: string;
  /** Do not fill the main button. For a pair of equally weighted outcomes,
   *  where filling one is a claim about which you meant. */
  quiet?: boolean;
  /** A second way to send the same text. On a line comment that is "post this
   *  one now" beside "hold it for the review" — two outcomes GitHub offers at
   *  the box, and which this had collapsed into one. */
  secondary?: { label: string; title?: string; onSend: (body: string) => Promise<boolean> };
  /** Opens this pull request on GitHub — the only place an image can actually
   *  be attached. */
  onOpenGithub?: () => void;
  /** Seed text — e.g. a ```suggestion block prefilled with the line. */
  initial?: string;
  /** Focus the textarea on mount — for a composer that opened on a click. */
  autoFocus?: boolean;
  /** Where to keep the text if it is never sent. Given a key, everything typed
   *  here survives the box being closed, the tab being changed and the app
   *  being rebuilt, and comes back the next time this same box is opened. */
  stash?: string;
}) {
  const [text, setText] = useState(() => (stash ? readStash(stash) : "") || initial || "");
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Was there something here when the box opened? Worth saying — text that
   *  reappears without explanation reads as a bug, not as a rescue. */
  const [restored, setRestored] = useState(() => !!(stash && readStash(stash).trim()));
  useEffect(() => { if (stash) writeStash(stash, text); }, [stash, text]);

  // `initial` can arrive AFTER the box is open: "± Suggest" prefills a
  // suggestion block into a composer that is already there. useState reads its
  // argument once, so without this the button did nothing whatsoever.
  const seeded = useRef(initial);
  useEffect(() => {
    if (initial == null || initial === seeded.current) return;
    seeded.current = initial;
    // Appended, not substituted: whatever you had already typed about the line
    // is the reason you are suggesting a change to it.
    setText((t) => (t.trim() ? `${t.replace(/\n+$/, "")}\n\n${initial}` : initial));
  }, [initial]);

  /**
   * `@`, `#` and `:` complete.
   *
   * Typing a collaborator's login or an issue number from memory means leaving
   * the panel to look it up, which is exactly the trip this is meant to save.
   * The trigger is the token immediately before the caret; Enter or Tab takes
   * the highlighted match, Escape drops the menu without touching the text.
   */
  const mentions = useContext(MentionCtx);
  const [ac, setAc] = useState<{ kind: "@" | "#" | ":"; q: string; at: number } | null>(null);
  const [acIdx, setAcIdx] = useState(0);

  type AcItem = { insert: string; label: string; hint?: string };
  const matches = useMemo<AcItem[]>(() => {
    if (!ac) return [];
    const q = ac.q.toLowerCase();
    if (ac.kind === "@") {
      return (mentions?.users ?? [])
        .filter((u) => u.toLowerCase().includes(q))
        .slice(0, 8).map((u) => ({ insert: `@${u} `, label: u }));
    }
    if (ac.kind === "#") {
      return (mentions?.issues ?? [])
        .filter((i) => String(i.number).startsWith(q) || i.title.toLowerCase().includes(q))
        .slice(0, 8).map((i) => ({ insert: `#${i.number} `, label: `#${i.number}`, hint: i.title.slice(0, 44) }));
    }
    return Object.keys(EMOJI_NAMES).filter((n) => n.startsWith(q)).slice(0, 8)
      .map((n) => ({ insert: `:${n}: `, label: `${EMOJI_NAMES[n]}  :${n}:` }));
  }, [ac, mentions]);

  const onType = (v: string, caret: number) => {
    setText(v);
    // Only the token the caret is sitting in, and only at a word boundary —
    // an email address must not open a mention menu.
    const before = v.slice(0, caret);
    const m = /(^|[\s(])([@#:])([\w.-]*)$/.exec(before);
    if (!m) { setAc(null); return; }
    setAc({ kind: m[2] as "@", q: m[3] ?? "", at: caret - (m[3]?.length ?? 0) - 1 });
    setAcIdx(0);
  };

  const take = (i: number) => {
    const pick = matches[i];
    if (!ac || !pick) return;
    const next = text.slice(0, ac.at) + pick.insert + text.slice(ac.at + 1 + ac.q.length);
    setText(next);
    setAc(null);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      const pos = ac.at + pick.insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /**
   * Files dropped or pasted into the composer.
   *
   * A text file is inserted as a fenced code block, which is what you wanted it
   * for and needs nobody's permission. An image cannot be: GitHub has no public
   * attachment-upload API — their paperclip is web-only, and there is no gist
   * mutation or attachments endpoint to stand in for it (checked, not assumed).
   * Rather than invent a place to put the bytes (committing screenshots into the
   * repository is not a favour), it says so and offers the one thing that does
   * work: attaching it on GitHub itself.
   */
  const [imageNote, setImageNote] = useState<string | null>(null);
  const TEXTY = /\.(md|txt|log|json|jsonc|ya?ml|toml|ini|csv|tsv|diff|patch|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|html?|css|scss|xml|svg)$/i;

  const takeFiles = async (files: File[]) => {
    if (!files.length) return;
    const image = files.find((f) => f.type.startsWith("image/"));
    if (image) {
      setImageNote(image.name);
      return;
    }
    const parts: string[] = [];
    for (const f of files.slice(0, 4)) {
      if (!TEXTY.test(f.name) && !f.type.startsWith("text/")) continue;
      // A composer is not a file host: enough to quote, not enough to hang the
      // panel pasting a 40MB log.
      const body = (await f.text()).slice(0, 60_000);
      const lang = (f.name.split(".").pop() ?? "").toLowerCase();
      parts.push(`**${f.name}**\n\n\`\`\`${lang}\n${body}\n\`\`\``);
    }
    if (!parts.length) { setImageNote(files[0]?.name ?? "that file"); return; }
    setText((t) => (t ? `${t}\n\n` : "") + parts.join("\n\n"));
    setImageNote(null);
  };

  /** `which` lets the second button reuse everything around sending — the
   *  guard, the spinner, the clear-on-success — instead of a copy of it that
   *  drifts. */
  const send = async (which: (body: string) => Promise<boolean> = onSend) => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await which(text);
    setSending(false);
    if (ok) { setText(""); setPreview(false); }
  };

  return (
    <div className="rounded-lg overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void takeFiles([...e.dataTransfer.files]); }}
      onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); void takeFiles(fs); } }}
      style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
        <Btn onClick={() => setPreview(false)} small primary={!preview}>Write</Btn>
        <Btn onClick={() => setPreview(true)} small primary={preview}>Preview</Btn>
      </div>
      {imageNote && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[10.5px]"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <span className="min-w-0 truncate">
            <b>{imageNote}</b> can't be attached from here — GitHub has no public upload API for attachments.
          </span>
          {onOpenGithub && (
            <button onClick={onOpenGithub} className="agx-btn ml-auto shrink-0 px-2 py-0.5 rounded"
              style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>Attach on GitHub ↗</button>
          )}
          <button onClick={() => setImageNote(null)} className="agx-btn shrink-0 px-1" style={{ color: "var(--text3)" }} aria-label="Dismiss">×</button>
        </div>
      )}
      {restored && (
        <div className="flex items-center gap-2 px-2.5 py-1 text-[10px]"
          style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 10%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <span>Picked up where you left off — this was never sent.</span>
          <button onClick={() => setRestored(false)} className="agx-btn ml-auto shrink-0 px-1" style={{ color: "var(--text3)" }} aria-label="Dismiss">×</button>
        </div>
      )}
      {preview ? (
        <div className="p-3 min-h-[80px]">{text.trim() ? <Md body={text} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}</div>
      ) : (
        <div className="relative">
          <textarea
            ref={taRef}
            value={text}
            autoFocus={autoFocus}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            rows={4} placeholder={placeholder}
            onKeyDown={(e) => {
              if (ac && matches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setAcIdx((i) => (i + 1) % matches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setAcIdx((i) => (i - 1 + matches.length) % matches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); take(acIdx); return; }
                if (e.key === "Escape") { e.preventDefault(); setAc(null); return; }
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
            className="w-full p-3 text-[11.5px] outline-none resize-y bg-transparent agx-scroll"
            style={{ color: "var(--text)", lineHeight: 1.6 }}
          />
          {ac && matches.length > 0 && (
            <div className="absolute left-3 bottom-2 z-20 rounded-lg overflow-hidden"
              style={{ background: "color-mix(in srgb, var(--bg2) 97%, black)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", boxShadow: "0 14px 34px -16px rgba(0,0,0,.75)" }}>
              {matches.map((m, i) => (
                <button key={m.label} onMouseEnter={() => setAcIdx(i)} onClick={() => take(i)}
                  className="agx-btn w-full text-left flex items-center gap-2 px-2.5 py-1 text-[11px]"
                  style={{ background: i === acIdx ? "color-mix(in srgb, var(--primary) 22%, transparent)" : "transparent", color: "var(--text2)" }}>
                  <span>{m.label}</span>
                  {m.hint && <span className="truncate text-[10px]" style={{ color: "var(--text3)" }}>{m.hint}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-2.5 py-2"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
        {/* With two outcomes, "to send" stops being an answer. The shortcut goes to
            the reversible one on purpose: a queued comment can be dropped before
            the review is submitted, and a posted one has already notified
            somebody. */}
        <span className="text-[10px]" style={{ color: "var(--text2)" }}>
          Markdown · <b>@</b> people · <b>#</b> issues · <b>:</b> emoji · drop a text file · ⌘↵ {secondary ? `for ${sendLabel.toLowerCase()}` : "to send"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {secondary && (
            <Btn onClick={() => send(secondary.onSend)} disabled={sending || busy || !text.trim()} small
              title={!text.trim() ? "Write something first" : secondary.title}>
              {secondary.label}
            </Btn>
          )}
          <Btn onClick={() => send()} disabled={sending || busy || !text.trim()} primary={!quiet} small
            title={!text.trim() ? "Write something first" : sendTitle}>
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

/**
 * One job's log, folded by its own step markers.
 *
 * GitHub Actions writes `##[group]` / `##[endgroup]` around each step and
 * stamps every line with an ISO timestamp. Folding on the first and stripping
 * the second is the difference between a wall of two thousand lines and a list
 * of steps you can open — and the failing step opens itself, because that is
 * the one you came for.
 */
function JobLog({ root, name, jobs }: { root: string; name: string; jobs: PrCheckJob[] }) {
  // Match the check to its job by name; GitHub names them the same thing.
  const job = useMemo(() => jobs.find((j) => j.name === name) ?? jobs.find((j) => name.includes(j.name)), [jobs, name]);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open || !job || text !== null) return;
    let live = true;
    api.prJobLog(root, job.id)
      .then((r) => { if (!live) return; if (r.ok) setText(r.text ?? ""); else setErr(r.error || "Could not read the log"); })
      .catch(() => { if (live) setErr("Could not reach the server"); });
    return () => { live = false; };
  }, [open, job, root, text]);

  const steps = useMemo(() => {
    if (!text) return [];
    const out: { title: string; lines: string[]; failed: boolean }[] = [];
    let cur: { title: string; lines: string[]; failed: boolean } | null = null;
    for (const raw of text.split("\n")) {
      // Strip the timestamp GitHub prefixes to every single line.
      const line = raw.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "");
      const g = line.match(/^##\[group\](.*)$/);
      if (g) { if (cur) out.push(cur); cur = { title: g[1] || "step", lines: [], failed: false }; continue; }
      if (/^##\[endgroup\]/.test(line)) { if (cur) { out.push(cur); cur = null; } continue; }
      const target = cur ?? (out[out.length - 1] && !cur ? null : null);
      if (/^##\[error\]/.test(line) && cur) cur.failed = true;
      if (cur) cur.lines.push(line);
      else if (line.trim()) {
        if (!out.length || out[out.length - 1]!.title !== "output") out.push({ title: "output", lines: [], failed: false });
        out[out.length - 1]!.lines.push(line);
        if (/^##\[error\]/.test(line)) out[out.length - 1]!.failed = true;
      }
      void target;
    }
    if (cur) out.push(cur);
    return out;
  }, [text]);

  // The failing step opens itself.
  useEffect(() => {
    const bad = steps.findIndex((st) => st.failed);
    if (bad >= 0) setOpenSteps((cur) => (cur.has(bad) ? cur : new Set([...cur, bad])));
  }, [steps]);

  if (!job) return null;
  return (
    <div className="px-2.5 pb-2">
      <button onClick={() => setOpen((v) => !v)} className="agx-btn text-[10px] px-2 py-0.5 rounded"
        style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>
        {open ? "▾ Hide log" : "▸ Show log"}
      </button>
      {open && (
        <div className="mt-1.5 rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
          {err ? <div className="p-2 text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>
            : text === null ? <div className="p-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Reading the log…</div>
            : steps.length === 0 ? <div className="p-2 text-[10.5px]" style={{ color: "var(--text3)" }}>The log is empty.</div>
            : steps.map((st, i) => {
              const on = openSteps.has(i);
              return (
                <div key={i} style={i ? { borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" } : undefined}>
                  <button onClick={() => setOpenSteps((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    className="agx-btn w-full text-left flex items-center gap-2 px-2 py-1 text-[10.5px]"
                    style={{ background: st.failed ? "color-mix(in srgb, var(--error) 10%, transparent)" : "transparent" }}>
                    <span className="text-[9px]" style={{ color: "var(--text3)" }}>{on ? "▾" : "▸"}</span>
                    <span className="truncate" style={{ color: st.failed ? "var(--error)" : "var(--text2)" }}>{st.title}</span>
                    <span className="ml-auto tabular-nums text-[9.5px]" style={{ color: "var(--text3)" }}>{st.lines.length}</span>
                  </button>
                  {on && (
                    <pre className="overflow-x-auto text-[10px] max-h-80 agx-scroll px-2 py-1"
                      style={{ ...CODE_FONT_STYLE, color: "var(--text3)", background: "var(--bg)" }}>{st.lines.join("\n")}</pre>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function Checks({ d, root, jobs, onRerun, onRerunJobs, onAsk, busy }: { d: PrDetail; root: string; jobs: PrCheckJob[]; onRerun: () => void; onRerunJobs?: (what: "all" | "failed" | "job", id: string) => void; onAsk?: (check: PrCheck) => void; busy: boolean }) {
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
      <div className="flex items-center gap-3 p-3 rounded-lg" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
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
          <div key={name} className="rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
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
                <div key={id} style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 11%, transparent)", background: bad ? "color-mix(in srgb, var(--error) 7%, transparent)" : undefined }}>
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
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)" }}>Open run ↗</a>
                      )}
                      <Btn onClick={onRerun} disabled={busy} small title="Re-run every failing check on this pull request">↻ Re-run failed</Btn>
                      {/* GitHub offers all three, and "the whole run failed
                          again for one flaky job" is exactly when you want the
                          single-job one. */}
                      {(() => {
                        const job = jobs.find((j) => j.name === k.name) ?? jobs.find((j) => k.name.includes(j.name));
                        if (!job || !onRerunJobs) return null;
                        return (
                          <>
                            <Btn onClick={() => onRerunJobs("job", job.id)} disabled={busy} small title={`Re-run only ${job.name}`}>↻ This job</Btn>
                            <Btn onClick={() => onRerunJobs("all", job.runId)} disabled={busy} small title="Re-run every job in this run, passing ones included">↻ All jobs</Btn>
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {/* The log, here. It used to say "the log lives on GitHub" and
                      send you to a browser for the one thing you opened the
                      check to read. */}
                  {expanded && <JobLog root={root} name={k.name} jobs={jobs} />}
                </div>
              );
            })}
          </div>
        );
      })}

      {skippedCount > 0 && (
        <button onClick={() => setShowSkipped((v) => !v)} className="text-[10px] px-2.5 py-1.5 rounded self-start"
          style={{ color: "var(--text2)", border: "1px dashed color-mix(in srgb, var(--text) 24%, transparent)" }}>
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
function ReviewTab({ d, drafts, seen, busy, draft, onDraft, onDrop, onSubmit, onGoFiles }: {
  d: PrDetail; drafts: DraftComment[]; seen: number; busy: boolean;
  /** The unsent review, held by the panel and written to storage — not state of
   *  this tab, which stops existing the moment you go and look at Files. */
  draft: ReviewDraft; onDraft: (patch: Partial<ReviewDraft>) => void;
  onDrop: (i: number) => void;
  onSubmit: (verb: "approve" | "request_changes" | "comment", body: string) => void;
  onGoFiles: () => void;
}) {
  const verb = draft.verb;
  const setVerb = (v: ReviewDraft["verb"]) => onDraft({ verb: v });
  const body = draft.body;
  const setBody = (b: string) => onDraft({ body: b });
  const [preview, setPreview] = useState(false);
  /** Which queued comment is open. One at a time on purpose: the row of chips
   *  is the thing that has to stay a row, and opening every remark at once is
   *  the layout this replaced. */
  const [openDraft, setOpenDraft] = useState<number | null>(null);
  // Dropping one renumbers the rest, so an index held across that change points
  // at somebody else's remark. Closed whenever the queue changes length.
  useEffect(() => { setOpenDraft(null); }, [drafts.length]);
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

      {/* Full width, now that it is a strip rather than a form. The cap was
          right for the old stacked layout — a five-row field and three cards
          spread across a 1900px window put a label and its input at opposite
          ends of the desk. This one has nothing to spread: the chips fill a row
          and wrap, the verdict stays its own size, and the send goes to the far
          edge where the eye ends up anyway. */}
      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
          style={{ background: "color-mix(in srgb, var(--border) 12%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--text) 11%, transparent)" }}>
          <b style={{ color: "var(--text)", fontWeight: 500 }}>Finish your review</b>
          <span style={{ color: "var(--text3)" }}>#{d.number}</span>
          <button onClick={onGoFiles} className="ml-auto tabular-nums text-[10px]" style={{ color: seen < d.files.length ? "var(--primary)" : "var(--text3)" }}>
            {seen}/{d.files.length} files viewed
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2.5">
          {/* Queued comments as chips, one open at a time.
              Listed in full, this panel grew with the review: eleven cards and
              the verdict was a scroll away from the evidence it is about. A
              chip says where a remark landed — which is what you check when
              scanning — and opening one is how you re-read it. */}
          {drafts.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider shrink-0 mr-1" style={{ color: "var(--warning)" }}>Pending</span>
                {drafts.map((c, i) => {
                  const on = openDraft === i;
                  const where = `${c.path.split("/").pop()}:${c.startLine && c.startLine !== c.line ? `${c.startLine}–${c.line}` : c.line}`;
                  return (
                    <button key={i} onClick={() => setOpenDraft(on ? null : i)} aria-expanded={on}
                      // The full path in the title: the chip is short because a
                      // row of them has to stay a row, and two files in a pull
                      // request are called models.py more often than not.
                      title={`${c.path}:${c.line}`}
                      className="agx-btn text-[10.5px] px-2 py-0.5 rounded-full shrink-0"
                      style={{
                        color: "var(--warning)",
                        border: `1px ${on ? "solid" : "dashed"} color-mix(in srgb, var(--warning) 55%, transparent)`,
                        background: on ? "color-mix(in srgb, var(--warning) 16%, transparent)" : "transparent",
                        ...CODE_FONT_STYLE,
                      }}>
                      {where} {on ? "▴" : "▾"}
                    </button>
                  );
                })}
              </div>
              {openDraft != null && drafts[openDraft] && (
                <div className="rounded-lg overflow-hidden text-[11.5px]" style={{
                  background: "var(--bg2)",
                  border: "1px dashed color-mix(in srgb, var(--warning) 55%, transparent)",
                }}>
                  <div className="px-2.5 py-1 flex items-center gap-2 text-[10px]"
                    style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--warning)" }}>
                    <span className="min-w-0 truncate" style={{ ...CODE_FONT_STYLE }}>
                      {drafts[openDraft].path}:{drafts[openDraft].startLine && drafts[openDraft].startLine !== drafts[openDraft].line
                        ? `${drafts[openDraft].startLine}–${drafts[openDraft].line}` : drafts[openDraft].line}
                    </span>
                    <button onClick={() => { const i = openDraft; setOpenDraft(null); onDrop(i); }}
                      title="Discard this pending comment"
                      className="agx-btn ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px]"
                      style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}>Drop</button>
                  </div>
                  <div className="px-2.5 py-2"><Md body={drafts[openDraft].body} /></div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
              No line comments queued. Open <button onClick={onGoFiles} style={{ color: "var(--primary)" }}>files</button> and
              use the “+” on a line to attach one.
            </div>
          )}

          {/* The verdict and the send, on one row. A three-way switch says these
              are one choice; three stacked cards took six rows to say the same
              thing and pushed the button that ends the review off the fold. */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>
              {([
                ["approve", "✓ Approve", "Submit and mark the pull request approved.", "var(--success)"],
                ["request_changes", "✕ Request changes", "Submit and block the merge until they land.", "var(--error)"],
                ["comment", "💬 Comment", "Submit without a verdict.", "var(--text)"],
              ] as const).map(([id, label, hint, tint], n) => {
                const on = verb === id;
                const off = id !== "comment" && d.viewerDidAuthor;
                return (
                  <button key={id} onClick={() => setVerb(id)} disabled={off} aria-pressed={on}
                    title={off ? "GitHub does not let you approve or block your own pull request" : hint}
                    className="agx-btn text-[11px] px-3 py-1.5 whitespace-nowrap"
                    style={{
                      color: on ? tint : "var(--text2)",
                      fontWeight: on ? 650 : 400,
                      background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                      borderLeft: n === 0 ? undefined : "1px solid color-mix(in srgb, var(--text) 14%, transparent)",
                      boxShadow: on ? "inset 0 -2px 0 var(--primary)" : undefined,
                      opacity: off ? 0.4 : 1, cursor: off ? "not-allowed" : "pointer",
                    }}>{label}</button>
                );
              })}
            </div>
            <span className="ml-auto">
              <Btn onClick={() => onSubmit(verb, body)} disabled={busy || (verb !== "approve" && nothing)} primary
                title={verb !== "approve" && nothing ? "Say something, or queue a line comment" : undefined}>Submit review</Btn>
            </span>
          </div>

          {/* Optional, and it says so. The note is the one part of a review you
              can leave out — the comments already carry the substance — and a
              five-row box with no label implied the opposite. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {(["write", "preview"] as const).map((m) => (
                <button key={m} onClick={() => setPreview(m === "preview")} className="text-[10.5px] px-2 py-0.5 rounded"
                  style={{
                    color: (m === "preview") === preview ? "var(--text)" : "var(--text3)",
                    background: (m === "preview") === preview ? "color-mix(in srgb, var(--text) 10%, transparent)" : "transparent",
                  }}>{m === "preview" ? "Preview" : "Write"}</button>
              ))}
              <span className="ml-auto text-[10px]" style={{ color: "var(--text3)" }}>
                {verb !== "approve" && nothing
                  ? "Say something, or queue a line comment from Files."
                  : drafts.length
                    ? `${drafts.length} line comment${drafts.length === 1 ? "" : "s"} go with it — one notification, not ${drafts.length + 1}.`
                    : "Posted publicly to your team."}
              </span>
            </div>
            {preview ? (
              <div className="rounded-md p-2.5 min-h-[56px]" style={{ border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
                {body.trim() ? <Md body={body} /> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>Nothing to preview.</span>}
              </div>
            ) : (
              /* Full width, like everything else in the strip. A reading
                 measure was the right instinct and the wrong place for it: the
                 card reaches the edge and a field stopping short of it reads as
                 a mistake, not as care. A summary is a line or two anyway. */
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2}
                placeholder="Summary — optional, markdown works here."
                className="w-full rounded-md p-2.5 text-[11.5px] resize-y" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

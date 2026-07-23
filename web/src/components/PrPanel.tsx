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

type Filter = "mine" | "review" | "all";
type Tab = "overview" | "conversation" | "commits" | "files" | "checks" | "review";

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: "mine", label: "mine", hint: "pull requests you opened" },
  { id: "review", label: "review", hint: "waiting on your review" },
  { id: "all", label: "all", hint: "every open pull request" },
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

function Btn({ children, onClick, disabled, danger, primary, ok, title, small }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  danger?: boolean; primary?: boolean; ok?: boolean; title?: string; small?: boolean;
}) {
  const edge = danger ? "var(--error)" : ok ? "var(--success)" : primary ? "var(--primary)" : "var(--border)";
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`rounded disabled:opacity-40 ${small ? "text-[10px] px-2 py-0.5" : "text-[10.5px] px-2.5 py-1"}`}
      style={{
        color: primary ? "var(--bg)" : danger ? "var(--error)" : ok ? "var(--success)" : "var(--text2)",
        background: primary ? "var(--primary)" : "transparent",
        border: `1px solid color-mix(in srgb, ${edge} ${primary ? 100 : 50}%, transparent)`,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: primary ? 500 : 400,
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
.agx-md{max-width:78ch;margin:0 auto;line-height:1.7;font-size:12.5px;color:var(--text2)}
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
  if (b.kind === "code") return <pre><code>{b.text}</code></pre>;
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
          title={`comment on line ${target}`}>+ comment</button>;
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
        {p.isCurrentBranch && <Chip text="here" tint="var(--primary)" title="this checkout is on that branch" />}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 text-[10px]" style={{ color: "var(--text3)" }}>
        <Dot tint={p.checksLoaded === false ? "var(--text3)" : stateTint(p)}
          title={p.checksLoaded === false ? "check states are still loading" : `${c.success} passed · ${c.failure} failed · ${c.skipped} skipped · ${c.pending} running`} />
        <span className="tabular-nums">
          {/* Not yet fetched is not the same as none. Saying "no checks" here
              would be a claim about the repository rather than about us. */}
          {p.checksLoaded === false ? "checks…"
            : c.total === 0 ? "no checks"
            : c.pending > 0 ? `${c.total - c.pending}/${c.total}`
            : c.failure > 0 ? `${c.failure} failing` : "green"}
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
  const [filter, setFilter] = useState<Filter>("mine");
  // A per-tab search box. Cleared when the scope changes so each tab (mine /
  // review / all) starts fresh — "all" can be hundreds of rows, and finding one
  // by number, title or author beats scrolling.
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
      else { setDetail(null); setDetailErr(r.error || "could not load this pull request"); }
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
  const visiblePrs = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    if (!q) return prs;
    return prs.filter((p) =>
      String(p.number).includes(q) ||
      p.title.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q));
  }, [prs, query]);

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
      input: { label: "Comment", placeholder: "what needs to change here…" },
    });
    if (!body?.trim() || !key) return;
    setDrafts((cur) => {
      const next = { ...cur, [key]: [...(cur[key] ?? []), { path, line, body: body.trim() }] };
      saveMap(DRAFT_KEY, next);
      return next;
    });
    flash(true, `queued — ${(myDrafts.length + 1)} pending comment${myDrafts.length ? "s" : ""}`);
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
    const ok = await act("review", () => api.prReviewWith(root, detail.number, verb, body, myDrafts));
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
    await act("merge", () => api.prMerge(root, detail.number, "squash", { deleteBranch: true, headSha: head }));
  };

  const doClose = async () => {
    if (!detail) return;
    const ok = await ask({
      title: `Close #${detail.number}?`,
      body: `${detail.title}\n\nClosed without merging. You can reopen it afterwards.`,
      confirmLabel: "Close pull request", danger: true,
    });
    if (!ok) return;
    await act("close", () => api.prClose(root, detail.number));
  };

  const doLocalReview = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await api.prLocalReview(root, detail.number);
      if (!r.ok || !r.cwd || !r.prompt) { flash(false, r.error || "could not prepare the review"); return; }
      if (onOpenChatWith) { onOpenChatWith(r.cwd, r.prompt); flash(true, `checked out #${detail.number} — review waiting in chat`); }
      else flash(true, `checked out at ${r.cwd}`);
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  const lanes = useMemo(() => {
    if (!detail) return { humans: [] as PrReview[], botReviews: [] as PrReview[], humanComments: [] as PrComment[], bots: [] as PrComment[] };
    return {
      humans: detail.reviews.filter((r) => !r.isBot && (r.body.trim() || r.state !== "COMMENTED")),
      botReviews: detail.reviews.filter((r) => r.isBot && r.body.trim()),
      humanComments: detail.comments.filter((c) => !c.isBot),
      bots: detail.comments.filter((c) => c.isBot),
    };
  }, [detail]);

  const openThreads = useMemo(() => (detail?.threads ?? []).filter((t) => !t.isResolved), [detail]);
  const d = detail;

  // You cannot review your own pull request — GitHub does not offer it either,
  // and a review control on every row buries the ones actually waiting on you.
  const canReview = !!d && !d.viewerDidAuthor;

  const TABS: { id: Tab; label: string; n?: number; warn?: boolean }[] = d ? [
    { id: "overview", label: "overview" },
    { id: "conversation", label: "conversation", n: lanes.humans.length + lanes.humanComments.length + d.threads.length + lanes.bots.length },
    { id: "commits", label: "commits", n: d.commits.length },
    { id: "files", label: "files", n: d.files.length },
    { id: "checks", label: "checks", n: d.checks.total, warn: d.checks.failure > 0 },
    ...(canReview ? [{ id: "review" as Tab, label: "review", n: myDrafts.length || undefined, warn: d.viewerRequested }] : []),
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
            {listState.loading ? "loading pull requests…"
              : listState.checksPending ? "loading check states…"
              : listState.fetchedAt ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}` : ""}
          </span>
          <Btn onClick={() => loadList(true)} disabled={busy} small>refresh</Btn>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col min-h-0 shrink-0" style={{ width: sidebarW }}>
          <div className="flex gap-1 px-2 py-1.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
            {FILTERS.map((f) => {
              const n = counts[f.id];
              return (
                <button key={f.id} onClick={() => { setFilter(f.id); setQuery(""); }} title={f.hint}
                  className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{
                    color: filter === f.id ? "var(--bg)" : "var(--text2)",
                    background: filter === f.id ? "var(--primary)" : "transparent",
                    border: `1px solid ${filter === f.id ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
                  }}>
                  {f.label}
                  {n ? <span className="ml-1 tabular-nums" style={{ opacity: filter === f.id ? .8 : 1, color: filter === f.id ? undefined : f.id === "review" ? "var(--warning)" : undefined }}>{n}</span> : null}
                </button>
              );
            })}
          </div>
          {repo && prs.length > 0 && (
            <div className="px-2 py-1.5 border-b shrink-0 flex items-center gap-2" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter by #, title or author…"
                className="flex-1 text-[10px] px-2 py-1 rounded bg-transparent min-w-0"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", outline: "none" }} />
              {query.trim() && (
                <span className="text-[9px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{visiblePrs.length} of {prs.length}</span>
              )}
            </div>
          )}
          <div className="flex-1 overflow-y-auto min-h-0 agx-scroll">
            {listState.needsAuth ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                <div style={{ color: "var(--warning)" }}>{listState.error || "the GitHub CLI is not set up"}</div>
                <div className="mt-2">Pull requests come from <code>gh</code>. Install it, run <code>gh auth login</code>, then refresh.</div>
              </div>
            ) : !repo ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>{listState.error || "no GitHub remote on this repository"}</div>
            ) : prs.length === 0 ? (
              listState.loading ? <Skeletons /> : (
                <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                  {filter === "mine" ? "no open pull requests of yours" : filter === "review" ? "nothing waiting on your review" : "no open pull requests"}
                </div>
              )
            ) : visiblePrs.length === 0 ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>no pull requests match “{query.trim()}”</div>
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
                : selected == null ? (listState.loading ? "loading pull requests…" : "select a pull request")
                : `loading #${selected}…`}
            </div>
          ) : (
            <>
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
                  {myDrafts.length > 0 && <Chip text={`${myDrafts.length} pending`} tint="var(--warning)" title="line comments queued but not sent" />}
                  {d.viewerRequested && tab !== "review" && (
                    <Btn onClick={() => setTab("review")} primary small>add your review</Btn>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0 agx-scroll p-3">
                {tab === "overview" && (
                  <Overview
                    d={d} busy={busy} openThreads={openThreads.length}
                    onLocalReview={doLocalReview} onMerge={doMerge} onClose={doClose}
                    onUpdateBranch={() => act("update branch", () => api.prUpdateBranch(root, d.number))}
                    onRerun={() => act("re-run checks", () => api.prRerun(root, d.number))}
                    onAutoMerge={() => act("auto-merge", () => api.prMerge(root, d.number, "squash", { auto: true, deleteBranch: true }))}
                    onDraft={() => act(d.isDraft ? "mark ready" : "convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                    onGoThreads={() => setTab("conversation")}
                  />
                )}

                {tab === "conversation" && (
                  <Conversation
                    d={d} lanes={lanes} raw={rawBots} onRaw={setRawBots} busy={busy}
                    onResolve={(t) => act(t.isResolved ? "unresolve" : "resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                    onReply={async (t) => {
                      const first = t.comments[0];
                      if (typeof first?.databaseId !== "number") return;
                      const body = await askText({ title: `Reply on ${t.path}${t.line ? `:${t.line}` : ""}`, confirmLabel: "Reply", input: { label: "Reply" } });
                      if (!body?.trim()) return;
                      await act("reply", () => api.prReply(root, d.number, first.databaseId as number, body));
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
                          {c.isMerge && <Chip text="merge" tint="var(--text3)" title="trunk catch-up, not work to review" />}
                          <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--text3)" }}>
                            <Avatar login={c.author} size={14} />{c.author}
                          </span>
                        </button>
                        {selCommit === c.oid && (
                          <div className="my-2">
                            {commitBusy ? <div className="text-[10.5px] p-2" style={{ color: "var(--text3)" }}>loading the diff…</div>
                              : commitFiles.length === 0 ? <div className="text-[10.5px] p-2" style={{ color: "var(--text3)" }}>this commit changed nothing textual</div>
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

                {tab === "checks" && <Checks d={d} busy={busy} onRerun={() => act("re-run checks", () => api.prRerun(root, d.number))} />}

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
  BLOCKED: "a required review or check has not passed",
  BEHIND: "the base branch has moved — update the branch first",
  DIRTY: "there are conflicts with the base branch",
  UNSTABLE: "a check is failing",
  DRAFT: "this is a draft",
  HAS_HOOKS: "a repository hook is blocking the merge",
  UNKNOWN: "GitHub has not finished working it out",
};

function Overview({ d, busy, openThreads, onLocalReview, onMerge, onClose, onUpdateBranch, onRerun, onAutoMerge, onDraft, onGoThreads }: {
  d: PrDetail; busy: boolean; openThreads: number;
  onLocalReview: () => void; onMerge: () => void; onClose: () => void; onUpdateBranch: () => void;
  onRerun: () => void; onAutoMerge: () => void; onDraft: () => void; onGoThreads: () => void;
}) {
  const c = d.checks;
  const canMerge = d.mergeState === "CLEAN";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[14px] leading-snug" style={{ color: "var(--text)" }}>{d.title}</div>
        <div className="text-[10.5px] mt-1 flex items-center gap-1.5 flex-wrap" style={{ color: "var(--text3)" }}>
          <Avatar login={d.author} size={15} />
          <span>#{d.number} · {d.author} · {d.headRefName} → {d.baseRefName} ·</span>
          <span style={{ color: "var(--success)" }}>+{d.additions}</span>
          <span style={{ color: "var(--error)" }}>−{d.deletions}</span>
          <span>· {d.changedFiles} files</span>
        </div>
        {d.labels.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-1.5">{d.labels.map((l) => <Chip key={l.name} text={l.name} tint="var(--primary)" />)}</div>
        )}
      </div>

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
              {canMerge ? "nothing is standing in the way" : (MERGE_WHY[d.mergeState] ?? "not mergeable")}
            </span>
          </span>
        </div>

        <div style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
          {d.reviewDecision === "CHANGES_REQUESTED" && (
            <Reason tint="var(--error)" glyph="✕"><b style={{ color: "var(--text)", fontWeight: 500 }}>Changes requested</b> by a reviewer with write access</Reason>
          )}
          {openThreads > 0 && (
            <Reason tint="var(--warning)" glyph="◯" action={<button onClick={onGoThreads} style={{ color: "var(--primary)" }}>go to thread</button>}>
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
          <Btn onClick={onMerge} disabled={busy || !canMerge} primary title={canMerge ? "squash, merge and delete the branch" : MERGE_WHY[d.mergeState]}>squash &amp; merge</Btn>
          <Btn onClick={onAutoMerge} disabled={busy} title="merge automatically once everything passes">merge when green</Btn>
          <Btn onClick={onUpdateBranch} disabled={busy} title="merge the base branch into this one">update branch</Btn>
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy}>re-run failed</Btn>}
          <span className="ml-auto flex gap-1.5">
            <Btn onClick={onDraft} disabled={busy} small>{d.isDraft ? "mark ready" : "to draft"}</Btn>
            <Btn onClick={onClose} disabled={busy} danger small>close</Btn>
          </span>
        </div>
      </section>

      <section>
        <div className="text-[9.5px] uppercase tracking-wider mb-2" style={{ color: "var(--text3)" }}>description</div>
        {d.body.trim() ? <Md body={d.body} /> : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No description.</div>}
      </section>

      <div className="flex gap-1.5 flex-wrap">
        <Btn onClick={onLocalReview} disabled={busy} primary title="check the PR out into a throwaway worktree and review it with the whole repo in context">review locally with Claude</Btn>
        <a href={d.url} target="_blank" rel="noreferrer noopener" className="text-[10.5px] px-2.5 py-1 rounded"
          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>open on GitHub ↗</a>
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
        <Toggle on={split} onClick={() => onSplit(!split)} title="Split / unified">{split ? "split" : "unified"}</Toggle>
        <Toggle on={wrap} onClick={() => onWrap(!wrap)} title="Toggle line wrap">wrap</Toggle>
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

function FilesTab({ d, byPath, loaded, seenFiles, onSeen, sel, onSel, split, wrap, onSplit, onWrap, drafts, onAddDraft }: {
  d: PrDetail; byPath: Map<string, FileChange>; loaded: boolean;
  seenFiles: string[]; onSeen: (p: string) => void;
  sel: string | null; onSel: (p: string | null) => void;
  split: boolean; wrap: boolean; onSplit: (v: boolean) => void; onWrap: (v: boolean) => void;
  drafts: DraftComment[]; onAddDraft: (path: string, line: number) => void;
}) {
  const current = sel ? byPath.get(sel) : undefined;
  const draftsFor = (p: string) => drafts.filter((x) => x.path === p).length;

  return (
    <div className="text-[11px] flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--text3)" }}>
        <span className="tabular-nums">{seenFiles.length}/{d.files.length} reviewed</span>
        <Bar parts={[{ pct: d.files.length ? (seenFiles.length / d.files.length) * 100 : 0, tint: "var(--primary)" }]} />
      </div>

      <div className="rounded overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 28%, transparent)" }}>
        {d.files.map((f) => {
          const done = seenFiles.includes(f.path);
          const open = sel === f.path;
          const nd = draftsFor(f.path);
          return (
            <div key={f.path} className="flex items-center gap-2 px-2 py-1"
              style={{
                borderBottom: "1px solid color-mix(in srgb, var(--border) 18%, transparent)",
                background: open ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
                boxShadow: open ? "inset 2px 0 0 var(--primary)" : undefined,
              }}>
              {/* The tick means "I have read this" — a different intent from
                  "show me this", so it is a different target. */}
              <input type="checkbox" checked={done} onChange={() => onSeen(f.path)}
                style={{ accentColor: "var(--primary)" }} title="mark reviewed" aria-label={`mark ${f.path} reviewed`} />
              <button onClick={() => onSel(open ? null : f.path)} className="flex-1 min-w-0 text-left flex items-center gap-2">
                <span className="shrink-0" style={{ color: "var(--text3)" }}>{open ? "▾" : "▸"}</span>
                <span className="truncate" style={{ color: done ? "var(--text3)" : "var(--text2)", textDecoration: done ? "line-through" : undefined }}>{f.path}</span>
                {f.comments > 0 && <Chip text={`${f.comments} open`} tint="var(--warning)" />}
                {nd > 0 && <Chip text={`${nd} pending`} tint="var(--primary)" title="queued in your review" />}
                <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--success)" }}>+{f.additions}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--error)" }}>−{f.deletions}</span>
              </button>
            </div>
          );
        })}
      </div>

      {sel && (
        <div className="rounded overflow-hidden flex flex-col" style={{ border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", height: 560 }}>
          <DiffToolbar path={sel} add={current?.additions} del={current?.deletions} split={split} wrap={wrap} onSplit={onSplit} onWrap={onWrap}
            right={<span className="text-[10px] mr-1" style={{ color: "var(--text3)" }}>unified shows “+ comment”</span>} />
          <div className="flex-1 min-h-0 flex">
            {!loaded ? <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>loading the diff…</div>
              : current ? <DiffPane file={current} split={split} wrap={wrap} onComment={(line) => onAddDraft(sel, line)} />
              : <div className="p-3 text-[10.5px]" style={{ color: "var(--text3)" }}>no textual diff — binary, renamed, or too large to show</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

/** Out to GitHub, for the one thing the panel does not show — the full history
 *  of an edit, a reaction, the blame behind a line. */
function GhLink({ href, title }: { href: string; title: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={title}
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
          {url && <GhLink href={url} title="open on GitHub" />}
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
        {t.isOutdated && <Chip text="outdated" tint="var(--text3)" title="the code under this comment has changed since" />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {t.isResolved ? <Chip text="resolved" tint="var(--success)" /> : <Chip text="open" tint="var(--warning)" />}
          {t.url && <GhLink href={t.url} title="open this thread on GitHub" />}
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
              {c.url && <GhLink href={c.url} title="open this comment on GitHub" />}
            </span>
          </div>
          <Md body={c.body} />
        </div>
      ))}
      <div className="flex gap-1.5 px-3 py-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 20%, transparent)" }}>
        <Btn onClick={() => onReply(t)} disabled={busy || !canReply} small
          title={canReply ? undefined : "this thread has no comment to reply to"}>reply</Btn>
        <Btn onClick={() => onResolve(t)} disabled={busy} ok={!t.isResolved} small>{t.isResolved ? "unresolve" : "resolve conversation"}</Btn>
      </div>
    </div>
  );
}

function Conversation({ d, lanes, raw, onRaw, onResolve, onReply, busy }: {
  d: PrDetail;
  lanes: { humans: PrReview[]; botReviews: PrReview[]; humanComments: PrComment[]; bots: PrComment[] };
  raw: boolean; onRaw: (v: boolean) => void;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread) => void; busy: boolean;
}) {
  const kb = Math.round(lanes.bots.reduce((n, c) => n + c.body.length, 0) / 1024);
  // Threads whose author never submitted a review of their own — a bot's
  // findings, or a comment left outside a review. They still need a home.
  const reviewAuthors = new Set(lanes.humans.map((r) => r.author));
  const orphanThreads = d.threads.filter((t) => !reviewAuthors.has(t.comments[0]?.author ?? ""));

  return (
    <div className="text-[11px]">
      <Lane label="humans" />
      {lanes.humans.length === 0 && lanes.humanComments.length === 0 && (
        <div style={{ color: "var(--text3)" }}>Nobody has said anything yet.</div>
      )}
      {lanes.humans.map((r, i) => {
        // The line comments that belong to THIS review. GitHub nests them under
        // the review they were submitted with, and that grouping is most of the
        // meaning: a "requested changes" is a verdict, and the threads beneath
        // it are the reasons. Split apart into separate lanes, you get a
        // verdict with no reasons and a pile of reasons with no verdict.
        const mine = d.threads.filter((t) => t.comments[0]?.author === r.author);
        return (
          <div key={`r${i}`} className="mb-2">
            <Card who={r.author} when={ago(r.submittedAt)} url={r.url}
              tone={r.state === "CHANGES_REQUESTED" ? "chg" : r.state === "APPROVED" ? "appr" : undefined}
              chip={r.state === "CHANGES_REQUESTED" ? <Chip text="requested changes" tint="var(--error)" />
                : r.state === "APPROVED" ? <Chip text="approved" tint="var(--success)" /> : undefined}>
              {r.body ? <Md body={r.body} /> : <span style={{ color: "var(--text3)" }}>({r.state.toLowerCase().replace("_", " ")}, no note)</span>}
            </Card>
            {mine.length > 0 && (
              <div className="pl-3 ml-2" style={{ borderLeft: "2px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                {mine.map((t) => <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} busy={busy} />)}
              </div>
            )}
          </div>
        );
      })}
      {lanes.humanComments.map((c) => (
        <Card key={c.id} who={c.author} when={ago(c.createdAt)} url={c.url}><Md body={c.body} /></Card>
      ))}

      {orphanThreads.length > 0 && (
        <>
          <Lane label="line threads" extra={`${orphanThreads.filter((t) => !t.isResolved).length} open of ${orphanThreads.length}`} />
          {orphanThreads.map((t) => <Thread key={t.id} t={t} onResolve={onResolve} onReply={onReply} busy={busy} />)}
        </>
      )}

      <Lane label="automation" extra={lanes.bots.length ? `${lanes.bots.length} comments · ${kb} KB` : undefined} />
      {lanes.botReviews.map((r, i) => (
        <Card key={`br${i}`} who={r.author} when={ago(r.submittedAt)} url={r.url} tone="bot" chip={<Chip text="automation" tint="var(--info)" />}>
          <Md body={r.body} />
        </Card>
      ))}
      {lanes.bots.length > 0 && (
        <>
          <button onClick={() => onRaw(!raw)} className="w-full text-left text-[10px] px-2.5 py-1.5 rounded mb-2"
            style={{ color: "var(--text2)", border: "1px dashed color-mix(in srgb, var(--border) 50%, transparent)" }}>
            <span style={{ color: "var(--primary)" }}>{raw ? "▾" : "▸"}</span>{" "}
            {lanes.bots.length} machine comment{lanes.bots.length === 1 ? "" : "s"} · {kb} KB {raw ? "— hide raw" : "collapsed — show raw"}
          </button>
          {lanes.bots.map((c) => (
            <Card key={c.id} who={c.author} when={ago(c.createdAt)} url={c.url} tone="bot" chip={<Chip text="automation" tint="var(--info)" />}>
              {raw ? <pre className="overflow-x-auto text-[10px] max-h-72 agx-scroll" style={{ ...CODE_FONT_STYLE, color: "var(--text3)" }}>{c.body}</pre>
                : <span style={{ color: "var(--text2)" }}>{c.digest || "(nothing worth pulling out)"}</span>}
            </Card>
          ))}
        </>
      )}
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
  return parts.length > 1 ? parts.slice(0, -1).join(" / ") : "checks";
}

function Checks({ d, onRerun, busy }: { d: PrDetail; onRerun: () => void; busy: boolean }) {
  const c = d.checks;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [showSkipped, setShowSkipped] = useState(false);

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
          {c.failure > 0 && <Btn onClick={onRerun} disabled={busy} small>re-run failed</Btn>}
          <span className="text-[10px]" style={{ color: "var(--text3)" }}>{c.allDone ? "notified once, not " + c.total : "you will be told once, at the end"}</span>
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
            {isOpen && list.map((k, i) => (
              <div key={`${k.name}-${i}`} className="flex items-center gap-2 px-2.5 py-1"
                style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 16%, transparent)" }}>
                <span className="shrink-0 w-3 text-center" style={{ color: CHECK_TINT[k.state] }}>{CHECK_GLYPH[k.state]}</span>
                <span className="truncate" style={{ color: k.state === "skipped" || k.state === "neutral" ? "var(--text3)" : "var(--text2)" }}>
                  {k.name.startsWith(name) ? k.name.slice(name.length).replace(/^\s*\/\s*/, "") || k.name : k.name}
                </span>
                <span className="ml-auto shrink-0 text-[9.5px] uppercase tracking-wide" style={{ color: CHECK_TINT[k.state] }}>{k.state}</span>
                {k.url && <a href={k.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>log ↗</a>}
              </div>
            ))}
          </div>
        );
      })}

      {skippedCount > 0 && (
        <button onClick={() => setShowSkipped((v) => !v)} className="text-[10px] px-2.5 py-1.5 rounded self-start"
          style={{ color: "var(--text2)", border: "1px dashed color-mix(in srgb, var(--border) 50%, transparent)" }}>
          {showSkipped ? "hide" : "show"} {skippedCount} skipped
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
                  <button onClick={() => onDrop(i)} className="shrink-0 text-[10px]" style={{ color: "var(--error)" }}>drop</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
              No line comments queued. Open <button onClick={onGoFiles} style={{ color: "var(--primary)" }}>files</button> and
              use “+ comment” on a hunk to attach one to a line.
            </div>
          )}

          <div className="flex gap-0 text-[10.5px]" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
            {(["write", "preview"] as const).map((m) => (
              <button key={m} onClick={() => setPreview(m === "preview")} className="px-3 py-1"
                style={{
                  color: (m === "preview") === preview ? "var(--text)" : "var(--text3)",
                  borderBottom: `2px solid ${(m === "preview") === preview ? "var(--primary)" : "transparent"}`,
                }}>{m}</button>
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

          <div className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text2)" }}>
            {([
              ["comment", "Comment", "General feedback without explicit approval.", "var(--text)"],
              ["approve", "Approve", "Submit feedback and approve merging these changes.", "var(--success)"],
              ["request_changes", "Request changes", "Submit feedback that must be addressed first.", "var(--error)"],
            ] as const).map(([id, label, hint, tint]) => (
              <label key={id} className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="agx-review-verb" checked={verb === id} onChange={() => setVerb(id)}
                  style={{ accentColor: "var(--primary)", marginTop: 3 }} />
                <span>
                  <b style={{ color: tint, fontWeight: 500 }}>{label}</b>
                  <span className="block text-[10.5px]" style={{ color: "var(--text3)" }}>{hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px]" style={{ color: "var(--text3)" }}>
              Posted publicly to your team{drafts.length ? `, with ${drafts.length} line comment${drafts.length === 1 ? "" : "s"}` : ""}.
            </span>
            <span className="ml-auto">
              <Btn onClick={() => onSubmit(verb, body)} disabled={busy || (verb !== "approve" && nothing)} primary
                title={verb !== "approve" && nothing ? "say something, or queue a line comment" : undefined}>submit review</Btn>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Pull requests, so a review does not mean opening a browser.
//
// Two things shape this panel more than anything else, both learned from real
// PRs rather than guessed:
//
// 1. The conversation is mostly machines. On a real review, four issue comments
//    were all from CI and one coverage table alone was 46,551 characters, while
//    the single human review that blocked the merge sat at the bottom. So the
//    conversation is three lanes — humans, line threads, automation — and the
//    machine lane collapses to its digest.
//
// 2. Nothing here waits on the network. `gh` costs a second or more per call
//    and the server has one thread; every read is a cached answer with its age
//    on screen, and a refresh happens behind it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import type {
  PrSummary, PrDetail, PrRepoId, PrThread, PrComment, PrReview, PrCheck, GitRepoRef,
} from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { SCROLLBAR_CSS, CODE_FONT_STYLE } from "./ChangesModal.tsx";

type Filter = "mine" | "review" | "all";
type Tab = "overview" | "conversation" | "commits" | "files" | "checks";

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: "mine", label: "mine", hint: "pull requests you opened" },
  { id: "review", label: "review", hint: "waiting on your review" },
  { id: "all", label: "all", hint: "every open pull request" },
];

const POLL_MS = 20_000;
/** Per-file "I have read this" ticks. Twelve files is two sittings, so it has
 *  to survive a reload — and it is a local opinion, not GitHub state. */
const SEEN_KEY = "agentglass.pr.seen";

function loadSeen(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch { return {}; }
}
function saveSeen(v: Record<string, string[]>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

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
    <span title={title} className="shrink-0 text-[9px] px-1 py-px rounded uppercase tracking-wide"
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 13%, transparent)` }}>{text}</span>
  );
}

/** The human verdict, which is not the same question as whether CI is green. */
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

// ---------------------------------------------------------------------------
// markdown, enough of it
// ---------------------------------------------------------------------------

/**
 * A PR body is markdown with links, checklists, code fences and screenshots,
 * and the screenshots are the point — a review body here routinely carries
 * before/after evidence. Rather than pull in a markdown library for one panel,
 * this renders the subset those bodies actually use.
 *
 * Everything is escaped first and only the recognised constructs are put back,
 * so a body containing raw HTML renders as text rather than as markup. The body
 * is written by anyone who can open a pull request; it is not trusted input.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderInline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code class="px-1 rounded" style="background:color-mix(in srgb,var(--border) 30%,transparent)">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text)">$1</strong>');
  // Links only to http(s) — a markdown link is a place to smuggle javascript:.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, href: string) => `<a href="${href}" target="_blank" rel="noreferrer noopener" style="color:var(--primary)">${text}</a>`);
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    (_m, pre: string, href: string) => `${pre}<a href="${href}" target="_blank" rel="noreferrer noopener" style="color:var(--primary)">${href}</a>`);
  return out;
}

type MdBlock =
  | { kind: "text"; html: string }
  | { kind: "code"; text: string }
  | { kind: "image"; src: string; alt: string };

/** Split a body into what has to render differently: fenced code, images
 *  (which need the proxy), and everything else. */
export function parseBody(body: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const html = buf.map((line) => {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) return `<div style="color:var(--text);font-weight:600;margin-top:.7em">${renderInline(h[2]!)}</div>`;
      const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (task) {
        const done = task[1]!.toLowerCase() === "x";
        return `<div style="display:flex;gap:.4em;color:${done ? "var(--text3)" : "var(--text)"}">` +
          `<span style="color:${done ? "var(--success)" : "var(--warning)"}">${done ? "✔" : "☐"}</span>` +
          `<span>${renderInline(task[2]!)}</span></div>`;
      }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) return `<div style="display:flex;gap:.4em"><span style="color:var(--primary)">·</span><span>${renderInline(li[1]!)}</span></div>`;
      if (!line.trim()) return "<div style='height:.5em'></div>";
      return `<div>${renderInline(line)}</div>`;
    }).join("");
    blocks.push({ kind: "text", html });
    buf = [];
  };

  // `\r?\n`, not `\n`: GitHub bodies are CRLF, and a JS regex `.` matches
  // neither `\n` nor `\r`, so every `(.*)$` rule below silently fails on a line
  // that still carries its carriage return — headings, task boxes and images
  // all render as plain text.
  const lines = (body || "").split(/\r?\n/);
  let fence: string[] | null = null;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (fence) { blocks.push({ kind: "code", text: fence.join("\n") }); fence = null; }
      else { flush(); fence = []; }
      continue;
    }
    if (fence) { fence.push(line); continue; }

    const md = line.match(/^\s*!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/);
    const html = line.match(/<img[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/i);
    if (md) { flush(); blocks.push({ kind: "image", src: md[2]!, alt: md[1]! }); continue; }
    if (html) {
      flush();
      const alt = line.match(/\balt="([^"]*)"/i)?.[1] ?? "";
      blocks.push({ kind: "image", src: html[1]!, alt });
      continue;
    }
    buf.push(line);
  }
  if (fence) blocks.push({ kind: "code", text: fence.join("\n") });
  flush();
  return blocks;
}

function Body({ body }: { body: string }) {
  const blocks = useMemo(() => parseBody(body), [body]);
  return (
    <div className="text-[11.5px] leading-relaxed" style={{ color: "var(--text2)" }}>
      {blocks.map((b, i) => {
        if (b.kind === "code") {
          return (
            <pre key={i} className="my-1.5 p-2 rounded overflow-x-auto text-[10.5px]"
              style={{ ...CODE_FONT_STYLE, background: "var(--bg)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
              {b.text}
            </pre>
          );
        }
        if (b.kind === "image") {
          // Through the server: GitHub's own attachment URLs answer 404 without
          // the token, and these images are the evidence in a review.
          return (
            <figure key={i} className="my-2">
              <img src={api.prAssetUrl(b.src)} alt={b.alt} loading="lazy"
                className="max-w-full rounded" style={{ border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }} />
              {b.alt && <figcaption className="text-[9.5px] mt-1" style={{ color: "var(--text3)" }}>{b.alt}</figcaption>}
            </figure>
          );
        }
        return <div key={i} dangerouslySetInnerHTML={{ __html: b.html }} />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// list row
// ---------------------------------------------------------------------------

function PrRow({ p, active, onSelect }: { p: PrSummary; active: boolean; onSelect: () => void }) {
  const c = p.checks;
  return (
    <button onClick={onSelect}
      className="w-full text-left px-2.5 py-1.5 border-b"
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
        <Dot tint={stateTint(p)} title={`${c.success} passed · ${c.failure} failed · ${c.skipped} skipped · ${c.pending} running`} />
        <span className="tabular-nums">
          {c.total === 0 ? "no checks"
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
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [listState, setListState] = useState<{ fetchedAt: number; loading: boolean; error?: string; needsAuth?: boolean }>({ fetchedAt: 0, loading: false });
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [rawBots, setRawBots] = useState(false);
  const [seen, setSeen] = useState<Record<string, string[]>>(loadSeen);
  const [diff, setDiff] = useState<string>("");
  const detailReq = useRef(0);

  const flash = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4200);
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
    api.prList(root, filter, force).then((r) => {
      setRepo(r.repo);
      setPrs(r.prs);
      setListState({ fetchedAt: r.fetchedAt, loading: r.loading, error: r.error, needsAuth: r.needsAuth });
      setSelected((cur) => (cur && r.prs.some((p) => p.number === cur) ? cur : r.prs[0]?.number ?? null));
    }).catch((e) => setListState({ fetchedAt: 0, loading: false, error: String(e) }));
  }, [root, filter]);

  // Poll the cache, not GitHub. The server refreshes behind these calls, so a
  // 20s tick is a map lookup and the age below the header is the honest answer
  // to "how fresh is this".
  useEffect(() => {
    if (!active || !root) return;
    loadList();
    const t = setInterval(() => loadList(), POLL_MS);
    return () => clearInterval(t);
  }, [active, root, filter, loadList]);

  const loadDetail = useCallback((n: number, force = false) => {
    const req = ++detailReq.current;
    setDetailErr("");
    api.prDetail(root, n, force).then((r) => {
      if (req !== detailReq.current) return; // a later selection already won
      if (r.ok && r.detail) setDetail(r.detail);
      else { setDetail(null); setDetailErr(r.error || "could not load this pull request"); }
    }).catch((e) => { if (req === detailReq.current) setDetailErr(String(e)); });
  }, [root]);

  useEffect(() => {
    if (!active || !root || selected == null) { setDetail(null); return; }
    setDiff("");
    loadDetail(selected);
  }, [active, root, selected, loadDetail]);

  useEffect(() => {
    if (tab !== "files" || !detail || diff || !root) return;
    api.prDiff(root, detail.number).then((r) => setDiff(r.ok ? (r.text || "") : "")).catch(() => {});
  }, [tab, detail, diff, root]);

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

  // --- conversation lanes -------------------------------------------------
  const lanes = useMemo(() => {
    if (!detail) return { humans: [] as PrReview[], bots: [] as PrComment[], botReviews: [] as PrReview[], humanComments: [] as PrComment[] };
    return {
      humans: detail.reviews.filter((r) => !r.isBot && (r.body.trim() || r.state !== "COMMENTED")),
      botReviews: detail.reviews.filter((r) => r.isBot && r.body.trim()),
      humanComments: detail.comments.filter((c) => !c.isBot),
      bots: detail.comments.filter((c) => c.isBot),
    };
  }, [detail]);

  const botBytes = useMemo(() => lanes.bots.reduce((n, c) => n + c.body.length, 0), [lanes.bots]);
  const openThreads = useMemo(() => (detail?.threads ?? []).filter((t) => !t.isResolved), [detail]);

  const seenKey = repo && detail ? `${repo.key}#${detail.number}` : "";
  const seenFiles = seenKey ? (seen[seenKey] ?? []) : [];
  const toggleSeen = (path: string) => {
    if (!seenKey) return;
    setSeen((cur) => {
      const list = new Set(cur[seenKey] ?? []);
      if (list.has(path)) list.delete(path); else list.add(path);
      const next = { ...cur, [seenKey]: [...list] };
      saveSeen(next);
      return next;
    });
  };

  // --- actions ------------------------------------------------------------
  const doReview = async (verb: "approve" | "request_changes" | "comment") => {
    if (!detail) return;
    const noun = verb === "approve" ? "Approve" : verb === "request_changes" ? "Request changes on" : "Comment on";
    const body = await askText({
      title: `${noun} #${detail.number}`,
      body: verb === "approve" ? "A note is optional for an approval." : "This is posted to GitHub and your team can see it.",
      confirmLabel: "Submit review",
      input: { label: "Review body", placeholder: verb === "approve" ? "optional" : "what needs to change…" },
    });
    if (body === null) return;
    await act("review", () => api.prReview(root, detail.number, verb, body));
  };

  const doMerge = async () => {
    if (!detail) return;
    const head = detail.commits[detail.commits.length - 1]?.oid;
    const ok = await ask({
      title: `Merge #${detail.number} into ${detail.baseRefName}?`,
      body: `${detail.title}\n\nSquash and merge, then delete the branch. This is public and cannot be undone from here.` +
        (head ? `\n\nPinned to ${head.slice(0, 8)} — if anyone pushes before this lands, GitHub will refuse rather than merge a commit you have not seen.` : ""),
      confirmLabel: "Squash & merge",
      danger: true,
    });
    if (!ok) return;
    await act("merge", () => api.prMerge(root, detail.number, "squash", { deleteBranch: true, headSha: head }));
  };

  const doClose = async () => {
    if (!detail) return;
    const ok = await ask({
      title: `Close #${detail.number}?`,
      body: `${detail.title}\n\nThe pull request is closed without merging. You can reopen it afterwards.`,
      confirmLabel: "Close pull request",
      danger: true,
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
      if (onOpenChatWith) { onOpenChatWith(r.cwd, r.prompt); flash(true, `checked out #${detail.number} — review running in chat`); }
      else flash(true, `checked out at ${r.cwd}`);
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };

  // --- render -------------------------------------------------------------
  const d = detail;
  const checks = d?.checks;
  const TABS: { id: Tab; label: string; n?: number; warn?: boolean }[] = d ? [
    { id: "overview", label: "overview", warn: d.checklist.some((c) => !c.checked) },
    { id: "conversation", label: "conversation", n: lanes.humans.length + lanes.humanComments.length + d.threads.length + lanes.bots.length },
    { id: "commits", label: "commits", n: d.commits.length },
    { id: "files", label: "files", n: d.files.length },
    { id: "checks", label: "checks", n: d.checks.total, warn: d.checks.failure > 0 },
  ] : [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <style>{SCROLLBAR_CSS}</style>
      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <span className={viewTitleClass} style={{ color: "var(--text)" }}>pr</span>
        {repo && <span className="text-[10px] truncate" style={{ color: "var(--text3)" }}>{repo.nameWithOwner}</span>}
        {repos.length > 1 && (
          <select value={root} onChange={(e) => { setRoot(e.target.value); setSelected(null); setDetail(null); }}
            className="text-[10px] px-1 py-0.5 rounded bg-transparent max-w-[190px]"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
            {repos.map((r) => <option key={r.root} value={r.root} style={{ background: "var(--bg)" }}>{r.root.split("/").pop()}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {toast && (
            <span className="text-[10px] max-w-[340px] truncate" style={{ color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</span>
          )}
          <span className="text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>
            {listState.loading ? "refreshing…" : listState.fetchedAt ? `⟳ ${ago(new Date(listState.fetchedAt).toISOString())}` : ""}
          </span>
          <button onClick={() => loadList(true)} disabled={busy}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>refresh</button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ---- list ---- */}
        <div className="flex flex-col min-h-0 shrink-0" style={{ width: sidebarW }}>
          <div className="flex gap-1 px-2 py-1.5 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} title={f.hint}
                className="text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  color: filter === f.id ? "var(--bg)" : "var(--text2)",
                  background: filter === f.id ? "var(--primary)" : "transparent",
                  border: `1px solid ${filter === f.id ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
                }}>{f.label}{filter === f.id && prs.length > 0 && <span className="ml-1 tabular-nums opacity-75">{prs.length}</span>}</button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 ag-scroll">
            {listState.needsAuth ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                <div style={{ color: "var(--warning)" }}>{listState.error || "the GitHub CLI is not set up"}</div>
                <div className="mt-2">Pull requests come from <code>gh</code>. Install it and run <code>gh auth login</code>, then hit refresh.</div>
              </div>
            ) : !repo ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>{listState.error || "no GitHub remote on this repository"}</div>
            ) : prs.length === 0 ? (
              <div className="p-3 text-[11px]" style={{ color: "var(--text3)" }}>
                {listState.loading ? "loading…" : filter === "mine" ? "no open pull requests of yours" : filter === "review" ? "nothing waiting on your review" : "no open pull requests"}
              </div>
            ) : prs.map((p) => (
              <PrRow key={p.number} p={p} active={p.number === selected} onSelect={() => { setSelected(p.number); setTab("overview"); }} />
            ))}
          </div>
        </div>

        <SidebarGrip />

        {/* ---- detail ---- */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {!d ? (
            <div className="p-4 text-[11.5px]" style={{ color: "var(--text3)" }}>{detailErr || (selected == null ? "select a pull request" : "loading…")}</div>
          ) : (
            <>
              <div className="flex gap-0 border-b shrink-0 overflow-x-auto" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                {TABS.map((t) => (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className="text-[10.5px] px-3 py-1.5 whitespace-nowrap"
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
              </div>

              <div className="flex-1 overflow-y-auto min-h-0 ag-scroll p-3">
                {tab === "overview" && <Overview d={d} onLocalReview={doLocalReview} busy={busy}
                  onMerge={doMerge} onClose={doClose} onUpdateBranch={() => act("update branch", () => api.prUpdateBranch(root, d.number))}
                  onRerun={() => act("re-run checks", () => api.prRerun(root, d.number))}
                  onAutoMerge={() => act("auto-merge", () => api.prMerge(root, d.number, "squash", { auto: true, deleteBranch: true }))}
                  onDraft={() => act(d.isDraft ? "mark ready" : "convert to draft", () => api.prDraft(root, d.number, !d.isDraft))}
                  openThreads={openThreads.length} />}

                {tab === "conversation" && (
                  <Conversation
                    d={d} lanes={lanes} botBytes={botBytes} raw={rawBots} onRaw={setRawBots}
                    onResolve={(t) => act(t.isResolved ? "unresolve" : "resolve", () => api.prSetThreadResolved(root, t.id, !t.isResolved))}
                    onReply={async (t) => {
                      const first = t.comments[0];
                      if (!first) return;
                      const body = await askText({ title: `Reply on ${t.path}${t.line ? `:${t.line}` : ""}`, confirmLabel: "Reply", input: { label: "Reply", placeholder: "…" } });
                      if (body === null || !body.trim()) return;
                      await act("reply", () => api.prReply(root, d.number, Number(first.id), body));
                    }}
                    onReview={doReview} busy={busy}
                  />
                )}

                {tab === "commits" && (
                  <div className="text-[11px]">
                    {d.commits.map((c) => (
                      <div key={c.oid} className="flex items-center gap-2 py-1 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 18%, transparent)", opacity: c.isMerge ? 0.5 : 1 }}>
                        <span className="tabular-nums shrink-0" style={{ ...CODE_FONT_STYLE, color: "var(--primary)" }}>{c.short}</span>
                        <span className="truncate" style={{ color: "var(--text2)" }}>{c.message}</span>
                        {c.isMerge && <Chip text="merge" tint="var(--text3)" title="trunk catch-up, not work to review" />}
                        <span className="ml-auto shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{c.author}</span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === "files" && (
                  <div className="text-[11px]">
                    <div className="flex items-center gap-2 mb-2 text-[10px]" style={{ color: "var(--text3)" }}>
                      <span className="tabular-nums">{seenFiles.length}/{d.files.length} reviewed</span>
                      <Bar parts={[{ pct: d.files.length ? (seenFiles.length / d.files.length) * 100 : 0, tint: "var(--primary)" }]} />
                    </div>
                    {d.files.map((f) => {
                      const done = seenFiles.includes(f.path);
                      return (
                        <label key={f.path} className="flex items-center gap-2 py-1 border-b cursor-pointer"
                          style={{ borderColor: "color-mix(in srgb, var(--border) 18%, transparent)" }}>
                          <input type="checkbox" checked={done} onChange={() => toggleSeen(f.path)} style={{ accentColor: "var(--primary)" }} />
                          <span className="truncate" style={{ color: done ? "var(--text3)" : "var(--text2)", textDecoration: done ? "line-through" : undefined }}>{f.path}</span>
                          {f.comments > 0 && <Chip text={`${f.comments} open`} tint="var(--warning)" />}
                          <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--success)" }}>+{f.additions}</span>
                          <span className="shrink-0 tabular-nums" style={{ color: "var(--error)" }}>−{f.deletions}</span>
                        </label>
                      );
                    })}
                    {diff && (
                      <pre className="mt-3 p-2 rounded overflow-x-auto text-[10.5px] leading-snug"
                        style={{ ...CODE_FONT_STYLE, background: "var(--bg)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", maxHeight: 460 }}>
                        {diff.split("\n").map((l, i) => (
                          <div key={i} style={{
                            color: l.startsWith("+") && !l.startsWith("+++") ? "var(--success)"
                              : l.startsWith("-") && !l.startsWith("---") ? "var(--error)"
                              : l.startsWith("@@") ? "var(--primary)" : "var(--text3)",
                          }}>{l || " "}</div>
                        ))}
                      </pre>
                    )}
                  </div>
                )}

                {tab === "checks" && checks && <Checks d={d} onRerun={() => act("re-run checks", () => api.prRerun(root, d.number))} busy={busy} />}
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

function Overview({ d, busy, openThreads, onLocalReview, onMerge, onClose, onUpdateBranch, onRerun, onAutoMerge, onDraft }: {
  d: PrDetail; busy: boolean; openThreads: number;
  onLocalReview: () => void; onMerge: () => void; onClose: () => void;
  onUpdateBranch: () => void; onRerun: () => void; onAutoMerge: () => void; onDraft: () => void;
}) {
  const done = d.checklist.filter((c) => c.checked).length;
  const open = d.checklist.length - done;
  const c = d.checks;
  const canMerge = d.mergeState === "CLEAN";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[13px]" style={{ color: "var(--text)" }}>{d.title}</div>
        <div className="text-[10px] mt-0.5" style={{ color: "var(--text3)" }}>
          #{d.number} · {d.author} · {d.headRefName} → {d.baseRefName} · +{d.additions} −{d.deletions} · {d.changedFiles} files
        </div>
        {d.labels.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-1.5">
            {d.labels.map((l) => <Chip key={l.name} text={l.name} tint="var(--primary)" />)}
          </div>
        )}
      </div>

      {d.forcePushedSinceReview && (
        <div className="text-[10.5px] px-2 py-1.5 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          The author force-pushed after the last review — that review was for code that is no longer here.
        </div>
      )}

      {/* merge, and why not */}
      <section className="rounded" style={{ border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
        <div className="flex items-center gap-2 px-2 py-1 text-[9.5px] uppercase tracking-wider border-b"
          style={{ color: "var(--text3)", borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
          <span>merge</span>
          <span className="ml-auto" style={{ color: canMerge ? "var(--success)" : "var(--error)" }}>{canMerge ? "ready" : d.mergeState.toLowerCase()}</span>
        </div>
        <div className="p-2 text-[11px]" style={{ color: "var(--text2)" }}>
          {!canMerge && (
            <div className="flex gap-1.5 items-start mb-1">
              <Dot tint="var(--error)" /><span>{MERGE_WHY[d.mergeState] ?? "not mergeable"}</span>
            </div>
          )}
          {d.reviewDecision === "CHANGES_REQUESTED" && (
            <div className="flex gap-1.5 items-start mb-1"><Dot tint="var(--error)" /><span>changes requested</span></div>
          )}
          {openThreads > 0 && (
            <div className="flex gap-1.5 items-start mb-1">
              <Dot tint="var(--warning)" />
              <span>{openThreads} review thread{openThreads === 1 ? "" : "s"} still open — a reply is not a resolve</span>
            </div>
          )}
          {c.failure > 0 && (
            <div className="flex gap-1.5 items-start mb-1">
              <Dot tint="var(--error)" />
              <span>{c.failing.map((f) => f.name).slice(0, 3).join(", ")}{c.failing.length > 3 ? ` +${c.failing.length - 3}` : ""}</span>
            </div>
          )}
          {canMerge && <div className="flex gap-1.5 items-start mb-1"><Dot tint="var(--success)" /><span>nothing is blocking this</span></div>}

          <div className="flex gap-1.5 flex-wrap mt-2">
            <Btn onClick={onMerge} disabled={busy || !canMerge} danger title={canMerge ? "squash, merge and delete the branch" : MERGE_WHY[d.mergeState]}>squash &amp; merge</Btn>
            <Btn onClick={onAutoMerge} disabled={busy}>merge when green</Btn>
            <Btn onClick={onUpdateBranch} disabled={busy} title="merge the base branch into this one">update branch</Btn>
            {c.failure > 0 && <Btn onClick={onRerun} disabled={busy}>re-run failed</Btn>}
            <Btn onClick={onDraft} disabled={busy}>{d.isDraft ? "mark ready" : "to draft"}</Btn>
            <Btn onClick={onClose} disabled={busy} danger>close</Btn>
          </div>
        </div>
      </section>

      {d.checklist.length > 0 && (
        <section>
          <div className="flex items-center gap-2 text-[9.5px] uppercase tracking-wider mb-1" style={{ color: "var(--text3)" }}>
            <span>checklist</span>
            {open > 0 && <span style={{ color: "var(--warning)" }}>{open} open</span>}
            <span className="ml-auto tabular-nums">{done}/{d.checklist.length}</span>
          </div>
          <Bar parts={[
            { pct: (done / d.checklist.length) * 100, tint: "var(--success)" },
            { pct: (open / d.checklist.length) * 100, tint: "var(--warning)" },
          ]} />
        </section>
      )}

      <section>
        <div className="text-[9.5px] uppercase tracking-wider mb-1" style={{ color: "var(--text3)" }}>description</div>
        <Body body={d.body} />
      </section>

      <div className="flex gap-1.5 flex-wrap">
        <Btn onClick={onLocalReview} disabled={busy} primary
          title="check the PR out into a throwaway worktree and review it with the full repo in context">review locally with Claude</Btn>
        <a href={d.url} target="_blank" rel="noreferrer noopener"
          className="text-[10px] px-2 py-1 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>open on GitHub ↗</a>
      </div>
    </div>
  );
}

function Btn({ children, onClick, disabled, danger, primary, title }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; primary?: boolean; title?: string;
}) {
  const tint = danger ? "var(--error)" : primary ? "var(--primary)" : "var(--border)";
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className="text-[10px] px-2 py-1 rounded disabled:opacity-40"
      style={{
        color: primary ? "var(--bg)" : danger ? "var(--error)" : "var(--text2)",
        background: primary ? "var(--primary)" : "transparent",
        border: `1px solid color-mix(in srgb, ${tint} ${primary ? 100 : 50}%, transparent)`,
        cursor: disabled ? "not-allowed" : "pointer",
      }}>{children}</button>
  );
}

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

function Lane({ label, extra }: { label: string; extra?: string }) {
  return (
    <div className="flex items-center gap-2 mt-3 mb-1.5 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>
      <span>{label}</span>
      {extra && <span>{extra}</span>}
      <span className="flex-1 h-px" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }} />
    </div>
  );
}

function Conversation({ d, lanes, botBytes, raw, onRaw, onResolve, onReply, onReview, busy }: {
  d: PrDetail;
  lanes: { humans: PrReview[]; botReviews: PrReview[]; humanComments: PrComment[]; bots: PrComment[] };
  botBytes: number; raw: boolean; onRaw: (v: boolean) => void;
  onResolve: (t: PrThread) => void; onReply: (t: PrThread) => void;
  onReview: (v: "approve" | "request_changes" | "comment") => void; busy: boolean;
}) {
  const kb = Math.round(botBytes / 1024);
  return (
    <div className="text-[11px]">
      <Lane label="humans" />
      {lanes.humans.length === 0 && lanes.humanComments.length === 0 && (
        <div style={{ color: "var(--text3)" }}>Nobody has said anything yet.</div>
      )}
      {lanes.humans.map((r, i) => (
        <div key={`r${i}`} className="mb-1.5 p-2 rounded"
          style={{
            background: "color-mix(in srgb, var(--border) 12%, transparent)",
            borderLeft: `2px solid ${r.state === "CHANGES_REQUESTED" ? "var(--error)" : r.state === "APPROVED" ? "var(--success)" : "var(--primary)"}`,
          }}>
          <div className="flex items-center gap-1.5 mb-1 text-[10px]">
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{r.author}</b>
            {r.state === "CHANGES_REQUESTED" && <Chip text="changes requested" tint="var(--error)" />}
            {r.state === "APPROVED" && <Chip text="approved" tint="var(--success)" />}
            <span className="ml-auto" style={{ color: "var(--text3)" }}>{ago(r.submittedAt)}</span>
          </div>
          {r.body && <Body body={r.body} />}
        </div>
      ))}
      {lanes.humanComments.map((c) => (
        <div key={c.id} className="mb-1.5 p-2 rounded" style={{ background: "color-mix(in srgb, var(--border) 12%, transparent)", borderLeft: "2px solid var(--primary)" }}>
          <div className="flex items-center gap-1.5 mb-1 text-[10px]">
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{c.author}</b>
            <span className="ml-auto" style={{ color: "var(--text3)" }}>{ago(c.createdAt)}</span>
          </div>
          <Body body={c.body} />
        </div>
      ))}

      <Lane label="line threads" extra={d.threads.length ? `${d.threads.filter((t) => !t.isResolved).length} open of ${d.threads.length}` : undefined} />
      {d.threads.length === 0 && <div style={{ color: "var(--text3)" }}>No line comments.</div>}
      {d.threads.map((t) => (
        <div key={t.id} className="mb-1.5 rounded" style={{ border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
          <div className="flex items-center gap-1.5 px-2 py-1 border-b text-[10px]" style={{ borderColor: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
            <span style={{ color: "var(--primary)" }}>{t.path}{t.line ? `:${t.line}` : ""}</span>
            {t.isOutdated && <Chip text="outdated" tint="var(--text3)" title="the code under this comment has changed since" />}
            <span className="ml-auto" style={{ color: t.isResolved ? "var(--success)" : "var(--warning)" }}>{t.isResolved ? "resolved" : "open"}</span>
          </div>
          {t.comments.map((c, i) => (
            <div key={c.id} className="px-2 py-1.5" style={{ paddingLeft: i ? 18 : 8, background: i ? "color-mix(in srgb, var(--border) 10%, transparent)" : undefined }}>
              <div className="flex items-center gap-1.5 mb-0.5 text-[10px]">
                <b style={{ color: "var(--text)", fontWeight: 500 }}>{c.author}</b>
                {c.isBot && <Chip text="automation" tint="var(--info)" />}
                <span className="ml-auto" style={{ color: "var(--text3)" }}>{ago(c.createdAt)}</span>
              </div>
              <Body body={c.body} />
            </div>
          ))}
          <div className="flex gap-1.5 px-2 py-1.5">
            <Btn onClick={() => onReply(t)} disabled={busy}>reply</Btn>
            <Btn onClick={() => onResolve(t)} disabled={busy}>{t.isResolved ? "unresolve" : "resolve"}</Btn>
          </div>
        </div>
      ))}

      <Lane label="automation" extra={lanes.bots.length ? `${lanes.bots.length} comments · ${kb} KB` : undefined} />
      {lanes.botReviews.map((r, i) => (
        <div key={`br${i}`} className="mb-1.5 p-2 rounded" style={{ background: "color-mix(in srgb, var(--border) 10%, transparent)", borderLeft: "2px solid var(--info)" }}>
          <div className="flex items-center gap-1.5 mb-1 text-[10px]">
            <b style={{ color: "var(--text)", fontWeight: 500 }}>{r.author}</b><Chip text="automation" tint="var(--info)" />
            <span className="ml-auto" style={{ color: "var(--text3)" }}>{ago(r.submittedAt)}</span>
          </div>
          <Body body={r.body} />
        </div>
      ))}
      {lanes.bots.length > 0 && (
        <>
          {/* A real coverage comment is 46,551 characters and about three
              numbers. Show the numbers; keep the rest one click away. */}
          <button onClick={() => onRaw(!raw)} className="w-full text-left text-[10px] px-2 py-1 rounded mb-1.5"
            style={{ color: "var(--text2)", border: "1px dashed color-mix(in srgb, var(--border) 50%, transparent)" }}>
            <span style={{ color: "var(--primary)" }}>{raw ? "▾" : "▸"}</span>{" "}
            {lanes.bots.length} machine comment{lanes.bots.length === 1 ? "" : "s"} · {kb} KB {raw ? "— hide raw" : "collapsed — show raw"}
          </button>
          {lanes.bots.map((c) => (
            <div key={c.id} className="mb-1.5 p-2 rounded" style={{ background: "color-mix(in srgb, var(--border) 10%, transparent)", borderLeft: "2px solid var(--info)" }}>
              <div className="flex items-center gap-1.5 mb-0.5 text-[10px]">
                <b style={{ color: "var(--text)", fontWeight: 500 }}>{c.author}</b><Chip text="automation" tint="var(--info)" />
                <span className="ml-auto" style={{ color: "var(--text3)" }}>{ago(c.createdAt)}</span>
              </div>
              {raw
                ? <pre className="overflow-x-auto text-[10px] max-h-64" style={{ ...CODE_FONT_STYLE, color: "var(--text3)" }}>{c.body}</pre>
                : <div style={{ color: "var(--text2)" }}>{c.digest || "(nothing worth pulling out)"}</div>}
            </div>
          ))}
        </>
      )}

      <div className="flex gap-1.5 flex-wrap mt-3">
        <Btn onClick={() => onReview("comment")} disabled={busy}>comment</Btn>
        <Btn onClick={() => onReview("approve")} disabled={busy}>approve</Btn>
        <Btn onClick={() => onReview("request_changes")} disabled={busy} danger>request changes</Btn>
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

function Checks({ d, onRerun, busy }: { d: PrDetail; onRerun: () => void; busy: boolean }) {
  const c = d.checks;
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);
  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2 mb-2 tabular-nums">
        <span style={{ color: "var(--success)" }}>{c.success} ✓</span>
        <span style={{ color: "var(--text3)" }}>{c.skipped} ⊘</span>
        <span style={{ color: "var(--error)" }}>{c.failure} ✕</span>
        {c.pending > 0 && <span style={{ color: "var(--warning)" }}>{c.pending} running</span>}
        <Bar parts={[
          { pct: pct(c.success), tint: "var(--success)" },
          { pct: pct(c.failure), tint: "var(--error)" },
          { pct: pct(c.pending), tint: "var(--warning)" },
          { pct: pct(c.skipped), tint: "color-mix(in srgb, var(--text3) 40%, transparent)" },
        ]} />
      </div>

      {c.failing.length > 0 && (
        <div className="mb-2">
          {c.failing.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5 py-1 px-2 mb-1 rounded"
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 9%, transparent)" }}>
              <Dot tint="var(--error)" />
              <span style={{ color: "var(--text)" }}>{f.name}</span>
              {f.workflow && <span className="text-[10px]" style={{ color: "var(--text3)" }}>{f.workflow}</span>}
              {f.url && <a href={f.url} target="_blank" rel="noreferrer noopener" className="ml-auto text-[10px]" style={{ color: "var(--text2)" }}>log ↗</a>}
            </div>
          ))}
          <Btn onClick={onRerun} disabled={busy}>re-run failed jobs</Btn>
        </div>
      )}

      <div className="text-[10px] mb-2" style={{ color: "var(--text3)" }}>
        {c.allDone
          ? `all ${c.total} checks are done — ${c.verdict === "green" ? "green" : "red"}. One notification was sent, not ${c.total}.`
          : `${c.pending} of ${c.total} still running — you will be told once, when the last one lands.`}
      </div>

      <div className="flex flex-wrap gap-0.5 mb-2">
        {d.checksAll.map((k, i) => (
          <span key={i} title={`${k.name}${k.workflow ? ` · ${k.workflow}` : ""} — ${k.state}`}
            style={{ width: 11, height: 11, borderRadius: 2, background: CHECK_TINT[k.state], opacity: k.state === "skipped" || k.state === "neutral" ? 0.4 : 1 }} />
        ))}
      </div>
    </div>
  );
}

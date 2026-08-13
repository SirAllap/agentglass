/*
 * The Diff view, rebuilt.
 *
 * What it is for: reading what has changed across every checkout on this
 * machine, one file at a time. What went wrong with the last one is worth
 * writing down, because most of the decisions here are a reaction to it.
 *
 * It listed rows that were really `FileChange` events — an agent's Edit call —
 * so every field a changed file needs was invented: the time became the time of
 * the request, the section name became the literal string "unstaged", and a
 * row's identity changed when you ran `git add`, which threw away the selection
 * and the review tick mid-read. It carried the full diff of 400 files to render
 * one, at 1.1 MB every four seconds. And it put a filter box and eleven 9.5px
 * chips — two rows of them — above the first file name, all of them the same
 * weight, so the control that decides WHAT THE LIST IS looked exactly like the
 * one that decides how it is sorted.
 *
 * So the shape here is: one decision in the header, sections that are the unit
 * of work (a checkout, headed by its branch), and a row that answers what
 * changed, when, and by how much. Everything else — grouping, folding, the
 * hidden counts — lives in one menu, because those are questions you ask
 * occasionally and the file list is the thing you came for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeRow } from "../../../../shared/types.ts";
import {
  filterRows, groupRows, reviewKeyOf, rowByKey, statusWord, totalsOf, useChangeRows, useFileDiff,
  visibleRows, whenLabel, type DiffMode, type GroupBy, type RowGroup,
} from "../../lib/changeRows.ts";
import { useIncremental } from "../../lib/useIncremental.ts";
import { useSidebarWidth } from "../../lib/sidebarWidth.ts";
import { SidebarGrip } from "../SidebarGrip.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { CHIP_ICON, Chip, FilterField, IconChip, Segmented } from "../workspace/Chrome.tsx";
import { viewHeaderClass, viewHeaderStyle } from "../workspace/ViewHeader.tsx";
import { diffSplit, diffWrap, setDiffSplit, setDiffWrap } from "../../lib/diffPrefs.ts";
import { useDiffHighlight, HiliteCtx } from "../../lib/diffHighlight.ts";
import { SplitDiff, UnifiedDiff, SCROLLBAR_CSS, SPLIT_SEL_CSS } from "./DiffLines.tsx";

/* Storage keys are v3 on purpose: the two before them stored a group-by that no
   longer exists and ticks keyed by an id that no longer exists either. */
const K_MODE = "agentglass.diff.v3.mode";
const K_GROUP = "agentglass.diff.v3.groupBy";
const K_REVIEW = "agentglass.diff.v3.reviewed";
const K_IGNORED = "agentglass.diff.v3.showIgnored";
const K_OUTSIDE = "agentglass.diff.v3.showOutside";

/** Ticks are kept by row key, which survives staging and re-cloning. Capped so a
 *  year of reading cannot grow the entry without bound; the OLDEST go, because
 *  the tick you set five minutes ago is the one you are using. */
const REVIEW_MAX = 2000;

const read = <T,>(key: string, fallback: T, parse: (raw: string) => T): T => {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : parse(raw); } catch { return fallback; }
};
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

export function DiffPage({ active, onClose }: { active: boolean; onClose?: () => void }) {
  const [mode, setMode] = useState<DiffMode>(() => read(K_MODE, "working", (r) => (r === "committed" ? "committed" : "working")));
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    read(K_GROUP, "worktree", (r) => (r === "time" || r === "folder" ? (r as GroupBy) : "worktree")));
  const [q, setQ] = useState("");
  const [showIgnored, setShowIgnored] = useState(() => read(K_IGNORED, false, (r) => r === "1"));
  const [showOutside, setShowOutside] = useState(() => read(K_OUTSIDE, false, (r) => r === "1"));
  const [selKey, setSelKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() =>
    new Set(read<string[]>(K_REVIEW, [], (r) => JSON.parse(r) as string[])));
  const [split, setSplit] = useState(diffSplit);
  const [wrap, setWrap] = useState(diffWrap);
  const [menu, setMenu] = useState(false);

  const sidebarW = useSidebarWidth();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => write(K_MODE, mode), [mode]);
  useEffect(() => write(K_GROUP, groupBy), [groupBy]);
  useEffect(() => write(K_IGNORED, showIgnored ? "1" : "0"), [showIgnored]);
  useEffect(() => write(K_OUTSIDE, showOutside ? "1" : "0"), [showOutside]);

  const { rows, truncated, failed, loading, error } = useChangeRows(mode, active);

  /* The counts the chips offer back. Each counts only what IT is hiding, or
     "+2 ignored" shows nothing when the same rows are also outside the project
     and the number reads as a lie. */
  const hiddenIgnored = useMemo(() => rows.reduce((n, r) => n + (r.ignored && (showOutside || !r.outside) ? 1 : 0), 0), [rows, showOutside]);
  const hiddenOutside = useMemo(() => rows.reduce((n, r) => n + (r.outside && (showIgnored || !r.ignored) ? 1 : 0), 0), [rows, showIgnored]);

  const shown = useMemo(
    () => filterRows(visibleRows(rows, showIgnored, showOutside), q),
    [rows, showIgnored, showOutside, q],
  );
  const groups = useMemo(() => groupRows(shown, groupBy), [shown, groupBy]);
  const totals = useMemo(() => totalsOf(shown, reviewed), [shown, reviewed]);

  // The selection heals to something that is on screen — but only when what it
  // pointed at has actually gone, so a poll cannot move the reader.
  const selected = useMemo(() => rowByKey(shown, selKey) ?? shown[0] ?? null, [shown, selKey]);
  useEffect(() => { if (selected && selected.key !== selKey) setSelKey(selected.key); }, [selected, selKey]);

  const body = useFileDiff(selected, mode);

  const toggleReviewed = useCallback((r: ChangeRow) => {
    setReviewed((prev) => {
      const next = new Set(prev);
      const k = reviewKeyOf(r);
      if (next.has(k)) next.delete(k); else next.add(k);
      const list = [...next].slice(-REVIEW_MAX);
      write(K_REVIEW, JSON.stringify(list));
      return new Set(list);
    });
  }, []);

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  /* Walking the list with the keyboard, over the FLAT order the eye sees rather
     than per section — a reader pressing j does not think about which section
     they are about to leave. */
  const flat = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows)), [groups, collapsed]);
  const step = useCallback((dir: 1 | -1) => {
    if (!flat.length) return;
    const i = flat.findIndex((r) => r.key === selected?.key);
    const next = flat[Math.max(0, Math.min(flat.length - 1, (i < 0 ? 0 : i) + dir))];
    if (next) setSelKey(next.key);
  }, [flat, selected]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Never steal a key from something being typed into — the filter box is
      // right there, and j/k are letters.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === " " && selected) { e.preventDefault(); toggleReviewed(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, step, selected, toggleReviewed]);

  // Keep the selected row in view when the keyboard moved it, and only then:
  // scrolling on every render fights the mouse.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [selKey]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <style>{SCROLLBAR_CSS}{SPLIT_SEL_CSS}</style>

      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <h2 className="sr-only">Diff</h2>
        {/*
          * The one decision that changes what the list IS, in words and at a
          * legible size. It used to be two of eleven identical 9.5px chips.
          */}
        <Segmented value={mode} options={MODES} onChange={setMode} label="What the list shows" />

        <span className="text-[11px] tabular-nums truncate" style={{ color: "var(--text3)" }}>
          {loading && !rows.length ? "reading git…" : (
            <>
              {totals.files} {totals.files === 1 ? "file" : "files"}
              {" · "}<span style={{ color: "var(--success)" }}>+{totals.add}</span>
              {" "}<span style={{ color: "var(--error)" }}>−{totals.del}</span>
              {totals.done > 0 && <span style={{ color: "var(--text4)" }}>{" · "}{totals.done} read</span>}
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-2 relative">
          <Chip on={split} onClick={() => { setSplit(!split); setDiffSplit(!split); }} title="Side by side">Split</Chip>
          <Chip on={wrap} onClick={() => { setWrap(!wrap); setDiffWrap(!wrap); }} title="Wrap long lines">Wrap</Chip>
          <IconChip on={menu} onClick={() => setMenu((v) => !v)} title="List options" expanded={menu} hasPopup>
            <svg width={CHIP_ICON} height={CHIP_ICON} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <circle cx="8" cy="3.2" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="12.8" r="1.3" />
            </svg>
          </IconChip>
          {menu && (
            <Menu
              groupBy={groupBy} onGroupBy={(g) => { setGroupBy(g); setMenu(false); }}
              showIgnored={showIgnored} onShowIgnored={() => setShowIgnored((v) => !v)} hiddenIgnored={hiddenIgnored}
              showOutside={showOutside} onShowOutside={() => setShowOutside((v) => !v)} hiddenOutside={hiddenOutside}
              onClose={() => setMenu(false)}
            />
          )}
          {onClose && <CloseButton onClick={onClose} />}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="shrink-0 flex flex-col min-h-0" style={{ width: sidebarW }}>
          <div className="px-3 py-2 shrink-0">
            <FilterField value={q} onChange={setQ} className="w-full"
              placeholder="Filter by file, folder or branch…" label="Filter the list" />
          </div>

          <List
            ref={listRef}
            groups={groups} collapsed={collapsed} onToggleSection={toggleSection}
            selKey={selected?.key ?? null} onSelect={setSelKey}
            reviewed={reviewed} onToggleReviewed={toggleReviewed}
            groupBy={groupBy}
            empty={loading && !rows.length ? "Reading git…"
              : error ? error
              : q ? "Nothing matches that filter"
              : mode === "committed" ? "No commits in the checkouts in scope"
              : "Nothing uncommitted anywhere"}
            notice={notices({ truncated, failed, hiddenIgnored, hiddenOutside, showIgnored, showOutside })}
          />
        </div>

        <SidebarGrip />

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {selected
            ? <Body row={selected} state={body} split={split} wrap={wrap} />
            : <Blank>Nothing selected</Blank>}
        </div>
      </div>
    </div>
  );
}

/** The lines under the list that say what is NOT in it. A list that quietly
 *  leaves things out is the failure this replaces — the old one truncated at 400
 *  rows in repo order and said nothing at all. */
function notices(o: {
  truncated: number; failed: string[];
  hiddenIgnored: number; hiddenOutside: number; showIgnored: boolean; showOutside: boolean;
}): string[] {
  const out: string[] = [];
  if (o.truncated > 0) out.push(`${o.truncated} more rows than this view will hold — narrow the filter to see them`);
  if (o.failed.length) out.push(`${o.failed.length} checkout${o.failed.length === 1 ? "" : "s"} could not be read`);
  if (!o.showIgnored && o.hiddenIgnored > 0) out.push(`${o.hiddenIgnored} ignored hidden`);
  if (!o.showOutside && o.hiddenOutside > 0) out.push(`${o.hiddenOutside} outside this project hidden`);
  return out;
}

/* ── header pieces ────────────────────────────────────────────────────────── */

/* The header's controls come from `workspace/Chrome.tsx`, which is where the
   app's one chip shape lives. The first version of this view declared its own —
   a segmented pill at 11.5px with its own border and inner padding, and a 24px
   icon button — so switching from Source control to Diff visibly changed the
   size of the controls in the same corner of the same bar. */
const MODES = [
  { id: "working" as const, label: "Uncommitted", title: "What every checkout has changed and not committed" },
  { id: "committed" as const, label: "Last commit", title: "The last piece of work committed in each checkout" },
];

const GROUPS: { id: GroupBy; label: string; hint: string }[] = [
  { id: "worktree", label: "By checkout", hint: "One section per worktree, headed by its branch" },
  { id: "time", label: "By day", hint: "One section per day — real times, at last" },
  { id: "folder", label: "By folder", hint: "One section per directory" },
];

function Menu({
  groupBy, onGroupBy, showIgnored, onShowIgnored, hiddenIgnored, showOutside, onShowOutside, hiddenOutside, onClose,
}: {
  groupBy: GroupBy; onGroupBy: (g: GroupBy) => void;
  showIgnored: boolean; onShowIgnored: () => void; hiddenIgnored: number;
  showOutside: boolean; onShowOutside: () => void; hiddenOutside: number;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Deferred: the click that OPENED the menu is still travelling, and binding
    // synchronously closes it again in the same gesture.
    const t = setTimeout(() => document.addEventListener("mousedown", away), 0);
    document.addEventListener("keydown", esc);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);

  return (
    <div
      ref={box} role="menu"
      className="absolute right-0 rounded-lg py-1.5 agx-menu"
      style={{ top: 30, minWidth: 240, boxShadow: "0 10px 30px rgba(0,0,0,0.38)", zIndex: 60 }}
    >
      <p className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Group</p>
      {GROUPS.map((g) => (
        <button
          key={g.id} role="menuitemradio" aria-checked={groupBy === g.id}
          onClick={() => onGroupBy(g.id)} title={g.hint}
          className="w-full text-left px-3 py-1.5 text-[11.5px] flex items-center gap-2 hover:bg-white/5"
          style={{ color: groupBy === g.id ? "var(--text)" : "var(--text2)" }}
        >
          <Tick on={groupBy === g.id} />
          {g.label}
        </button>
      ))}
      {(hiddenIgnored > 0 || showIgnored || hiddenOutside > 0 || showOutside) && (
        <>
          <div className="my-1.5 mx-3 h-px" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
          <p className="px-3 pb-1.5 text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Also show</p>
          {(hiddenIgnored > 0 || showIgnored) && (
            <button role="menuitemcheckbox" aria-checked={showIgnored} onClick={onShowIgnored}
              className="w-full text-left px-3 py-1.5 text-[11.5px] flex items-center gap-2 hover:bg-white/5" style={{ color: "var(--text2)" }}>
              <Tick on={showIgnored} />
              Files git ignores{hiddenIgnored > 0 && <span className="ml-auto tabular-nums" style={{ color: "var(--text4)" }}>{hiddenIgnored}</span>}
            </button>
          )}
          {(hiddenOutside > 0 || showOutside) && (
            <button role="menuitemcheckbox" aria-checked={showOutside} onClick={onShowOutside}
              className="w-full text-left px-3 py-1.5 text-[11.5px] flex items-center gap-2 hover:bg-white/5" style={{ color: "var(--text2)" }}>
              <Tick on={showOutside} />
              Files outside this project{hiddenOutside > 0 && <span className="ml-auto tabular-nums" style={{ color: "var(--text4)" }}>{hiddenOutside}</span>}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
      style={{ opacity: on ? 1 : 0, color: "var(--primary)" }}>
      <path d="M2.5 6.4l2.4 2.4L9.5 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── the list ─────────────────────────────────────────────────────────────── */

function List({
  ref, groups, collapsed, onToggleSection, selKey, onSelect, reviewed, onToggleReviewed, groupBy, empty, notice,
}: {
  ref: React.Ref<HTMLDivElement>;
  groups: RowGroup[];
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  selKey: string | null;
  onSelect: (key: string) => void;
  reviewed: ReadonlySet<string>;
  onToggleReviewed: (r: ChangeRow) => void;
  groupBy: GroupBy;
  empty: string;
  notice: string[];
}) {
  /* Sections render incrementally rather than all at once: nineteen checkouts of
     uncommitted work is a few thousand rows, and mounting them costs a visible
     pause on the frame where the view opens. */
  const inc = useIncremental(groups, groupBy);

  return (
    <div ref={ref} onScroll={inc.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2 pb-3">
      {!groups.length && <p className="text-center py-10 text-[12px]" style={{ color: "var(--text4)" }}>{empty}</p>}
      {inc.rows.map((g) => (
        <section key={g.key} className="mb-1">
          <button
            onClick={() => onToggleSection(g.key)}
            aria-expanded={!collapsed.has(g.key)}
            className="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-md hover:bg-white/5 text-left"
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
              style={{ color: "var(--text4)", transform: collapsed.has(g.key) ? "rotate(-90deg)" : "none", transition: "transform .12s" }}>
              <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[11.5px] font-medium truncate" style={{ color: "var(--text)" }}>{g.label}</span>
            {g.sub && <span className="text-[10px] truncate shrink" style={{ color: "var(--text4)" }}>{g.sub}</span>}
            <span className="ml-auto shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>
              {g.rows.length}
              {"  "}<span style={{ color: "var(--success)" }}>+{g.add}</span>
              {" "}<span style={{ color: "var(--error)" }}>−{g.del}</span>
            </span>
          </button>
          {!collapsed.has(g.key) && (
            <div className="pl-3">
              {g.rows.map((r) => (
                <Row
                  key={r.key} r={r}
                  selected={r.key === selKey}
                  reviewed={reviewed.has(reviewKeyOf(r))}
                  onSelect={() => onSelect(r.key)}
                  onToggleReviewed={() => onToggleReviewed(r)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
      {inc.more && (
        <button onClick={inc.showAll} className="w-full py-2 text-[11px] rounded-md hover:bg-white/5" style={{ color: "var(--text3)" }}>
          Show the rest
        </button>
      )}
      {notice.map((n) => (
        <p key={n} className="px-2 pt-2 text-[10.5px]" style={{ color: "var(--text4)" }}>{n}</p>
      ))}
    </div>
  );
}

/** What happened to a file, as a colour and a letter — read before the name is.
 *  A word as well, in the row, for the three cases a diff cannot show. */
const STATUS_STYLE: Record<ChangeRow["status"], { c: string; ch: string }> = {
  added: { c: "var(--success)", ch: "A" },
  untracked: { c: "var(--success)", ch: "A" },
  modified: { c: "var(--info)", ch: "M" },
  deleted: { c: "var(--error)", ch: "D" },
  renamed: { c: "var(--warning)", ch: "R" },
  typechange: { c: "var(--warning)", ch: "T" },
};

function Row({ r, selected, reviewed, onSelect, onToggleReviewed }: {
  r: ChangeRow; selected: boolean; reviewed: boolean; onSelect: () => void; onToggleReviewed: () => void;
}) {
  const name = r.path.slice(r.path.lastIndexOf("/") + 1);
  const dir = r.path.slice(0, r.path.length - name.length).replace(/\/$/, "");
  const s = STATUS_STYLE[r.status];
  const word = statusWord(r);

  return (
    <div
      data-sel={selected ? "1" : undefined}
      role="button" tabIndex={-1}
      onClick={onSelect}
      className="w-full flex items-center gap-2 px-2 py-1 rounded-md cursor-default"
      style={{ background: selected ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent" }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "color-mix(in srgb, var(--bg3) 45%, transparent)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <span aria-hidden className="shrink-0 text-[10px] font-semibold tabular-nums" style={{ color: s.c, width: 10 }}>{s.ch}</span>

      <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
        <span className="text-[11.5px] truncate" style={{ color: reviewed ? "var(--text3)" : "var(--text)" }}>{name}</span>
        {dir && <span className="text-[10px] truncate shrink" style={{ color: "var(--text4)" }}>{dir}</span>}
        {word && (
          <span className="text-[9.5px] px-1 rounded shrink-0" style={{ color: s.c, background: `color-mix(in srgb, ${s.c} 15%, transparent)` }}>{word}</span>
        )}
        {r.staged !== "none" && (
          <span className="text-[9.5px] px-1 rounded shrink-0" title={r.staged === "partial" ? "Partly staged" : "Staged"}
            style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>
            {r.staged === "partial" ? "part staged" : "staged"}
          </span>
        )}
      </span>

      {/* When it changed. The whole reason this rebuild exists — and the reason
          it can be shown at all is that the row no longer carries the time of
          the request. */}
      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{whenLabel(r.changedAt)}</span>

      <span className="shrink-0 text-[10px] tabular-nums" style={{ minWidth: 62, textAlign: "right" }}>
        {r.additions > 0 && <span style={{ color: "var(--success)" }}>+{r.additions}</span>}
        {r.deletions > 0 && <span style={{ color: "var(--error)" }}> −{r.deletions}</span>}
      </span>

      <button
        onClick={(e) => { e.stopPropagation(); onToggleReviewed(); }}
        title={reviewed ? "Mark as not read" : "Mark as read"}
        aria-pressed={reviewed}
        className="shrink-0 inline-flex items-center justify-center rounded-full"
        style={{
          width: 20, height: 20,
          color: reviewed ? "var(--success)" : "var(--text4)",
        }}
      >
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden>
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" opacity={reviewed ? 1 : 0.5} />
          {reviewed && <path d="M3.6 6.2l1.7 1.7 3.1-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </button>
    </div>
  );
}

/* ── the diff ─────────────────────────────────────────────────────────────── */

function Body({ row, state, split, wrap }: {
  row: ChangeRow;
  state: { diff: { hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]; truncated: boolean; binary: boolean; error?: string } | null; loading: boolean; error: string | null };
  split: boolean; wrap: boolean;
}) {
  const { hilite } = useDiffHighlight(row.path);
  const [copied, setCopied] = useState(false);
  const hunks = state.diff?.hunks ?? [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${row.repoRoot}/${row.path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* a clipboard that refuses is not worth an error state here */ }
  };

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2 shrink-0 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 35%, transparent)" }}>
        <div className="min-w-0">
          <p className="text-[12px] truncate" style={{ color: "var(--text)" }}>{row.path}</p>
          <p className="text-[10px] truncate" style={{ color: "var(--text4)" }}>
            {row.branch || row.repoRoot}
            {row.oldPath && <> · renamed from <span style={{ color: "var(--text3)" }}>{row.oldPath}</span></>}
            {row.commit && <> · {row.commit.subject}</>}
            {" · "}{whenLabel(row.changedAt)}
          </p>
        </div>
        <button onClick={copy} title="Copy the full path"
          className="ml-auto shrink-0 px-2 py-1 rounded-md text-[10.5px]"
          style={{ color: copied ? "var(--success)" : "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
          {copied ? "Copied" : "Copy path"}
        </button>
      </div>

      <div className="agx-scroll flex-1 min-h-0 overflow-auto">
        {state.loading && !state.diff && <Blank>Reading the diff…</Blank>}
        {/* Every one of these was a blank pane reading "0 hunks" before. A file
            the view cannot show is a thing to SAY, not an empty box. */}
        {!state.loading && state.error && <Blank tone="error">{state.error}</Blank>}
        {state.diff?.binary && <Blank>Binary file — {row.additions || row.deletions ? "changed" : "added"}, nothing to show as text</Blank>}
        {!state.diff?.binary && !state.error && !hunks.length && !state.loading && (
          <Blank>
            {row.status === "renamed" ? `Renamed from ${row.oldPath ?? "somewhere"} — the contents did not change`
              : row.tooBig ? "Too large to diff"
              : "No textual change"}
          </Blank>
        )}
        {hunks.length > 0 && (
          <HiliteCtx.Provider value={hilite}>
            {split
              ? <SplitDiff hunks={hunks} wrap={wrap} />
              : <UnifiedDiff hunks={hunks} wrap={wrap} />}
          </HiliteCtx.Provider>
        )}
        {state.diff?.truncated && (
          <p className="px-4 py-3 text-[11px]" style={{ color: "var(--warning)" }}>
            This diff was cut off — the file changed more than this view will render at once.
          </p>
        )}
      </div>
    </>
  );
}

function Blank({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <p className="text-[12px] text-center" style={{ color: tone === "error" ? "var(--error)" : "var(--text4)" }}>{children}</p>
    </div>
  );
}

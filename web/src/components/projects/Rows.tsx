// The list's fixed grid, and what is drawn on it: column header, group header,
// project row, the one-line "0 of 70 match". Every item is ROW_H high, so the
// virtual window is arithmetic; every column has a header and the legend names
// the badges, so no meaning lives only in a hover.
import type { GitRepoRef } from "../../../../shared/types.ts";
import { ICON } from "../../lib/iconSize.ts";
import { middleSplit, nameSplit, railLabel, relTime, tildify } from "../../lib/projectsPaths.ts";
import { groupCount, queryTerms, type Group } from "../../lib/projectsView.ts";
import { BranchIcon, FolderIcon, MoreIcon } from "../../lib/glyphIcons.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { HAIR, Status, Tile, wash, type Hue } from "./ui.tsx";

export const ROW_H = 46;
export const COLS = "16px 22px minmax(0,1fr) 150px 44px 56px 60px 72px 76px";

export function ColumnHeads() {
  const c = "text-[10px] font-semibold uppercase tracking-wide";
  return (
    <div className={`grid shrink-0 ${c}`} role="presentation" style={{ gridTemplateColumns: COLS, gap: "0 8px", padding: "4px 18px", color: "var(--text4)", borderTop: HAIR, paddingRight: 30 }}>
      <span /><span /><span>Project</span><span>Branch</span><span className="text-center">Tabs</span><span className="text-center">Changes</span><span className="text-center">Sync</span><span className="text-right">Touched</span><span />
    </div>
  );
}

/** Wrap the matched fragments of `text` in <mark>. */
function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  if (!terms.length) return <>{text}</>;
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${esc.join("|")})`, "ig"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} style={{ background: wash("var(--warning)", 28), color: "inherit", borderRadius: 3, padding: "0 2px" }}>{p}</mark> : p))}</>;
}

export function GroupHead({ g, searching, ticked, onToggle, onForget, onCopy, onAddAll }: {
  g: Group; searching: boolean; ticked: boolean; onToggle: () => void; onForget?: () => void; onCopy?: () => void; onAddAll?: () => void;
}) {
  const count = groupCount(g, searching);
  const action = "text-[11px] font-semibold cursor-pointer bg-transparent border-0 p-0 shrink-0 whitespace-nowrap";
  return (
    <div className="flex items-center gap-2 pm-px" style={{ height: ROW_H, paddingRight: 30, background: "color-mix(in srgb, var(--bg3) 40%, var(--surface-card))", borderBottom: HAIR }} role="presentation">
      <div className="min-w-0 flex-1 flex flex-col justify-center" title={g.full ? `${g.full}` : undefined}>
        <span className="flex items-baseline gap-2 min-w-0">
          <b className="text-[11px] uppercase tracking-wide shrink-0" style={{ color: "var(--text3)" }}>{g.full ? railLabel(g.full, 28) : g.title}</b>
          <span className="text-[11px]" style={{ color: "var(--text4)" }}>{count}</span>
        </span>
        {g.full && tildify(g.full).length > 28 && <span className="font-mono text-[10.5px] truncate" style={{ color: "var(--text4)" }}>{g.full}</span>}
      </div>
      {g.items.length > 0 && <button className={action} style={{ color: "var(--primary)" }} onClick={onToggle}>{ticked ? `Untick ${g.items.length}` : `Tick ${g.items.length === 1 ? "it" : `all ${g.items.length}`}`}</button>}
      {onAddAll && <button className={action} style={{ color: "var(--info, #3b82f6)" }} onClick={onAddAll} title="Put every project in this group on your list">Add all {g.items.length}</button>}
      {onCopy && <button className={action} style={{ color: "var(--text3)" }} onClick={onCopy} title="Copy the folder's full path">Copy path</button>}
      {onForget && <button className={action} style={{ color: "var(--text3)" }} onClick={onForget} title="Stop listing this folder's projects — the folder is not touched">Forget folder</button>}
    </div>
  );
}

export function ProjectRow({ r, tabs, query, now, current, hotRow, ticked, hidden, busy, onTick, onOpen, onHot, onForget, onMenu }: {
  r: GitRepoRef; tabs: number; query: string; now: number; current: boolean; hotRow: boolean; ticked: boolean; hidden: boolean; busy: boolean;
  onTick: () => void; onOpen: () => void; onHot: () => void; onForget: () => void; onMenu: (x: number, y: number) => void;
}) {
  const terms = queryTerms(query);
  const tint: Hue = current ? "primary" : r.dirty ? "warning" : r.behind ? "info" : "success";
  const sync = r.ahead || r.behind ? `${r.ahead ? "↑" + r.ahead : ""}${r.ahead && r.behind ? " " : ""}${r.behind ? "↓" + r.behind : ""}` : "";
  const m = middleSplit(tildify(r.root));
  const nm = nameSplit(r.name);
  const acts = hotRow ? "visible" : "hidden";
  return (
    <div role="option" aria-selected={hotRow} data-root={r.root} onMouseMove={onHot} onClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      className="grid items-center relative cursor-pointer"
      style={{ gridTemplateColumns: COLS, gap: "0 8px", padding: "0 18px", paddingRight: 30, height: ROW_H, opacity: hidden ? 0.5 : 1, borderBottom: HAIR,
        background: hotRow ? "var(--bg3)" : current ? wash("var(--primary)", 6) : "transparent" }}>
      {hotRow && <span className="absolute left-0 top-0 bottom-0" style={{ width: 3, background: "var(--primary)" }} />}
      <input type="checkbox" checked={ticked} onChange={onTick} onClick={(e) => e.stopPropagation()} disabled={busy} tabIndex={-1} aria-label={`Include ${r.name}`}
        className="cursor-pointer" style={{ accentColor: "var(--primary)", width: 14, height: 14 }} />
      <Tile hue={tint}>{r.branch ? <BranchIcon size={ICON.xs} /> : <FolderIcon size={ICON.xs} />}</Tile>
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 min-w-0 text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
          <span className="flex min-w-0" title={r.name}>
            {nm.head && <span className="truncate" style={{ flex: "0 100 auto", minWidth: "3ch" }}><Marked text={nm.head} terms={terms} /></span>}
            <span className="whitespace-nowrap" style={{ flex: "0 0 auto" }}><Marked text={nm.tail} terms={terms} /></span>
          </span>
          {current && <Status hue="primary">Open</Status>}
          {hidden && <Status hue="muted">Forgotten</Status>}
          {!!r.worktrees && <span className="text-[10.5px] font-normal shrink-0" style={{ color: "var(--text4)" }} title="Linked worktrees are folded into this project">{r.worktrees} worktree{r.worktrees === 1 ? "" : "s"}</span>}
        </span>
        <span className="flex min-w-0 font-mono text-[11px]" style={{ color: "var(--text3)" }} title={r.root}>
          {m.head && <span className="truncate" style={{ flex: "0 100 auto", minWidth: "3ch" }}><Marked text={m.head} terms={terms} /></span>}
          <span className="truncate" style={{ flex: "0 1 auto", minWidth: 0 }}><Marked text={m.tail} terms={terms} /></span>
        </span>
      </div>
      <span className="min-w-0 flex">{r.branch && <Status hue="success" title={r.branch} style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", display: "inline-block", lineHeight: "19px" }}><Marked text={r.branch} terms={terms} /></Status>}</span>
      <span className="flex justify-center">{tabs > 0 && <Status hue="info" title={`${tabs} tab${tabs === 1 ? "" : "s"} open in this project`}>{tabs}</Status>}</span>
      <span className="flex justify-center">{r.dirty > 0 && <Status hue="warning" title={`${r.dirty} uncommitted change${r.dirty === 1 ? "" : "s"}`}>● {r.dirty}</Status>}</span>
      <span className="flex justify-center">{sync && <Status hue="muted" title={`${r.ahead} ahead, ${r.behind} behind the remote`}>{sync}</Status>}</span>
      <span className="text-right text-[11px] whitespace-nowrap" style={{ color: "var(--text3)" }}>{relTime(r.touchedAt, now)}</span>
      <span className="flex items-center justify-end gap-1.5" style={{ visibility: acts }}>
        <Button size="compact" tone="plain" onClick={(e) => { e.stopPropagation(); onOpen(); }} disabled={busy} tabIndex={-1}>Open</Button>
        {!current && (
          <button onClick={(e) => { e.stopPropagation(); onForget(); }} title={hidden ? "Put back on the list" : "Forget — only here, files untouched"} aria-label={hidden ? `Put ${r.name} back` : `Forget ${r.name}`} tabIndex={-1}
            className="grid place-items-center rounded-md bg-transparent border-0 cursor-pointer" style={{ width: 24, height: 24, color: "var(--text3)" }}>
            <CloseIcon size={ICON.xs} />
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); onMenu(b.left, b.bottom + 4); }} title="More" aria-label={`More for ${r.name}`} tabIndex={-1}
          className="grid place-items-center rounded-md bg-transparent border-0 cursor-pointer" style={{ width: 24, height: 24, color: "var(--text3)" }}><MoreIcon size={ICON.sm} /></button>
      </span>
    </div>
  );
}

/*
 * The Filters button and the popover behind it (V2): the sentence of what is on across the top, a rail of filter groups
 * each wearing what it has picked, and the open group's own pane (its own search, its own scroll). A pick applies on
 * click and the popover stays open; the footer says the picks are kept, and its main button shows how many cards they leave.
 * Portalled out of the Jira view, so it carries `agx-jmock` itself: without it the text fell back to the monospace stack.
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { fleetNow, onFleet, workerFor } from "../../../lib/jiraCardWork.ts";
import type { ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import type { TeamMember } from "../../../lib/jiraTree.ts";
import { CrossIcon, DoneIcon, SearchIcon } from "../../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { AnchoredMenu } from "../../AnchoredMenu.tsx";
import { Face } from "../../AssignPicker.tsx";
import { Button, INPUT, INPUT_STYLE, LINE, Segmented } from "../../workspace/Chrome.tsx";
import { Ctl, FunnelIcon } from "./ListControls.tsx";
import { FilterPanel } from "./FilterPanel.tsx";
import { FACETS_OFF, filterCount } from "./headerModel.ts";
import { filterCards, type JiraListFilters } from "./model.ts";
import { keyOf } from "./laneModel.ts";
import { epicNamesOf } from "./facetsModel.ts";
import { presetIsOn, presetPatch, type KeptFilters } from "./viewsModel.ts";
import { EXCLUDABLE, clearGroup, GROUPS, TOGGLE_GROUPS, cardsLine, groupRows, nextGroup, paneKey, pickedIn, stepRow, railSummary, searchRows, sentenceParts, showLabel, togglePatch, type GroupId, type SentencePart } from "./filtersV2Model.ts";
import type { SprintBoard } from "./sprintModel.ts";

const initialsOf = (name: string): string => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

/** The tick box: square for a section that takes several picks, round for one that takes one. */
function Tick({ on, out, round }: { on: boolean; out?: boolean; round?: boolean }) {
  return (
    <span aria-hidden className="shrink-0 grid place-items-center" style={{
      width: 14, height: 14, borderRadius: round ? 99 : 4, transition: "background 120ms, box-shadow 120ms",
      background: out ? "var(--error)" : on ? "var(--primary)" : "transparent", color: "var(--on-primary)",
      boxShadow: on ? "none" : "inset 0 0 0 1.5px color-mix(in srgb, var(--text) 30%, transparent)",
    }}>{out ? <span style={{ width: 7, height: 1.5, background: "currentColor" }} /> : on && <DoneIcon size={ICON.xs} />}</span>
  );
}

/** One pickable row: tick, an optional dot or face, the name, and how many cards it holds. */
function FacetRow({ on, out, round, lead, label, count, tag, note, onClick }: {
  on: boolean; out?: boolean; round?: boolean; lead?: ReactNode; label: string; count?: number; tag?: string; note?: string; onClick: (e: { altKey: boolean }) => void;
}) {
  const empty = count === 0 && !on;
  return (
    <button type="button" role={round ? "menuitemradio" : "menuitemcheckbox"} aria-checked={out ? "mixed" : on} aria-label={out ? `${label}, left out` : undefined} onClick={onClick}
      className="agx-chip agx-jf-row flex items-center text-left min-w-0 w-full"
      style={{
        height: 28, gap: 10, padding: "0 8px", borderRadius: 6, fontSize: 13, opacity: empty ? 0.55 : 1,
        background: out ? "color-mix(in srgb, var(--error) 12%, transparent)" : on ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent", color: on ? "var(--text)" : "var(--text2)", textDecoration: out ? "line-through" : "none",
      }}>
      <Tick on={on} out={out} round={round} />
      {lead}
      <span className="truncate min-w-0" style={{ flex: tag || note ? "0 1 auto" : 1 }}>{label}</span>
      {tag && <span className="truncate" style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--primary-ink)" }}>{tag}</span>}
      {note && <span className="truncate" style={{ fontSize: 12, color: "var(--text4)" }}>{note}</span>}
      {(tag || note) && <span className="flex-1" />}
      {count != null && <span className="shrink-0 tabular-nums" style={{ fontSize: 12, color: "var(--text4)" }}>{count}</span>}
    </button>
  );
}


/** The sentence of what is on: each part removable, the cards it leaves on the right. */
function Sentence({ parts, shown, total, onRemove }: { parts: SentencePart[]; shown: number; total: number; onRemove: (p: SentencePart) => void }) {
  const line = cardsLine(shown, total);
  return (
    <div data-testid="jira-filters-sentence" className="flex items-start" style={{ gap: 16, padding: "12px 24px", borderBottom: LINE }}>
      <div className="flex flex-wrap items-center min-w-0 flex-1" style={{ gap: "6px 6px", fontSize: 15, color: "var(--text)" }}>
        <span>Cards</span>
        {parts.length === 0 && <span style={{ color: "var(--text3)" }}>on this board, nothing narrowed</span>}
        {parts.map((p) => (
          <span key={p.id} className="inline-flex items-center" style={{ gap: 6 }}>
            <span style={{ color: "var(--text3)" }}>{p.lead}</span>
            <button type="button" aria-label={`Remove ${p.lead} ${p.label}`} onClick={() => onRemove(p)} className="agx-chip inline-flex items-center"
              style={{ height: 26, gap: 4, padding: "0 6px 0 8px", borderRadius: 6, fontSize: 13, background: p.excluded ? "color-mix(in srgb, var(--error) 14%, transparent)" : "color-mix(in srgb, var(--primary) 12%, transparent)", color: p.excluded ? "var(--error)" : "var(--primary-ink)", textDecoration: p.excluded ? "line-through" : "none" }}>
              <span className="truncate" style={{ maxWidth: 260 }}>{p.label}</span><CrossIcon size={ICON.xs} />
            </button>
          </span>
        ))}
      </div>
      <div className="shrink-0 text-right" data-testid="jira-filters-count">
        <div className="tabular-nums" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1 }}>{line.n}</div>
        <div style={{ fontSize: 12, color: "var(--text3)" }}>{line.of}</div>
      </div>
    </div>
  );
}

/** One group on the rail: its name and what it has picked. */
function RailItem({ label, summary, active, picked, onClick }: { label: string; summary: string; active: boolean; picked: boolean; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} data-testid={`jira-filters-group-${label.toLowerCase()}`} onClick={onClick} className="agx-chip flex items-center w-full text-left"
      style={{ height: 34, gap: 8, padding: "0 10px", borderRadius: 8, fontSize: 13, color: "var(--text)", background: active ? "var(--surface-card)" : "transparent", boxShadow: active ? "var(--surface-lift)" : "none", fontWeight: active ? 600 : 400 }}>
      <span className="flex-1 truncate">{label}</span>
      <span className="shrink-0 truncate" style={{ maxWidth: 110, fontSize: 12, fontWeight: 400, color: picked ? "var(--primary-ink)" : "var(--text4)" }}>{summary}</span>
    </button>
  );
}

/** The Saved row: the sets kept so far as chips, and "Save as…" for what is on now. */
function SavedRow({ saved, filters, canSave, onApply, onSave, onRemove }: { saved: Record<string, KeptFilters>; filters: JiraListFilters; canSave: boolean; onApply: (k: KeptFilters) => void; onSave: (name: string) => void; onRemove: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const done = () => { if (name.trim()) onSave(name); setNaming(false); setName(""); };
  const names = Object.keys(saved);
  if (!names.length && !canSave) return null;
  return (
    <div data-testid="jira-filters-saved" className="flex flex-wrap items-center" style={{ gap: 6, padding: "8px 24px", borderBottom: LINE, fontSize: 12 }}>
      <span style={{ color: "var(--text3)" }}>Saved</span>
      {names.map((k) => {
        const on = presetIsOn(filters, saved[k]!);
        return (
          <span key={k} className="inline-flex items-center" style={{ height: 24, borderRadius: 6, background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "var(--surface-inset)", color: on ? "var(--primary-ink)" : "var(--text2)" }}>
            <button type="button" aria-pressed={on} onClick={() => onApply(saved[k]!)} className="agx-chip" style={{ height: 24, padding: "0 4px 0 8px", borderRadius: 6, fontSize: 12 }}>{k}</button>
            <button type="button" aria-label={`Forget ${k}`} onClick={() => onRemove(k)} className="agx-chip grid place-items-center" style={{ height: 24, width: 24, borderRadius: 6 }}><CrossIcon size={ICON.xs} /></button>
          </span>
        );
      })}
      {naming ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it…" aria-label="Name for the saved filters" maxLength={40} spellCheck={false} className={INPUT} style={{ ...INPUT_STYLE, fontSize: 12, width: 160, height: 24 }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") done(); if (e.key === "Escape") { setNaming(false); setName(""); } }} onBlur={done} />
      ) : canSave && <button type="button" onClick={() => setNaming(true)} className="agx-chip" style={{ height: 24, padding: "0 8px", borderRadius: 6, fontSize: 12, color: "var(--primary-ink)" }}>+ Save as…</button>}
    </div>
  );
}

export function JiraFiltersMenu({ openAsk, filters, onFilters, cards, statuses, tags, team, saved = {}, onSave, onForget, shownNow, boards }: {
  /** What the board shows with these filters (its own count): the preview says the same. */ shownNow?: number; boards?: readonly SprintBoard[];
  saved?: Record<string, KeptFilters>; onSave?: (name: string) => void; onForget?: (name: string) => void;
  openAsk?: number; filters: JiraListFilters; onFilters: (patch: Partial<JiraListFilters>) => void; cards: readonly ProviderTask[]; statuses: readonly ListStatus[];
  tags: readonly string[]; team: readonly TeamMember[];
}) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<GroupId>("status");
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [mode, setMode] = useState<"is" | "not">("is");
  const btn = useRef<HTMLButtonElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { if (openAsk) setOpen(true); }, [openAsk]);
  const n = filterCount(filters);
  const close = () => { setOpen(false); setQuery(""); setOlder(false); setEmpty(false); };
  const pick = (g: GroupId) => { setGroup(g); setQuery(""); setMode("is"); };
  const fleet = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const agentCount: Partial<Record<string, number>> = {};
  for (const c of cards) {
    const st = workerFor(keyOf(c), fleet)?.status;
    if (st) agentCount.liveOnly = (agentCount.liveOnly ?? 0) + 1;
    if (st === "waiting") agentCount.needsOnly = (agentCount.needsOnly ?? 0) + 1;
  }

  const names = { epics: epicNamesOf(cards), people: Object.fromEntries(team.filter((m) => m.key).map((m) => [m.key!, m.name])) };
  // The count and the rows depend on the filters, not on the text in "Find in…"; a keystroke there only re-filters the rows.
  const shown = useMemo(() => (open ? shownNow ?? filterCards(cards, filters).length : 0), [open, cards, filters, shownNow]);
  const base = useMemo(() => (open ? groupRows(group, filters, { cards, statuses, tags, team, ...(boards ? { boards } : {}) }) : []), [open, group, cards, filters, statuses, tags, team, boards]);
  const all = open ? searchRows(base, query) : [];
  /* Older sprints sit folded under one line until asked for, or until a search names one; a picked one always shows. */
  const foldedOlder = all.filter((r) => r.section === "Older" && !r.on).length;
  const foldedEmpty = all.filter((r) => r.folded).length;
  const rows = all.filter((r) => (r.section !== "Older" || r.on || older || query.trim()) && (!r.folded || empty || query.trim()));
  const toggles = TOGGLE_GROUPS.includes(group);
  const groupLabel = GROUPS.find((g) => g.id === group)!.label;
  const width = Math.min(960, (typeof window === "undefined" ? 1200 : window.innerWidth) - 32);
  const rowButtons = (): HTMLElement[] => [...(pane.current?.querySelectorAll<HTMLElement>("button.agx-jf-row") ?? [])];
  /* Up/Down move the focus through the rows, Space (a button's own click) picks, Alt+Space leaves out, Tab walks the groups, "/" goes to the search. */
  const onKeys = (e: React.KeyboardEvent) => {
    const typing = e.target === search.current;
    const el = e.target as HTMLElement;
    const k = paneKey(e, { rail: el.getAttribute("role") === "tab", radio: !!el.closest("[role=radiogroup]") });
    if (!k || (typing && !("move" in k) && !("group" in k))) return;
    if ("search" in k) { e.preventDefault(); search.current?.focus(); return; }
    if ("group" in k) { e.preventDefault(); pick(nextGroup(group, k.group)); return; }
    const rs = rowButtons(), at = rs.indexOf(document.activeElement as HTMLElement);
    if ("move" in k) { e.preventDefault(); rs[stepRow(at, k.move, rs.length)]?.focus(); return; }
    if (at >= 0 && k.pick === "not" && EXCLUDABLE.includes(group)) { e.preventDefault(); rs[at]!.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })); }
  };
  const apart = (g: GroupId) => TOGGLE_GROUPS.includes(g);

  return (
    <>
      <Ctl btnRef={btn} pressed={open || n > 0} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}
        tip={{ name: "Filters", text: "Narrow the board by status, label, epic, component, person, space, a quick toggle or a rule." }}>
        <FunnelIcon /> Filters
        {n > 0 && <span data-testid="jira-filters-badge" className="tabular-nums grid place-items-center" style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 99, fontSize: 10.5, fontWeight: 600, background: "var(--primary)", color: "var(--on-primary)" }}>{n}</span>}
      </Ctl>
      {open && (
        <AnchoredMenu anchor={btn} align="left" minWidth={width} maxHeight={720} plain keepTab onClose={close}>
          <div data-testid="jira-filters-popover" onKeyDown={onKeys} className="agx-jmock flex flex-col" style={{ width, margin: -4, background: "var(--surface-card)" }}>
            <Sentence parts={sentenceParts(filters, names)} shown={shown} total={cards.length} onRemove={(p) => onFilters(p.clear)} />
            {(onSave || Object.keys(saved).length > 0) && <SavedRow saved={saved} filters={filters} canSave={!!onSave && n > 0} onApply={(k) => onFilters(presetPatch(k))} onSave={(nm) => onSave?.(nm)} onRemove={(nm) => onForget?.(nm)} />}
            <div className="flex min-h-0" style={{ height: 460 }}>
              <div role="tablist" aria-label="Filter groups" className="flex flex-col shrink-0 overflow-y-auto" style={{ width: 240, padding: 8, gap: 2, background: "var(--surface-inset)", borderRight: LINE }}>
                {GROUPS.map((g, i) => (
                  <div key={g.id}>
                    {apart(g.id) && !apart(GROUPS[i - 1]!.id) && <div aria-hidden style={{ height: 1, margin: "6px 8px", background: "var(--surface-line)" }} />}
                    <RailItem label={g.label} summary={railSummary(filters, g.id, names)} picked={pickedIn(filters, g.id) > 0} active={group === g.id} onClick={() => pick(g.id)} />
                  </div>
                ))}
              </div>
              <div className="flex flex-col flex-1 min-w-0" role="tabpanel" aria-label={groupLabel}>
                <div className="flex items-center" style={{ gap: 12, padding: "10px 16px", borderBottom: LINE }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{groupLabel}</span>
                  <div className="relative flex-1">
                    <span aria-hidden className="absolute flex" style={{ left: 8, top: 7, color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
                    <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Find in ${groupLabel.toLowerCase()}…`} aria-label={`Find in ${groupLabel}`} disabled={toggles}
                      spellCheck={false} autoComplete="off" className={`${INPUT} w-full`} style={{ ...INPUT_STYLE, fontSize: 13, paddingLeft: 24 }}
                      onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }} />
                  </div>
                  {EXCLUDABLE.includes(group) && <Segmented compact label="Pick or leave out" value={mode} onChange={setMode} options={[{ id: "is", label: "is" }, { id: "not", label: "is not" }]} />}
                  {group === "label" && <Segmented compact label="Labels match" value={filters.tagAll ? "all" : "any"} onChange={(v) => onFilters({ tagAll: v === "all" })} options={[{ id: "any", label: "any of" }, { id: "all", label: "all of" }]} />}
                </div>
                <div ref={pane} className="flex-1 min-h-0 overflow-y-auto flex flex-col" style={{ padding: 8, gap: 2 }} data-testid="jira-filters-pane">
                  {rows.length === 0 && <div style={{ padding: 16, fontSize: 13, color: "var(--text3)" }}>{query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing to pick here."}</div>}
                  {rows.map((r, i) => (
                    <Fragment key={r.id}>
                    {r.section && r.section !== rows[i - 1]?.section && r.section !== "Now" && <div style={{ padding: "10px 8px 2px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text3)" }}>{r.section === "Recently closed" ? "Recently closed · last 6 weeks" : r.section}</div>}
                    <FacetRow out={r.out} tag={r.tag} note={r.note} on={r.on} count={group === "signals" ? agentCount[r.id] : r.count} label={r.label} onClick={(e) => onFilters(togglePatch(group, filters, r.id, mode === "not" || e.altKey ? "not" : "is"))}
                      lead={r.color !== undefined ? <span aria-hidden className="shrink-0" style={{ width: 8, height: 8, borderRadius: 99, background: r.color || "var(--text3)" }} /> : r.face ? <Face m={{ avatar: r.face.avatar, initials: initialsOf(r.face.name) }} size={ICON.lg} /> : undefined} />
                    </Fragment>
                  ))}
                  {foldedOlder > 0 && !older && !query.trim() && (
                    <button type="button" onClick={() => setOlder(true)} className="agx-chip text-left" style={{ height: HIT, padding: "0 8px", borderRadius: 6, fontSize: 12, color: "var(--text3)" }}>Older · {foldedOlder} sprint{foldedOlder === 1 ? "" : "s"}</button>
                  )}
                  {foldedEmpty > 0 && !empty && !query.trim() && (
                    <button type="button" onClick={() => setEmpty(true)} className="agx-chip text-left" style={{ height: HIT, padding: "0 8px", borderRadius: 6, fontSize: 12, color: "var(--text3)" }}>{foldedEmpty} empty status{foldedEmpty === 1 ? "" : "es"} · none in this view</button>
                  )}
                  {group === "signals" && !query.trim() && (
                    <div style={{ padding: "8px 8px 2px" }}><FilterPanel cards={cards} value={filters.built} onChange={(built) => onFilters({ built })} /></div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center" style={{ gap: 8, padding: "10px 16px", borderTop: LINE }}>
              <span className="flex items-center" style={{ gap: 6, fontSize: 12, color: "var(--text3)" }}><DoneIcon size={ICON.xs} /> Kept after restart · per board</span>
              <span className="ml-auto flex items-center" style={{ gap: 6 }}>
                <Button size="compact" disabled={pickedIn(filters, group) === 0} onClick={() => onFilters(clearGroup(filters, group))}>Clear {groupLabel.toLowerCase()}</Button>
                <Button size="compact" disabled={n === 0} onClick={() => onFilters(FACETS_OFF)} data-tip={tipAttr("Turn off every status, label, epic, component, person, space, toggle and rule")}>Clear all</Button>
                <Button size="compact" tone="primary" onClick={close}>{showLabel(shown)}</Button>
              </span>
            </div>
          </div>
        </AnchoredMenu>
      )}
    </>
  );
}

/*
 * The sections of a Jira card, in the order Jira draws them: files, subtasks,
 * linked work items, web links. Each is a collapsible block with its count,
 * and a block with nothing in it is not drawn at all (Jira does the same for
 * files), except where the site gave a reason to say "none".
 *
 * Drawn from what the card's own read carried: no section asks for anything.
 * Every state is a sentence rather than a blank: reading, failed, restricted.
 *
 * Ceilings, said here so they are not mistaken for gaps. Files are listed by
 * name: their bytes are a redirect to another host that a later slice proxies.
 * An epic's children are not in the card's read, so an epic shows none.
 * A web link opens in the app when it is something the app shows (a pull
 * request, a card) and in the browser otherwise.
 */
import { useState, type MouseEvent, type ReactNode } from "react";
import { followLink } from "../../lib/linkRouter.ts";
import { ICON } from "../../lib/iconSize.ts";
import { openCard } from "../../lib/openCard.ts";
import { prioLook, Flag } from "../../lib/priority.tsx";
import type { CardLinked, CardWebLink, ProviderTask } from "../../../../shared/providers.ts";
import { LINE } from "../workspace/Chrome.tsx";
import { StateChip } from "./DockParts.tsx";

const KEY = "agx.jira.sectionsShut";

/** The sections this viewer closed, remembered per browser; storage that cannot be read just leaves them all open. */
function shutSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]") as string[]); } catch { return new Set(); }
}
function remember(id: string, shut: boolean): void {
  try {
    const s = shutSet();
    if (shut) s.add(id); else s.delete(id);
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch { /* a private window: the section stays as it is on screen */ }
}

/**
 * A block of the card: a quiet sentence-case heading (11 / 600) with its count, an optional aside after it and a meter at the far
 * end, folded by the chevron; whether it is shut is remembered per browser. The blocks of a tab sit 16 apart (the tab's own gap).
 */
export function JiraSection({ id, title, count, aside, meter, bare, children }: { id: string; title: string; count?: number | string; aside?: ReactNode; meter?: ReactNode; bare?: boolean; children: ReactNode }) {
  const [shut, setShut] = useState(() => shutSet().has(id));
  /* A section that is a whole tab of the card has the tab for its heading. */
  if (bare) return <div className="min-w-0">{children}</div>;
  return (
    <section className="min-w-0 flex flex-col" style={{ gap: 8 }} aria-label={title}>
      <div className="flex items-center min-w-0" style={{ gap: 8, minHeight: 22, fontSize: 11, color: "var(--text3)" }}>
        <button type="button" aria-expanded={!shut} onClick={() => { remember(id, !shut); setShut(!shut); }}
          className="agx-btn min-w-0 flex items-center rounded-md font-semibold" style={{ gap: 4, color: "inherit" }}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
            className="shrink-0" style={{ transform: shut ? "rotate(-90deg)" : "none", transition: "transform 120ms" }}><path d="m6 9 6 6 6-6" /></svg>
          <span className="truncate">{title}</span>
        </button>
        {count != null && count !== "" && <span className="tabular-nums" style={{ color: "var(--text4)" }}>{count}</span>}
        {aside != null && <span className="min-w-0" style={{ color: "var(--text4)" }}>{aside}</span>}
        <span className="flex-1" />
        {meter}
      </div>
      {!shut && children}
    </section>
  );
}

/** The kind of card, as a small coloured mark; the colours are the house's, not Atlassian's. */
const TYPE_TONE: Record<string, string> = { epic: "--primary", story: "--success", bug: "--error", task: "--info", subtask: "--text3", "sub-task": "--text3" };
export function TypeMark({ type, size }: { type?: string; size?: number }) {
  if (!type) return null;
  const tone = TYPE_TONE[type.toLowerCase()] ?? "--text3";
  /* `size` is the dock's tile (20 on a row, 22 in the header): a ring and a rounder corner; without it the small mark every list uses. */
  const box = size ?? ICON.sm;
  return (
    <span title={type} aria-label={type} className="shrink-0 inline-flex items-center justify-center text-[10px] font-semibold"
      style={{
        width: box, height: box, borderRadius: size ? (size > 20 ? 7 : 6) : 4, color: `var(${tone})`, background: `color-mix(in srgb, var(${tone}) ${size ? 14 : 16}%, transparent)`,
        ...(size ? { boxShadow: `inset 0 0 0 1px color-mix(in srgb, var(${tone}) 30%, transparent)` } : null),
      }}>
      {type[0]!.toUpperCase()}
    </span>
  );
}

/**
 * One card in a list, drawn as a tile: its kind, key, title, priority and a state chip; a click on the row opens the card in the
 * app, a right click asks for the row's menu when the list has one. `tail` replaces the state chip where the row has a control
 * for it (a sub-task's own status), and `after` sits at the row's end, outside the button that opens the card (a remove control):
 * a control inside a button is not a control.
 */
export function CardRow({ t, title, tail, after, note, onMenu }: { t: ProviderTask; title?: string; tail?: ReactNode; after?: ReactNode; note?: string; onMenu?: (e: MouseEvent, t: ProviderTask) => void }) {
  const k = t.customId ?? t.id;
  const done = t.statusKind === "done";
  return (
    <div className={`agx-dk-mini${done ? " agx-dk-done" : ""}`} onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, t); } : undefined}>
      <button onClick={() => openCard(k, k, "jira")} title={title ?? `Open ${k}`}
        className="agx-btn flex items-center min-w-0 flex-1 text-left self-stretch" style={{ gap: 8 }}>
        <TypeMark type={t.issueType} size={20} />
        <span className="agx-dk-k tabular-nums shrink-0">{k}</span>
        <span className="agx-dk-t flex-1 min-w-0 truncate">{t.title}</span>
        {t.priority && <span className="shrink-0 inline-flex" title={prioLook(t.priority).label}><Flag c={prioLook(t.priority).c} on /></span>}
        {note && <span className="shrink-0 text-[10.5px]" style={{ color: "var(--text4)" }}>{note}</span>}
        {tail === undefined && <StateChip status={t.status} color={t.statusColor || undefined} done={done} />}
      </button>
      {tail}
      {after}
    </div>
  );
}

/** How much of the sub-tasks is done: a 96 wide meter that sits at the end of the section's heading. */
export function Progress({ rows }: { rows: ProviderTask[] }) {
  const done = rows.filter((r) => r.statusKind === "done").length;
  const pct = Math.round((done / rows.length) * 100);
  return (
    <div className="rounded-full overflow-hidden shrink-0" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of the subtasks are done`}
      style={{ width: 96, height: 4, background: "color-mix(in srgb, var(--text) 14%, transparent)" }}>
      <div className="h-full" style={{ width: `${pct}%`, background: "var(--success)" }} />
    </div>
  );
}

/** Subtasks with Jira's progress line: how many are done of how many there are. */
export function SubtasksSection({ rows, onMenu }: { rows: ProviderTask[]; onMenu?: (e: MouseEvent, t: ProviderTask) => void }) {
  if (!rows.length) return null;
  const done = rows.filter((r) => r.statusKind === "done").length;
  return (
    <JiraSection id="subtasks" title="Subtasks" aside={`${done} of ${rows.length} done`} meter={<Progress rows={rows} />}>
      <div className="agx-dk-stack">{rows.map((s) => <CardRow key={s.id} t={s} onMenu={onMenu} />)}</div>
    </JiraSection>
  );
}

/** Linked work items of every type and direction, grouped by the phrase the link type uses ("blocks", "is blocked by"), in the order the site listed them. */
export function groupLinked(linked: CardLinked[]): { phrase: string; rows: CardLinked[] }[] {
  const groups: { phrase: string; rows: CardLinked[] }[] = [];
  for (const l of linked) {
    const g = groups.find((x) => x.phrase === l.phrase);
    if (g) g.rows.push(l); else groups.push({ phrase: l.phrase, rows: [l] });
  }
  return groups;
}

export function LinkedSection({ linked }: { linked: CardLinked[] }) {
  if (!linked.length) return null;
  return (
    <JiraSection id="linked" title="Linked work items" count={linked.length}>
      <div className="agx-dk-stack">
        {groupLinked(linked).flatMap((g) => g.rows.map((l) => <CardRow key={l.id} t={l.task} note={g.phrase} title={`${l.type}: ${g.phrase} ${l.task.customId ?? l.task.id}`} />))}
      </div>
    </JiraSection>
  );
}

/** Every remote link of the card, not only the pull requests; a pull request among them is also in Development. */
export function WebLinksSection({ links, error }: { links: CardWebLink[] | null; error: string }) {
  // Nothing read yet or nothing there: no heading, as for any other empty section. A failed read says so.
  if (links === null) return null;
  if (!links.length && !error) return null;
  return (
    <JiraSection id="weblinks" title="Web links" count={links.length || undefined}>
      {error && <div className="text-[10.5px] mb-1" role="status" style={{ color: "var(--warning-ink)" }}>{error}</div>}
      <div className="flex flex-col">
        {links.map((l) => (
          <button key={l.id} onClick={(e) => followLink(l.url, e)} title={l.url}
            className="agx-btn flex items-center gap-2 min-w-0 w-full text-left text-[11px] py-1.5" style={{ borderBottom: LINE }}>
            <span className="shrink-0 inline-flex items-center justify-center text-[9px] font-medium rounded"
              style={{ width: ICON.sm, height: ICON.sm, background: "var(--bg4)", color: "var(--text3)" }} aria-hidden>{(l.host[0] ?? "?").toUpperCase()}</span>
            <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text)" }}>{l.title}</span>
            <span className="shrink-0 text-[10px] truncate" style={{ color: "var(--text4)", maxWidth: "40%" }}>{l.host}</span>
          </button>
        ))}
      </div>
    </JiraSection>
  );
}

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
import { useState, type ReactNode } from "react";
import { fmtAgo } from "../../lib/format.ts";
import { followLink } from "../../lib/linkRouter.ts";
import { ICON } from "../../lib/iconSize.ts";
import { openCard } from "../../lib/openCard.ts";
import { prioLook, Flag } from "../../lib/priority.tsx";
import type { CardAttachment, CardLinked, CardWebLink, ProviderTask } from "../../../../shared/providers.ts";
import { fileSize } from "../CardFiles.tsx";
import { StatusPill } from "../StatusPill.tsx";
import { LINE } from "../workspace/Chrome.tsx";

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

/** A titled block that opens and shuts; `aside` sits on the title's right (a count of a different kind, a control). */
export function Section({ id, title, count, aside, children }: { id: string; title: string; count?: number | string; aside?: ReactNode; children: ReactNode }) {
  const [shut, setShut] = useState(() => shutSet().has(id));
  return (
    <section className="mb-5 min-w-0" aria-label={title}>
      <div className="flex items-center gap-2 mb-1.5 min-w-0">
        <button onClick={() => { remember(id, !shut); setShut(!shut); }} aria-expanded={!shut}
          className="agx-btn flex items-center gap-1.5 shrink-0 text-[10px] uppercase tracking-wide" style={{ color: "var(--text3)" }}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
            style={{ transform: shut ? "rotate(-90deg)" : "none", transition: "transform 120ms" }}><path d="m6 9 6 6 6-6" /></svg>
          <span className="truncate">{title}</span>
          {count !== undefined && count !== "" && <span className="tabular-nums" style={{ color: "var(--text4)" }}>{count}</span>}
        </button>
        {aside && <span className="ml-auto min-w-0 flex justify-end text-[10px]" style={{ color: "var(--text4)" }}>{aside}</span>}
      </div>
      {!shut && children}
    </section>
  );
}

/** The kind of card, as a small coloured mark; the colours are the house's, not Atlassian's. */
const TYPE_TONE: Record<string, string> = { epic: "--primary", story: "--success", bug: "--error", task: "--info", subtask: "--text3", "sub-task": "--text3" };
export function TypeMark({ type }: { type?: string }) {
  if (!type) return null;
  const tone = TYPE_TONE[type.toLowerCase()] ?? "--text3";
  return (
    <span title={type} aria-label={type} className="shrink-0 inline-flex items-center justify-center text-[8.5px] font-semibold rounded"
      style={{ width: ICON.sm, height: ICON.sm, color: `var(${tone})`, background: `color-mix(in srgb, var(${tone}) 16%, transparent)` }}>
      {type[0]!.toUpperCase()}
    </span>
  );
}

/**
 * One card in a list: its kind, key, title, priority and status; a click on the row opens the card in the app.
 * `tail` replaces the status mark where the row has a control for it (a sub-task's own status), and `after` sits at
 * the row's end, outside the button that opens the card (a remove control): a control inside a button is not a control.
 */
export function CardRow({ t, title, tail, after }: { t: ProviderTask; title?: string; tail?: ReactNode; after?: ReactNode }) {
  const k = t.customId ?? t.id;
  const done = t.statusKind === "done";
  return (
    <div className="flex items-center gap-2 min-w-0 w-full" style={{ borderBottom: LINE }}>
      <button onClick={() => openCard(k, k, "jira")} title={title ?? `Open ${k}`}
        className="agx-btn flex items-center gap-2 min-w-0 flex-1 text-left text-[11px] py-1.5">
        <TypeMark type={t.issueType} />
        <span className="tabular-nums shrink-0" style={{ color: "var(--text3)", textDecoration: done ? "line-through" : undefined }}>{k}</span>
        <span className="flex-1 min-w-0 truncate" style={{ color: done ? "var(--text3)" : "var(--text)" }}>{t.title}</span>
        {t.priority && <span className="shrink-0 inline-flex" title={prioLook(t.priority).label}><Flag c={prioLook(t.priority).c} on /></span>}
        {tail === undefined && <StatusPill status={t.status} color={t.statusColor} dim={done} />}
      </button>
      {tail}
      {after}
    </div>
  );
}

/** Jira's progress line for sub-tasks: how much of the bar is done. */
export function Progress({ rows }: { rows: ProviderTask[] }) {
  const done = rows.filter((r) => r.statusKind === "done").length;
  const pct = Math.round((done / rows.length) * 100);
  return (
    <div className="h-1 rounded-full mb-1.5 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of the subtasks are done`}
      style={{ background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--success)" }} />
    </div>
  );
}

/** Subtasks with Jira's progress line: how many are done of how many there are. */
export function SubtasksSection({ rows }: { rows: ProviderTask[] }) {
  if (!rows.length) return null;
  const done = rows.filter((r) => r.statusKind === "done").length;
  return (
    <Section id="subtasks" title="Subtasks" count={rows.length} aside={`${done} of ${rows.length} done`}>
      <Progress rows={rows} />
      <div className="flex flex-col">{rows.map((s) => <CardRow key={s.id} t={s} />)}</div>
    </Section>
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
    <Section id="linked" title="Linked work items" count={linked.length}>
      {groupLinked(linked).map((g) => (
        <div key={g.phrase} className="mb-1.5">
          <div className="text-[10px] mt-1 -mb-0.5" style={{ color: "var(--text4)" }}>{g.phrase}</div>
          {g.rows.map((l) => <CardRow key={l.id} t={l.task} title={`${l.type}: ${g.phrase} ${l.task.customId ?? l.task.id}`} />)}
        </div>
      ))}
    </Section>
  );
}

/** Every remote link of the card, not only the pull requests; a pull request among them is also in Development. */
export function WebLinksSection({ links, error }: { links: CardWebLink[] | null; error: string }) {
  // Nothing read yet or nothing there: no heading, as for any other empty section. A failed read says so.
  if (links === null) return null;
  if (!links.length && !error) return null;
  return (
    <Section id="weblinks" title="Web links" count={links.length || undefined}>
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
    </Section>
  );
}

/** The card's files by name, size, who and when: the bytes are not drawn here (see the file's note). */
export function AttachmentsSection({ files }: { files: CardAttachment[] }) {
  if (!files.length) return null;
  return (
    <Section id="attachments" title="Attachments" count={files.length}>
      <div className="flex flex-col">
        {files.map((a) => (
          <div key={a.id} className="flex items-center gap-2 min-w-0 text-[11px] py-1.5" style={{ borderBottom: LINE }}>
            <span className="shrink-0 text-[9px] uppercase tabular-nums rounded px-1" style={{ background: "var(--bg4)", color: "var(--text3)", minWidth: 28, textAlign: "center" }}>{a.ext || "file"}</span>
            <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text)" }} title={a.title}>{a.title}</span>
            <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>
              {[fileSize(a.size), a.who, a.at ? `${fmtAgo(a.at)} ago` : ""].filter(Boolean).join(" · ")}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

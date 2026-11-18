/*
 * "Family", "Dependencies" and "Related": under the card's title, always on screen (not a tab). Family: the umbrella this card belongs
 * to with how far it is and the sibling cards in Jira's order (this one marked). Dependencies: what blocks it or it blocks. Related:
 * every other link type, under the site's own phrase. A card that is part of something bigger is not merged or
 * moved alone by mistake. Alt+[ / Alt+] go to the previous / next sibling (a bare [ ] already belong to the sidebar).
 */
import { useEffect, useMemo, useState } from "react";
import type { ProviderTask, TaskDetail } from "../../../../../shared/providers.ts";
import { api } from "../../../lib/api.ts";
import { familyBlockOf, familyHasContent, familyOpen, hasDependencies, hasFamily, hasRelated, siblingStep, type DepRow, type FamilyModel, type RelatedRow } from "../../../lib/familyBlock.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { CaretIcon, WarningIcon as WarnIcon } from "../../../lib/glyphIcons.tsx";
import { load as remoteLoad, peek } from "../../../lib/remoteStore.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { StateChip } from "../DockParts.tsx";
import { TypeMark } from "../JiraSections.tsx";
import { PeopleFaces } from "../list/PeopleFaces.tsx";
import { Pr } from "../list/JiraRow.tsx";

const STORE = "agx.family.open";
const TTL = 5 * 60_000;
const read = (): string | null => { try { return localStorage.getItem(STORE); } catch { return null; } };
const write = (v: string): void => { try { localStorage.setItem(STORE, v); } catch { /* private window: the choice lasts this visit */ } };

type ParentRead = { detail: TaskDetail; more: number };

/** The umbrella's own read, shared with the card cache under the same key, so opening it afterwards costs nothing. */
export function useCardRead(key: string | null): TaskDetail | null {
  const [d, setD] = useState<TaskDetail | null>(() => (key ? peek<ParentRead>(`jira:${key}`).value?.detail ?? null : null));
  useEffect(() => {
    if (!key) { setD(null); return; }
    let live = true;
    setD(peek<ParentRead>(`jira:${key}`).value?.detail ?? null);
    void remoteLoad<ParentRead>(`jira:${key}`, () => api.jiraDetail(key).then((r) => {
      if (!r.ok || !r.detail) throw new Error(r.error || `${key} could not be read`);
      return { detail: r.detail, more: r.more ?? 0 };
    }), TTL).then((h) => { if (live) setD(h.detail); }, () => undefined);
    return () => { live = false; };
  }, [key]);
  return d;
}

function DepLine({ d, onOpen }: { d: DepRow; onOpen?: ((key: string) => void) | undefined }) {
  return (
    <button type="button" className="agx-fam-dep" data-way={d.way} data-done={d.resolved ? "" : undefined} onClick={() => onOpen?.(d.key)} disabled={!onOpen}
      data-tip={tipAttr({ name: d.key, mono: true, text: `${d.phrase}${d.from === "umbrella" ? " (on the umbrella)" : ""}${d.via === "text" ? " - named in the card text" : ""}` })}>
      <span className="agx-fam-way">{d.way === "blockedBy" ? "Blocked by" : "Blocks"}</span>
      <span className="agx-fam-key">{d.key}</span>
      <span className="agx-fam-ttl">{d.title}</span>
      <StateChip status={d.status} done={d.resolved} h={18} />
    </button>
  );
}

function RelatedLine({ r, onOpen }: { r: RelatedRow; onOpen?: ((key: string) => void) | undefined }) {
  return (
    <button type="button" className="agx-fam-dep" data-done={r.resolved ? "" : undefined} onClick={() => onOpen?.(r.key)} disabled={!onOpen}
      data-tip={tipAttr({ name: r.key, mono: true, text: `${r.type}: ${r.phrase}` })}>
      <span className="agx-fam-key">{r.key}</span>
      <span className="agx-fam-ttl">{r.title}</span>
      <StateChip status={r.status} done={r.resolved} h={18} />
    </button>
  );
}

export function FamilyView({ m, open, onToggle, onOpen }: { m: FamilyModel; open: boolean; onToggle: () => void; onOpen?: ((key: string) => void) | undefined }) {
  const u = m.umbrella;
  const pct = u?.progress && u.progress.total ? Math.round((u.progress.done / u.progress.total) * 100) : 0;
  return (
    <>
      {hasFamily(m) && (
        <section className="agx-fam" aria-label="Family" data-open={open ? "" : undefined}>
          <div className="agx-fam-head">
            <button type="button" className="agx-fam-fold" aria-expanded={open} onClick={onToggle}
              data-tip={tipAttr({ name: open ? "Show less" : "Show the siblings", hint: { key: "Alt+[ ]", text: "previous / next sibling" } })}>
              <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "none" }}><CaretIcon size={ICON.xs} /></span>
              <span>Family</span>
            </button>
          </div>
          {u && (
            <button type="button" className="agx-fam-umb" onClick={() => onOpen?.(u.key)} disabled={!onOpen}
              data-tip={tipAttr({ name: u.key, mono: true, text: u.title || "Open the umbrella card." })}>
              <TypeMark type={u.type} size={ICON.md} />
              <span className="agx-fam-key">{u.key}</span>
              <span className="agx-fam-ttl">{u.title}</span>
              {u.status && <StateChip status={u.status} color={u.color} done={u.statusKind === "done"} h={18} />}
              {u.progress && u.progress.total > 0 && (
                <span className="agx-fam-prog" data-tip={tipAttr(`${u.progress.done} of ${u.progress.total} sub-tasks done`)}>
                  <span className="agx-fam-bar" aria-hidden><i style={{ width: `${pct}%` }} /></span>
                  <span>{u.progress.done} of {u.progress.total} done</span>
                </span>
              )}
            </button>
          )}
          {m.hint && <div className="agx-fam-hint" data-alert={m.hint.alert ? "" : undefined}>{m.hint.text}</div>}
          {(open || !u) && (m.siblings.length > 0 || m.children.length > 0) && (
            <div className="agx-fam-sibs" role="list" aria-label={u ? "Sibling cards" : "Sub-tasks"}>
              {(u ? m.siblings : m.children).map((s) => (
                <button key={s.id} type="button" role="listitem" className="agx-fam-sib" aria-current={s.current ? "true" : undefined} onClick={() => !s.current && onOpen?.(s.key)}
                  data-tip={tipAttr({ name: s.key, mono: true, text: s.current ? "This card" : s.task.title })}>
                  <span className="agx-fam-key">{s.key}</span>
                  <span className="agx-fam-ttl">{s.current ? "this card" : s.task.title}</span>
                  <Pr card={s.task} />
                  <StateChip status={s.task.status} color={s.task.statusColor} done={s.task.statusKind === "done"} h={18} />
                  <PeopleFaces people={(s.task.people ?? []).slice(0, 1)} />
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {hasDependencies(m) && (
        <section className="agx-fam" aria-label="Dependencies" data-blocked={m.warning ? "" : undefined}>
          <div className="agx-fam-head">
            <span className="agx-fam-fold" style={{ cursor: "default" }}>Dependencies</span>
            {m.warning && <span className="agx-fam-warn" role="alert"><WarnIcon size={ICON.xs} /><span className="agx-jb-trunc">{m.warning}</span></span>}
          </div>
          {m.deps.length > 0 && <div className="agx-fam-deps">{m.deps.map((d) => <DepLine key={`${d.from}-${d.way}-${d.key}`} d={d} onOpen={onOpen} />)}</div>}
          {m.mentioned.length > 0 && <div className="agx-fam-hint">Mentioned in the text: {m.mentioned.join(", ")}</div>}
        </section>
      )}
      {hasRelated(m) && (
        <section className="agx-fam" aria-label="Related">
          <div className="agx-fam-head"><span className="agx-fam-fold" style={{ cursor: "default" }}>Related</span></div>
          {m.related.map((g) => (
            <div key={g.phrase} className="agx-fam-deps" role="group" aria-label={g.phrase}>
              <div className="agx-fam-hint agx-fam-phrase">{g.phrase}</div>
              {g.rows.map((r) => <RelatedLine key={`${g.phrase}-${r.key}`} r={r} onOpen={onOpen} />)}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

export function FamilyBlock({ card, detail, onOpenByKey }: { card: ProviderTask; detail: TaskDetail | null; onOpenByKey?: ((key: string) => void) | undefined }) {
  const parentKey = /^sub-?task$/i.test((card.issueType ?? "").replace(/\s+/g, "")) ? card.parent?.key ?? null : null;
  const parent = useCardRead(parentKey);
  const m = useMemo(() => familyBlockOf({
    card, linked: detail?.linked, description: detail?.description, subtasks: detail?.subtasks,
    parent: parent ? { task: parent.task, subtasks: parent.subtasks, linked: parent.linked } : null,
  }), [card, detail?.linked, detail?.description, detail?.subtasks, parent]);
  const [stored, setStored] = useState<string | null>(read);
  const open = familyOpen(stored, m);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.code !== "BracketLeft" && e.code !== "BracketRight")) return;
      const to = siblingStep(m.siblings, e.code === "BracketRight" ? 1 : -1);
      if (to && onOpenByKey) { e.preventDefault(); onOpenByKey(to); }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [m.siblings, onOpenByKey]);
  if (!familyHasContent(m)) return null;
  return <FamilyView m={m} open={open} onOpen={onOpenByKey} onToggle={() => { const v = open ? "compact" : "open"; setStored(v); write(v); }} />;
}

export const FAMILY_CSS = `
.agx-fam{display:flex;flex-direction:column;gap:6px;margin:12px 16px 8px;padding:8px 10px;border-radius:8px;background:var(--surface-card);max-height:240px;overflow-y:auto;min-width:0;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 10%,transparent)}
.agx-fam[data-blocked]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--error) 45%,transparent)}
.agx-fam-head{display:flex;align-items:center;gap:8px;min-width:0}
.agx-fam-fold{display:inline-flex;align-items:center;gap:4px;height:20px;font-size:11px;font-weight:600;color:var(--text3);background:none;border:0;cursor:pointer;flex:none}
.agx-fam-umb,.agx-fam-sib,.agx-fam-dep{display:flex;align-items:center;gap:8px;min-width:0;width:100%;min-height:26px;padding:0 6px;border:0;border-radius:6px;background:transparent;font-size:12px;color:var(--text);text-align:left;cursor:pointer}
.agx-fam-umb:hover,.agx-fam-sib:hover,.agx-fam-dep:hover{background:color-mix(in srgb,var(--text) 6%,transparent)}
.agx-fam-sib[aria-current]{background:color-mix(in srgb,var(--jira-accent) 12%,transparent);box-shadow:inset 2px 0 0 var(--jira-accent);cursor:default}
.agx-fam-key{flex:none;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--jira-accent)}
.agx-fam-ttl{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agx-fam-prog{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:10.5px;color:var(--text3)}
.agx-fam-bar{width:56px;height:4px;border-radius:2px;background:color-mix(in srgb,var(--text) 12%,transparent);overflow:hidden}
.agx-fam-bar i{display:block;height:100%;background:var(--success)}
.agx-fam-hint{font-size:11px;color:var(--text3);padding:0 6px}
.agx-fam-hint[data-alert]{color:var(--warning-ink)}
.agx-fam-phrase{text-transform:none;font-weight:600}
.agx-fam-way{flex:none;width:68px;font-size:11px;font-weight:600}
.agx-fam-dep[data-way="blockedBy"] .agx-fam-phrase{text-transform:none;font-weight:600}
.agx-fam-way{color:var(--error-ink)}
.agx-fam-dep[data-way="blocks"] .agx-fam-phrase{text-transform:none;font-weight:600}
.agx-fam-way{color:var(--warning-ink)}
.agx-fam-dep[data-done] .agx-fam-phrase{text-transform:none;font-weight:600}
.agx-fam-way{color:var(--success-ink)}
.agx-fam-dep[data-done] .agx-fam-key,.agx-fam-dep[data-done] .agx-fam-ttl{text-decoration:line-through;opacity:.7}
`;

/** The one-line warning for a card with an open "is blocked by" link, for places that show the card without the block (the pull request panel). */
export function BlockerWarning({ cardKey }: { cardKey: string }) {
  const d = useCardRead(cardKey);
  const warning = useMemo(() => (d ? familyBlockOf({ card: d.task, linked: d.linked, description: d.description }).warning : null), [d]);
  if (!warning) return null;
  return <span className="agx-fam-warn" role="alert" style={{ alignSelf: "flex-start", maxWidth: "100%" }}><WarnIcon size={ICON.xs} /><span className="agx-jb-trunc">{warning}</span></span>;
}

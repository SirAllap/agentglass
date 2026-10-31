/*
 * What a Jira card is joined to, with the controls to change it: sub-tasks
 * (add one, change a row's status in place), linked work items (link another
 * card, take a link off) and web links (add an address, take one off).
 *
 * Drawn only where writing is on (the read-only sections in JiraSections.tsx
 * are what stays when it is off). The rules every control here keeps:
 *   - The "+" of a section is in its header, at its right end, in every state;
 *     the line a change says ("ORBIT-1042 blocks ORBIT-1050 linked", with Undo)
 *     takes the place of the count to its left, so nothing moves.
 *   - A link is said BEFORE it is made (the picker shows "ORBIT-1042 blocks
 *     ORBIT-1050" and a Link button), and a removal asks in place, saying what
 *     goes, before anything is sent.
 *   - Undo is offered where the site lets the old state come back: a link or an
 *     address added is taken off again, one taken off is put back. A sub-task
 *     made has none (the site's delete is not ours).
 *   - Every state is drawn: reading the link types, searching, nothing found,
 *     refused (the server's sentence, kept beside the control).
 *
 * Ceiling: the picker searches with the board's own text search, so a card the
 * person cannot see is not found; the sub-task type is the project's first.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { api, type JiraLinkKind } from "../../lib/api.ts";
import { followLink } from "../../lib/linkRouter.ts";
import { ICON } from "../../lib/iconSize.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { canHaveSubtasks, linkEffect, linkWays, madeLink, parseCardId, parseSubtaskTitle, parseWebAddress, type LinkWay } from "../../lib/jiraJoins.ts";
import type { CardLinked, CardWebLink, ProviderTask } from "../../../../shared/providers.ts";
import { CloseButton } from "../CloseButton.tsx";
import { Select } from "../Select.tsx";
import { StatusPill } from "../StatusPill.tsx";
import { TrackerStatusPick } from "../TrackerStatusPick.tsx";
import { CommentAction } from "../tasks/CardEdit.tsx";
import { Button, EDGE, LINE, ListRow } from "../workspace/Chrome.tsx";
import { CardRow, Progress, JiraSection, groupLinked } from "./JiraSections.tsx";

/** What the pane gives the joins to change the card with; each says why it did not land, or null. */
export interface JoinAct {
  subtask: (title: string) => Promise<string | null>;
  relate: (other: string, way: LinkWay) => Promise<{ error?: string; made?: CardLinked }>;
  unrelate: (l: CardLinked) => Promise<string | null>;
  webAdd: (url: string, title: string) => Promise<{ error?: string; made?: CardWebLink }>;
  webRemove: (w: CardWebLink) => Promise<string | null>;
  /** A sub-task's own status changed: the row as it now is. */
  onRowTask: (t: ProviderTask) => void;
}

const PLUS = "M12 5v14M5 12h14";
const INPUT_STYLE = { background: "var(--bg)", color: "var(--text)", border: EDGE } as const;

export interface Said { text: string; warn?: boolean; undo?: () => Promise<string | null> }

/** The line a change leaves in the section's header, with its Undo; and the "+" that opens the section's form, always at the end. */
export function Aside({ plain, said, onSaid, open, onToggle, label, canAdd }: {
  plain: ReactNode; said: Said | null; onSaid: (s: Said | null) => void; open: boolean; onToggle: () => void; label: string; canAdd: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {said ? (
        <span className="inline-flex items-center gap-1.5 min-w-0" role={said.warn ? "alert" : "status"} style={{ color: said.warn ? "var(--warning-ink)" : "var(--success-ink)" }}>
          <span className="truncate min-w-0" title={said.text}>{said.text}</span>
          {said.undo && (
            <Button size="compact" className="shrink-0" disabled={busy} title="Put it back"
              onClick={async () => { setBusy(true); const why = await said.undo!(); setBusy(false); onSaid(why ? { text: why, warn: true } : { text: "Put back" }); }}>Undo</Button>
          )}
          <CloseButton size={ICON.xs} onClick={() => onSaid(null)} title="Dismiss" />
        </span>
      ) : plain}
      {canAdd && <CommentAction iconOnly label="Add" title={label} d={PLUS} on={open} tone="var(--primary)" onClick={onToggle} />}
    </span>
  );
}

/** A one-line form: what is typed, and the two buttons. Enter sends, Escape closes and reaches nothing behind it. */
function Line({ children, busy, ok, onSend, onCancel, sendLabel, error }: {
  children: ReactNode; busy: boolean; ok: boolean; onSend: () => void; onCancel: () => void; sendLabel: string; error: string;
}) {
  return (
    <form className="flex flex-col gap-1.5 mb-2" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onSend(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      {children}
      <div className="flex items-center gap-2 text-[10.5px]">
        <Button type="submit" size="compact" disabled={!ok || busy}>{busy ? "Saving…" : sendLabel}</Button>
        <Button size="compact" tone="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
        {error && <span role="alert" className="min-w-0 truncate" title={error} style={{ color: "var(--error-ink)" }}>{error}</span>}
      </div>
    </form>
  );
}

export const Ask = ({ children, onYes, onNo, yes, busy }: { children: ReactNode; onYes: () => void; onNo: () => void; yes: string; busy: boolean }) => (
  <div className="flex items-center gap-2 py-1.5 text-[10.5px] flex-wrap" role="alertdialog" style={{ borderBottom: LINE }}>
    <span className="min-w-0" style={{ color: "var(--text2)" }}>{children}</span>
    <Button size="compact" tone="danger" disabled={busy} onClick={onYes}>{busy ? "Working…" : yes}</Button>
    <Button size="compact" tone="quiet" disabled={busy} onClick={onNo}>Keep it</Button>
  </div>
);

// --- sub-tasks --------------------------------------------------------------

export function SubtasksBlock({ rows, parent, writable, act, onMenu }: { rows: ProviderTask[]; parent: ProviderTask; writable: boolean; act: JoinAct; onMenu?: (e: MouseEvent, t: ProviderTask) => void }) {
  const canAdd = writable && canHaveSubtasks(parent.issueType);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [said, setSaid] = useState<Said | null>(null);
  useEffect(() => { setOpen(false); setTitle(""); setErr(""); setSaid(null); }, [parent.id]);
  if (!rows.length && !canAdd) return null;
  const done = rows.filter((r) => r.statusKind === "done").length;

  const send = async () => {
    setBusy(true); setErr("");
    const why = await act.subtask(title.trim());
    setBusy(false);
    if (why) { setErr(why); return; }
    setSaid({ text: `Sub-task “${title.trim().slice(0, 30)}” added` });
    setTitle(""); setOpen(false);
  };
  const rowSaid = (s: string) => setSaid(s === "moving…" ? { text: "Moving…" } : s.startsWith("!") ? { text: s.slice(1), warn: true } : { text: `Moved: ${s}` });

  return (
    <JiraSection id="subtasks" title="Subtasks" meter={rows.length ? <Progress rows={rows} /> : undefined}
      aside={<Aside plain={rows.length ? `${done} of ${rows.length} done` : null} said={said} onSaid={setSaid} open={open} onToggle={() => { setOpen((o) => !o); setErr(""); }} label="Add a sub-task" canAdd={canAdd} />}>
      {open && (
        <Line busy={busy} ok={parseSubtaskTitle(title).ok} onSend={() => void send()} onCancel={() => { setOpen(false); setErr(""); }} sendLabel="Add" error={err}>
          <input value={title} autoFocus disabled={busy} aria-label="What the sub-task is" placeholder="What needs doing?" maxLength={255}
            onChange={(e) => { setTitle(e.target.value); setErr(""); }} className="w-full text-[11.5px] rounded px-2 py-1.5 outline-none" style={INPUT_STYLE} />
        </Line>
      )}
      {!rows.length && <div className="text-[11px]" style={{ color: "var(--text4)" }}>No sub-tasks yet.</div>}
      <div className="agx-dk-stack">
        {rows.map((s) => (
          <CardRow key={s.id} t={s} onMenu={onMenu} tail={writable
            ? <span className="shrink-0"><TrackerStatusPick tracker={TRACKERS.jira} task={s} query={s.customId ?? s.id} onSaid={rowSaid} onTask={act.onRowTask} align="right" chip={22} /></span>
            : undefined} />
        ))}
      </div>
    </JiraSection>
  );
}

// --- linked work items ------------------------------------------------------

export function LinkedBlock({ linked, card, writable, act }: { linked: CardLinked[]; card: string; writable: boolean; act: JoinAct }) {
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<JiraLinkKind[] | null>(null);
  const [kindsErr, setKindsErr] = useState("");
  const [way, setWay] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ProviderTask[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ProviderTask | null>(null);
  const [byId, setById] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [said, setSaid] = useState<Said | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const tok = useRef(0);
  useEffect(() => { setOpen(false); setQ(""); setFound(null); setPicked(null); setById(""); setErr(""); setSaid(null); setAsking(null); }, [card]);

  const ensureKinds = useCallback(async (): Promise<JiraLinkKind[] | null> => {
    if (kinds) return kinds;
    const r = await api.jiraLinkTypes().catch(() => null);
    if (r?.ok && r.kinds) { setKinds(r.kinds); setKindsErr(""); return r.kinds; }
    setKindsErr(r?.error || "Could not read the site's link types");
    return null;
  }, [kinds]);
  useEffect(() => { if (open && !kinds) void ensureKinds().then((k) => { if (k?.length) setWay((w) => w || linkWays(k)[0]!.value); }); }, [open, kinds, ensureKinds]);

  // Typing asks the board's own search once the keys pause; a card id typed whole is also taken as it is.
  useEffect(() => {
    if (!open || picked) return;
    const text = q.trim();
    if (text.length < 2) { setFound(null); setSearching(false); return; }
    const mine = ++tok.current;
    setSearching(true);
    const h = setTimeout(() => {
      void api.jiraSearch(text).then((r) => {
        if (mine !== tok.current) return;
        setFound(r.ok ? (r.tasks ?? []).filter((t) => (t.customId ?? t.id) !== card).slice(0, 8) : []);
        if (!r.ok) setErr(r.error || "Jira did not answer");
      }).catch(() => { if (mine === tok.current) { setFound([]); setErr("Could not reach agentglass"); } })
        .finally(() => { if (mine === tok.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(h);
  }, [q, open, picked, card]);

  const ways = kinds ? linkWays(kinds) : [];
  const chosen = ways.find((w) => w.value === way) ?? ways[0];
  const other = picked ? (picked.customId ?? picked.id) : byId.trim().toUpperCase();
  const close = () => { setOpen(false); setQ(""); setFound(null); setPicked(null); setById(""); setErr(""); };

  const kindOf = async (l: CardLinked): Promise<LinkWay | null> => {
    const ks = await ensureKinds();
    const k = ks?.find((x) => x.name === l.type);
    return k ? { value: "", typeId: k.id, outward: l.direction === "out", phrase: l.phrase, kind: k.name } : null;
  };
  const undoRelate = (l: CardLinked): (() => Promise<string | null>) => async () => {
    const back = await act.unrelate(l);
    return back;
  };

  const send = async () => {
    if (!chosen || !other) return;
    setBusy(true); setErr("");
    const r = await act.relate(other, chosen);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    const text = `${linkEffect(card, chosen, other)} linked`;
    setSaid({ text, ...(r.made ? { undo: undoRelate(r.made) } : null) });
    close();
  };
  const remove = async (l: CardLinked) => {
    const k = l.task.customId ?? l.task.id;
    const back = await kindOf(l);
    setBusy(true);
    const why = await act.unrelate(l);
    setBusy(false);
    setAsking(null);
    if (why) { setSaid({ text: why, warn: true }); return; }
    setSaid({
      text: `${card} ${l.phrase} ${k} taken off`,
      ...(back ? { undo: async () => { const r = await act.relate(k, back); return r.error ?? null; } } : null),
    });
  };

  if (!linked.length && !writable) return null;
  return (
    <JiraSection id="linked" title="Linked work items" count={linked.length || undefined}
      aside={<Aside plain={null} said={said} onSaid={setSaid} open={open} onToggle={() => (open ? close() : setOpen(true))} label="Link another work item" canAdd={writable} />}>
      {open && (
        <Line busy={busy} ok={!!chosen && !!other && (picked ? true : parseCardId(other).ok)} onSend={() => void send()} onCancel={close} sendLabel="Link" error={err || kindsErr}>
          {kinds && ways.length > 0 && (
            <Select value={chosen?.value ?? ""} onChange={setWay} title="How this card is linked" options={ways.map((w) => ({ value: w.value, label: w.phrase, hint: w.kind }))} />
          )}
          {!kinds && !kindsErr && <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>Reading the site's link types…</span>}
          {picked ? (
            <div className="flex items-center gap-2 text-[11px] min-w-0">
              <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{chosen ? linkEffect(card, chosen, other) : other}</span>
              <Button size="compact" className="shrink-0" onClick={() => setPicked(null)} title="Pick another card">Change</Button>
            </div>
          ) : (
            <>
              <input value={q} autoFocus disabled={busy} aria-label="Search for the card to link" placeholder="Search by id or words"
                onChange={(e) => { setQ(e.target.value); setById(e.target.value); setErr(""); }}
                className="w-full text-[11.5px] rounded px-2 py-1.5 outline-none" style={INPUT_STYLE} />
              {searching && <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>Searching…</span>}
              {found && !searching && !found.length && q.trim().length >= 2 && <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>Nothing found: a card id typed whole (ORBIT-1042) can still be linked.</span>}
              {found && found.length > 0 && (
                <div className="flex flex-col rounded" style={{ border: EDGE }}>
                  {found.map((t) => (
                    <ListRow key={t.id} onClick={() => { setPicked(t); setErr(""); }} title={`Link ${t.customId ?? t.id}`}
                      trailing={<StatusPill status={t.status} color={t.statusColor} dim={t.statusKind === "done"} />}>
                      <span className="tabular-nums mr-2" style={{ color: "var(--text3)" }}>{t.customId ?? t.id}</span>
                      <span style={{ color: "var(--text)" }}>{t.title}</span>
                    </ListRow>
                  ))}
                </div>
              )}
            </>
          )}
        </Line>
      )}
      {!linked.length && <div className="text-[11px]" style={{ color: "var(--text4)" }}>No linked work items.</div>}
      <div className="agx-dk-stack">
      {groupLinked(linked).flatMap((g) => g.rows.map((l) => (
            <div key={l.id}>
              <CardRow t={l.task} note={g.phrase} title={`${l.type}: ${g.phrase} ${l.task.customId ?? l.task.id}`}
                after={writable ? <CloseButton size={ICON.xs} onClick={() => setAsking(l.id)} title={`Take off the link to ${l.task.customId ?? l.task.id}`} /> : undefined} />
              {asking === l.id && (
                <Ask yes="Take off" busy={busy} onYes={() => void remove(l)} onNo={() => setAsking(null)}>
                  Take {card} {l.phrase} {l.task.customId ?? l.task.id} off? You can put it back right after.
                </Ask>
              )}
            </div>
          )))}
      </div>
    </JiraSection>
  );
}

// --- web links --------------------------------------------------------------

export function WebLinksBlock({ links, error, writable, card, act }: { links: CardWebLink[] | null; error: string; writable: boolean; card: string; act: JoinAct }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [said, setSaid] = useState<Said | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setUrl(""); setTitle(""); setErr(""); setSaid(null); setAsking(null); }, [card]);
  if (links === null) return null;
  if (!links.length && !error && !writable) return null;
  const close = () => { setOpen(false); setUrl(""); setTitle(""); setErr(""); };

  const send = async () => {
    setBusy(true); setErr("");
    const r = await act.webAdd(url.trim(), title.trim());
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    const made = r.made;
    setSaid({ text: `${made?.host ?? "Address"} added`, ...(made ? { undo: () => act.webRemove(made) } : null) });
    close();
  };
  const remove = async (w: CardWebLink) => {
    setBusy(true);
    const why = await act.webRemove(w);
    setBusy(false); setAsking(null);
    setSaid(why ? { text: why, warn: true } : { text: `${w.host} taken off`, undo: async () => (await act.webAdd(w.url, w.title)).error ?? null });
  };

  return (
    <JiraSection id="weblinks" title="Web links" count={links.length || undefined}
      aside={<Aside plain={null} said={said} onSaid={setSaid} open={open} onToggle={() => (open ? close() : setOpen(true))} label="Add a web link" canAdd={writable} />}>
      {error && <div className="text-[10.5px] mb-1" role="status" style={{ color: "var(--warning-ink)" }}>{error}</div>}
      {open && (
        <Line busy={busy} ok={parseWebAddress(url).ok} onSend={() => void send()} onCancel={close} sendLabel="Add" error={err}>
          <input value={url} autoFocus disabled={busy} aria-label="The address" placeholder="https://" inputMode="url"
            onChange={(e) => { setUrl(e.target.value); setErr(""); }} className="w-full text-[11.5px] rounded px-2 py-1.5 outline-none" style={INPUT_STYLE} />
          <input value={title} disabled={busy} aria-label="What to call it" placeholder="Title (the site’s name if empty)" maxLength={200}
            onChange={(e) => setTitle(e.target.value)} className="w-full text-[11.5px] rounded px-2 py-1.5 outline-none" style={INPUT_STYLE} />
        </Line>
      )}
      {!links.length && !error && <div className="text-[11px]" style={{ color: "var(--text4)" }}>No web links.</div>}
      <div className="flex flex-col">
        {links.map((l) => (
          <div key={l.id}>
            <div className="flex items-center gap-2 min-w-0 w-full" style={{ borderBottom: LINE }}>
              <button onClick={(e) => followLink(l.url, e)} title={l.url} className="agx-btn flex items-center gap-2 min-w-0 flex-1 text-left text-[11px] py-1.5">
                <span className="shrink-0 inline-flex items-center justify-center text-[9px] font-medium rounded"
                  style={{ width: ICON.sm, height: ICON.sm, background: "var(--bg4)", color: "var(--text3)" }} aria-hidden>{(l.host[0] ?? "?").toUpperCase()}</span>
                <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text)" }}>{l.title}</span>
                <span className="shrink-0 text-[10px] truncate" style={{ color: "var(--text4)", maxWidth: "40%" }}>{l.host}</span>
              </button>
              {writable && <CloseButton size={ICON.xs} onClick={() => setAsking(l.id)} title={`Take off ${l.host}`} />}
            </div>
            {asking === l.id && (
              <Ask yes="Take off" busy={busy} onYes={() => void remove(l)} onNo={() => setAsking(null)}>
                Take {l.host} off {card}?{l.pr ? " It is a pull request, so the Development list loses it too." : ""} You can put it back right after.
              </Ask>
            )}
          </div>
        ))}
      </div>
    </JiraSection>
  );
}


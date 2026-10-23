/*
 * The Jira tab: every open card assigned to you, on the site you connected.
 *
 * Its first view is the answer to "what is on me" and the place a bell
 * notification lands. Boards, saved filters and searches sit beside it in a
 * rail, read-only, grouped by the board's own columns or by status. Nothing here names a status, a workflow or a project:
 * the pill takes its words from the card and its colour from the status
 * category the site reports.
 *
 * When it asks again is decided in lib/jiraMine.ts and lib/boardPoll.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { BOARD_TICK_MS, boardDue } from "../lib/boardPoll.ts";
import { mineNote, rowFor } from "../lib/jiraMine.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";
import { chipInk } from "../lib/contrast.ts";
import type { CardJump } from "../lib/openCard.ts";
import { ASSIGNED_VIEW_ID } from "../../../shared/providers.ts";
import type { JiraViewRead, JiraViews, ProviderTask } from "../../../shared/providers.ts";
import { columnGroups, railEntries, statusGroups, viewNote, type RailEntry } from "../lib/jiraViews.ts";
import { EDGE, LINE, RefreshButton } from "./workspace/Chrome.tsx";
import { Spinner } from "./Spinner.tsx";
import { GroupHead } from "./tasks/GroupHead.tsx";
import { ViewRail } from "./jira/ViewRail.tsx";
import { AddBar } from "./jira/AddBar.tsx";
import { TrackerStatusPick } from "./TrackerStatusPick.tsx";
import { TrackerPeoplePick } from "./TrackerPeoplePick.tsx";
import { TrackerHandOffButton } from "./TrackerHandOffButton.tsx";
import { TRACKERS } from "../lib/trackerApi.ts";
import { replaceTask } from "../lib/jiraMine.ts";
import { JiraCard } from "./jira/JiraCard.tsx";

const DONE_INK = "var(--text3)";

/** The status in the site's own words, tinted by its category colour. */
function StatusPill({ t }: { t: ProviderTask }) {
  const c = t.statusColor;
  return (
    <span className="shrink-0 text-[9.5px] px-1.5 py-px rounded-full whitespace-nowrap"
      style={c
        ? { background: c, color: chipInk(c) }
        : { color: "var(--text2)", border: EDGE }}>
      {t.status || "No status"}
    </span>
  );
}

/** The assignee's face, or their initials when the picture is not there or is not allowed to load. */
function Face({ t }: { t: ProviderTask }) {
  const p = t.people?.[0];
  const [broken, setBroken] = useState(false);
  if (!p) return <span className="shrink-0" style={{ width: 18, height: 18 }} aria-hidden="true" />;
  const size = { width: 18, height: 18, borderRadius: 999 } as const;
  if (p.avatar && !broken) {
    return <img src={p.avatar} alt="" title={p.name} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)}
      className="shrink-0 object-cover" style={size} />;
  }
  return <span title={p.name} className="shrink-0 inline-flex items-center justify-center text-[9px] font-medium"
    style={{ ...size, background: p.color || "var(--bg4)", color: chipInk(p.color) }}>{p.initials}</span>;
}

function Row({ t, on, onPick }: { t: ProviderTask; on: boolean; onPick: () => void }) {
  const done = t.statusKind === "done";
  return (
    <div role="row" tabIndex={0} aria-current={on ? "true" : undefined} onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}
      className="agx-row w-full flex items-center gap-2.5 px-4 py-2 hover:bg-white/5 cursor-pointer"
      style={{
        borderBottom: LINE,
        background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{t.customId ?? t.id}</span>
      <span className="flex-1 min-w-0 truncate text-[11.5px]" style={{ color: done ? DONE_INK : "var(--text)" }}>{t.title}</span>
      <StatusPill t={t} />
      <Face t={t} />
    </div>
  );
}

/** The card's facts, and the three things that change it here: its status, its person, the hand-off. */
function Facts({ t, onTask }: { t: ProviderTask; onTask: (t: ProviderTask) => void }) {
  const url = externalUrl(t.url);
  const [said, setSaid] = useState("");
  const query = t.customId ?? t.id;
  // A said line belongs to the card it was said about.
  useEffect(() => { setSaid(""); }, [t.id]);
  const rows: [string, string | null][] = [
    ["Priority", t.priority],
    ["Project", t.list],
    ["Due", t.due],
    ["Updated", t.updated ? `${fmtAgo(t.updated)} ago` : null],
    ["Labels", t.tags.length ? t.tags.join(", ") : null],
  ];
  return (
    <div className="p-5 flex flex-col gap-3 min-w-0">
      <div className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{t.customId ?? t.id}</div>
      <div className="text-[13px]" style={{ color: "var(--text)" }}>{t.title}</div>
      <dl className="grid gap-x-4 gap-y-1.5 text-[11px] items-center" style={{ gridTemplateColumns: "max-content 1fr" }}>
        <dt style={{ color: "var(--text3)" }}>Status</dt>
        <dd className="min-w-0"><TrackerStatusPick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} /></dd>
        <dt style={{ color: "var(--text3)" }}>Assignee</dt>
        <dd className="min-w-0"><TrackerPeoplePick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} /></dd>
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt style={{ color: "var(--text3)" }}>{k}</dt>
            <dd className="min-w-0 truncate" style={{ color: "var(--text)" }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2 flex-wrap">
        <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />
        {url && (
          <button onClick={() => openExternal(url)} className="self-start text-[10.5px] px-2.5 py-1 rounded-lg" style={{ border: EDGE, color: "var(--text2)" }}>
            Open in Jira ↗
          </button>
        )}
      </div>
      {said && <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>}
    </div>
  );
}

export function JiraBody({ active, jump }: { active: boolean; jump?: CardJump | null }) {
  const [rows, setRows] = useState<ProviderTask[] | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  /** A card named by a jump that is not among yours (moved on, or not yours). */
  const [looked, setLooked] = useState<ProviderTask | null>(null);
  const at = useRef(0);
  const flying = useRef(false);
  const have = useRef(false);

  /* Saved views. `views` is local and cheap; nothing else is asked until it has answered. */
  const [views, setViews] = useState<JiraViews | null>(null);
  const [ready, setReady] = useState(false);
  const [viewId, setViewId] = useState(ASSIGNED_VIEW_ID);
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [reads, setReads] = useState<Record<string, JiraViewRead>>({});
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const readsRef = useRef(reads);
  readsRef.current = reads;
  /** When each view was last read, so coming back to one asks only if it is old. */
  const stamps = useRef<Record<string, number>>({});
  const viewTok = useRef(0);
  const chosen = useRef(false);
  const saved = viewId !== ASSIGNED_VIEW_ID;
  const idRef = useRef(viewId);
  idRef.current = viewId;
  /** Whether writing to Jira is on, asked once when the tab is first shown (a local read). */
  const [writes, setWrites] = useState(false);
  useEffect(() => {
    if (!active) return;
    void api.jiraStatus().then((s) => setWrites(!!s.writes)).catch(() => {});
  }, [active]);

  const loadViews = useCallback(async (land: boolean) => {
    const v = await api.jiraViews().catch(() => null);
    if (v) {
      setViews(v);
      if (land && !chosen.current && v.current && (v.current === ASSIGNED_VIEW_ID || v.views.some((x) => x.id === v.current))) {
        setViewId(v.current);
        const home = v.views.find((x) => x.id === v.current)?.folderId;
        if (home) setOpenFolders((o) => new Set(o).add(home));
      }
    }
    return v;
  }, []);

  useEffect(() => {
    if (!active || ready) return;
    void loadViews(true).finally(() => setReady(true));
  }, [active, ready, loadViews]);

  /** The view on screen: the mine list, or a saved view whose last read on disk draws first. */
  const readView = useCallback(async (id: string, fresh: boolean, tok: number) => {
    if (!fresh && !readsRef.current[id]?.ok) {
      const c = await api.jiraView(id, { cached: true }).catch(() => null);
      if (tok === viewTok.current && c?.ok && c.at) {
        setReads((m) => ({ ...m, [id]: c }));
        setNote(viewNote(c, true));
      }
    }
    if (tok !== viewTok.current) return;
    const r = await api.jiraView(id, fresh ? { force: true } : undefined)
      .catch((): JiraViewRead => ({ ok: false, error: "Could not reach agentglass", tasks: [], columns: [], at: 0 }));
    if (tok !== viewTok.current) return;
    const had = !!readsRef.current[id]?.ok;
    setNote(viewNote(r, had));
    if (r.ok) { at.current = Date.now(); setReads((m) => ({ ...m, [id]: r })); }
    else if (!had) setReads((m) => ({ ...m, [id]: r }));
  }, []);

  const load = useCallback(async (fresh: boolean) => {
    // One read in the air: a second press or a returning focus joins it.
    if (flying.current) return;
    flying.current = true;
    const tok = ++viewTok.current;
    const id = idRef.current;
    setBusy(true);
    try {
      if (id !== ASSIGNED_VIEW_ID) { await readView(id, fresh, tok); return; }
      const r = await api.jiraMine(fresh).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraMine>>));
      if (tok !== viewTok.current) return; // the person moved to another view meanwhile
      setNote(mineNote(r, have.current));
      if (r.ok && r.tasks) { have.current = true; at.current = Date.now(); setRows(r.tasks); }
      else if (!have.current) setRows([]);
    } finally { if (tok === viewTok.current) { flying.current = false; setBusy(false); } }
  }, [readView]);

  useEffect(() => {
    if (!active || !ready) return;
    const looking = () => !document.hidden && document.hasFocus();
    const ask = (cause: "tick" | "focus") => { if (looking() && boardDue(Date.now(), at.current, cause)) void load(false); };
    // Arriving on the tab counts as coming back to it.
    if (boardDue(Date.now(), at.current, "focus")) void load(false);
    const t = setInterval(() => ask("tick"), BOARD_TICK_MS);
    const onFocus = () => ask("focus");
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [active, ready, viewId, load]);

  /* "Show me this card", from the bell: pick it from the list, or read it. */
  useEffect(() => {
    if (!jump || jump.tracker !== "jira") return;
    // The bell's cards are looked up among yours.
    if (saved) { pickView(ASSIGNED_VIEW_ID); return; }
    let live = true;
    const hit = rows && rowFor(rows, jump.query);
    if (hit) { setSel(hit.id); setLooked(null); return; }
    if (!rows) return; // the list is still on its way; this runs again when it lands
    void api.jiraTask(jump.query).then((r) => {
      if (!live) return;
      if (r.ok && r.task) { setLooked(r.task); setSel(r.task.id); }
      else setNote({ text: r.error || `${jump.label} could not be read`, bad: true });
    }).catch(() => {});
    return () => { live = false; };
  }, [jump?.n, rows === null, saved]);

  /* A card a write changed: every list holding it shows the answer, with no read. */
  const changed = (t: ProviderTask) => {
    setRows((r) => (r ? replaceTask(r, t) : r));
    setLooked((l) => (l && l.id === t.id ? t : l));
    setReads((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, tasks: replaceTask(v.tasks, t) }])));
  };
  const pickView = (id: string) => {
    if (id === viewId) return;
    chosen.current = true;
    viewTok.current++; // an answer still on its way for the old view is not wanted
    flying.current = false;
    stamps.current[viewId] = at.current;
    at.current = stamps.current[id] ?? 0;
    setNote(null); setBusy(false); setSel(null);
    setViewId(id);
    // The built-in list is read through /jira/mine, which does not remember
    // the choice; a disk-only read does, with no request to Jira.
    if (id === ASSIGNED_VIEW_ID) void api.jiraView(id, { cached: true }).catch(() => {});
  };
  const removeEntry = async (e: RailEntry) => {
    const r = await (e.kind === "folder" ? api.jiraRemoveFolder(e.id) : api.jiraRemoveView(e.id)).catch(() => ({ ok: false }));
    if (!r.ok) { setNote({ text: `Could not remove ${e.name}`, bad: true }); return; }
    const v = await loadViews(false);
    // The open view may be the one removed, or a board of the project that was.
    if (viewId !== ASSIGNED_VIEW_ID && !v?.views.some((x) => x.id === viewId)) pickView(ASSIGNED_VIEW_ID);
  };
  const toggleFolder = (id: string) => setOpenFolders((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n; });

  const entries = railEntries(views?.views ?? [], views?.folders ?? [], openFolders);
  const viewName = entries.find((e) => e.kind === "view" && e.id === viewId)?.name ?? "";
  const read = saved ? reads[viewId] : undefined;
  const viewRows = read?.tasks ?? [];
  const groups = read?.ok === false ? [] : read ? (read.columns.length ? columnGroups(viewRows, read.columns) : statusGroups(viewRows)) : [];

  const shown = saved ? viewRows
    : looked && !rows?.some((t) => t.id === looked.id) ? [looked, ...(rows ?? [])] : (rows ?? []);
  const picked = shown.find((t) => t.id === sel) ?? null;
  const waiting = saved ? !read : !rows;
  const count = saved ? (read?.ok === false ? null : read ? viewRows.length : null) : rows?.length;

  return (
    <div className="flex flex-1 min-h-0">
      <ViewRail entries={entries} current={viewId} adding={adding} onPick={pickView} onToggle={toggleFolder}
        onRemove={(e) => void removeEntry(e)} onAdd={() => setAdding((a) => !a)} />
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: LINE }}>
          <span className="text-[11px]" style={{ color: "var(--text2)" }}>{saved ? viewName : "Assigned to me"}</span>
          {count != null && <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{count}</span>}
          {saved && read?.ok && read.at > 0 && (
            <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>read {fmtAgo(read.at)} ago</span>
          )}
          <span className="flex-1" />
          <RefreshButton onRefresh={() => void load(true)} busy={busy}
            title="Read the list from Jira now" />
        </div>
        {adding && (
          <AddBar onClose={() => setAdding(false)}
            onAddedView={(id) => { void loadViews(false).then(() => { if (id) pickView(id); setAdding(false); }); }}
            onAddedFolder={() => { void loadViews(false); setAdding(false); }} />
        )}
        {note && (
          <div className="px-4 py-2 text-[11px]" role={note.bad ? "alert" : "status"}
            style={{ color: note.bad ? "var(--error-ink)" : "var(--text3)", borderBottom: LINE }}>{note.text}</div>
        )}
        <div className="flex-1 min-h-0 flex">
          <div className="flex flex-col min-w-0" style={{ width: "52%", borderRight: LINE }}>
            {waiting && <div className="p-4"><Spinner label="Asking Jira…" className="" /></div>}
            {!saved && rows && shown.length === 0 && !note?.bad && (
              <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing is assigned to you.</div>
            )}
            {saved && read?.ok && groups.length === 0 && (
              <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing in this view.</div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto agx-scroll" role="rowgroup">
              {saved
                ? groups.map((g, gi) => {
                  const k = `${viewId}|${g.key}`;
                  return (
                    <div key={k} style={{ marginTop: gi ? 18 : 4 }}>
                      <GroupHead first={!gi} folded={!!folded[k]} count={g.rows.length}
                        onToggle={() => setFolded((f) => ({ ...f, [k]: !f[k] }))}
                        label={<span className="text-[11px] font-medium truncate" style={{ color: g.done ? DONE_INK : "var(--text)" }}>{g.name}</span>} />
                      {!folded[k] && g.rows.map((t) => <Row key={t.id} t={t} on={t.id === sel} onPick={() => setSel(t.id)} />)}
                    </div>
                  );
                })
                : shown.map((t) => <Row key={t.id} t={t} on={t.id === sel} onPick={() => setSel(t.id)} />)}
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {picked
              ? <JiraCard key={picked.id} t={picked} header={<Facts t={picked} onTask={changed} />} writes={writes} onTask={changed} />
              : <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Pick a card.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

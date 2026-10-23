/*
 * The Jira tab: every open card assigned to you, on the site you connected.
 *
 * Deliberately one list. Boards, saved filters and a card editor are later
 * slices; this is the answer to "what is on me" and the place a bell
 * notification lands. Nothing here names a status, a workflow or a project:
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
import type { ProviderTask } from "../../../shared/providers.ts";
import { EDGE, LINE, RefreshButton } from "./workspace/Chrome.tsx";
import { Spinner } from "./Spinner.tsx";

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

function Facts({ t }: { t: ProviderTask }) {
  const url = externalUrl(t.url);
  const rows: [string, string | null][] = [
    ["Status", t.status || null],
    ["Priority", t.priority],
    ["Project", t.list],
    ["Assignee", t.assignees[0] ?? "Unassigned"],
    ["Due", t.due],
    ["Updated", t.updated ? `${fmtAgo(t.updated)} ago` : null],
    ["Labels", t.tags.length ? t.tags.join(", ") : null],
  ];
  return (
    <div className="p-5 flex flex-col gap-3 min-w-0">
      <div className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{t.customId ?? t.id}</div>
      <div className="text-[13px]" style={{ color: "var(--text)" }}>{t.title}</div>
      <dl className="grid gap-x-4 gap-y-1.5 text-[11px]" style={{ gridTemplateColumns: "max-content 1fr" }}>
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt style={{ color: "var(--text3)" }}>{k}</dt>
            <dd className="min-w-0 truncate" style={{ color: "var(--text)" }}>{v}</dd>
          </div>
        ))}
      </dl>
      {url && (
        <button onClick={() => openExternal(url)} className="self-start text-[10.5px] px-2.5 py-1 rounded-lg" style={{ border: EDGE, color: "var(--text2)" }}>
          Open in Jira ↗
        </button>
      )}
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

  const load = useCallback(async (fresh: boolean) => {
    // One read in the air: a second press or a returning focus joins it.
    if (flying.current) return;
    flying.current = true;
    setBusy(true);
    try {
      const r = await api.jiraMine(fresh).catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraMine>>));
      setNote(mineNote(r, have.current));
      if (r.ok && r.tasks) { have.current = true; at.current = Date.now(); setRows(r.tasks); }
      else if (!have.current) setRows([]);
    } finally { flying.current = false; setBusy(false); }
  }, []);

  useEffect(() => {
    if (!active) return;
    const looking = () => !document.hidden && document.hasFocus();
    const ask = (cause: "tick" | "focus") => { if (looking() && boardDue(Date.now(), at.current, cause)) void load(false); };
    // Arriving on the tab counts as coming back to it.
    if (boardDue(Date.now(), at.current, "focus")) void load(false);
    const t = setInterval(() => ask("tick"), BOARD_TICK_MS);
    const onFocus = () => ask("focus");
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [active, load]);

  /* "Show me this card", from the bell: pick it from the list, or read it. */
  useEffect(() => {
    if (!jump || jump.tracker !== "jira") return;
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
  }, [jump?.n, rows === null]);

  const shown = looked && !rows?.some((t) => t.id === looked.id) ? [looked, ...(rows ?? [])] : (rows ?? []);
  const picked = shown.find((t) => t.id === sel) ?? null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: LINE }}>
        <span className="text-[11px]" style={{ color: "var(--text2)" }}>Assigned to me</span>
        {rows && <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{rows.length}</span>}
        <span className="flex-1" />
        <RefreshButton onRefresh={() => void load(true)} busy={busy}
          title="Read the list from Jira now" />
      </div>
      {note && (
        <div className="px-4 py-2 text-[11px]" role={note.bad ? "alert" : "status"}
          style={{ color: note.bad ? "var(--error-ink)" : "var(--text3)", borderBottom: LINE }}>{note.text}</div>
      )}
      <div className="flex-1 min-h-0 flex">
        <div className="flex flex-col min-w-0" style={{ width: "52%", borderRight: LINE }}>
          {!rows && <div className="p-4"><Spinner label="Asking Jira…" className="" /></div>}
          {rows && shown.length === 0 && !note?.bad && (
            <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing is assigned to you.</div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto agx-scroll" role="rowgroup">
            {shown.map((t) => <Row key={t.id} t={t} on={t.id === sel} onPick={() => setSel(t.id)} />)}
          </div>
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto agx-scroll">
          {picked
            ? <Facts t={picked} />
            : <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Pick a card.</div>}
        </div>
      </div>
    </div>
  );
}

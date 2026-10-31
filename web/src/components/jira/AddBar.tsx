/*
 * Adding to the Jira sidebar: paste an address, add a whole project as a space,
 * or pick a board or a favourite filter from the site. The lists are read when
 * asked for, never before, and a search waits for the typing to pause.
 *
 * A pasted list-view address with a jql query is added as a SEARCH by default;
 * "Add the whole project instead" is the other card (lib/jiraAddress.ts).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import type { JiraViewChoice } from "../../../../shared/providers.ts";
import { Button, FilterField, ListRow, Section } from "../workspace/Chrome.tsx";
import { TaskDialog } from "../tasks/TaskDialog.tsx";
import type { AddViewSlotProps } from "../../lib/boardSource.ts";
import { ICON } from "../../lib/iconSize.ts";
import { LayersIcon, ListIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import { parseAddress } from "../../lib/jiraAddress.ts";
import { useJiraTree } from "../../lib/useJiraTree.ts";
import { toneOf } from "../../lib/jiraTree.ts";
import { setRailHidden, useRailHidden } from "./list/menus/viewPrefs.ts";

/** How long the search box waits after the last key before it asks. */
export const SEARCH_WAIT_MS = 300;

type Picks = { boards: JiraViewChoice[]; filters: JiraViewChoice[]; truncated?: boolean };

/** One of the two cards the dialog offers: a choice between ways, drawn as cards and not as two buttons. */
function Choice({ on, onClick, icon, title, children }: { on: boolean; onClick: () => void; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className="flex-1 min-w-0 flex text-left"
      style={{ gap: 12, padding: 12, borderRadius: 12, background: "var(--bg)", boxShadow: on ? "inset 0 0 0 1.5px var(--primary)" : "inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent)" }}>
      <span aria-hidden className="shrink-0" style={{ color: "var(--text2)" }}>{icon}</span>
      <span className="min-w-0 flex flex-col" style={{ gap: 2 }}>
        <b className="text-[12.5px]" style={{ color: "var(--text)" }}>{title}</b>
        <span className="text-[11px]" style={{ color: "var(--text3)" }}>{children}</span>
      </span>
    </button>
  );
}

export function AddBar({ onAddedView, onAddedFolder, onClose }: {
  /** The id of the view just added, for the rail to land on. */
  onAddedView: (id?: string) => void;
  onAddedFolder: () => void;
  onClose: () => void;
}) {
  const tree = useJiraTree(true);
  const hidden = useRailHidden();
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"pick" | "space" | null>("space");
  const [way, setWay] = useState(0);

  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<Picks | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const seq = useRef(0);
  const asked = useRef(false);

  const [pq, setPq] = useState("");
  const parsed = parseAddress(url);
  const choice = parsed.choices[way] ?? parsed.choices[0];

  // Lazy: the list is read on the first open, and again only after the box has been still.
  useEffect(() => {
    if (mode !== "pick") return;
    const n = ++seq.current;
    // Only the very first open asks at once. Waiting on `picks` instead let every key through after a failed first load.
    const wait = asked.current ? SEARCH_WAIT_MS : 0;
    asked.current = true;
    const t = setTimeout(() => {
      void api.jiraViewChoices(q).then((r) => {
        if (n !== seq.current) return;
        if (r.ok) { setPicks({ boards: r.boards, filters: r.filters, truncated: r.truncated }); setPickErr(null); }
        else setPickErr(r.error || "Jira did not answer");
      }).catch(() => { if (n === seq.current) setPickErr("Could not reach agentglass"); });
    }, wait);
    return () => clearTimeout(t);
  }, [mode, q]);

  // The projects are read when the space card is open, and a typed key is asked for by name once the typing pauses.
  useEffect(() => {
    if (mode !== "space") return;
    const t = setTimeout(() => { void tree.loadPicker(/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(pq.trim()) ? pq.trim().toUpperCase() : ""); }, pq ? SEARCH_WAIT_MS : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pq]);

  const run = async <R extends { ok: boolean; error?: string }>(go: () => Promise<R>, done: (r: R) => void) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await go();
      if (r.ok) done(r); else setErr(r.error || "Could not add that");
    } catch { setErr("Could not reach agentglass"); }
    finally { setBusy(false); }
  };

  const addSpace = (key: string) => void run(() => tree.edit({ add: key }), () => {
    tree.select({ kind: "space", space: key });
    tree.toggle(`s:${key}`, true);
    onAddedFolder();
  });
  const pick = (c: JiraViewChoice) => void run(() => api.jiraAddView({ kind: c.kind, id: c.id }), (r) => onAddedView(r.view?.id));
  const addUrl = () => {
    if (!url.trim()) return;
    if (choice?.kind === "space") addSpace(choice.id);
    else void run(() => api.jiraAddView({ url: url.trim() }), (r) => onAddedView(r.view?.id));
  };
  const needle = pq.trim().toLowerCase();
  const shownProjects = tree.picker.projects.filter((p) => !needle || p.key.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle));

  const viewRow = (c: JiraViewChoice) => (
    <ListRow key={`${c.kind}:${c.id}`} onClick={() => pick(c)} disabled={busy}
      trailing={(c.projectKey || c.type) ? <span className="text-[10px]">{[c.projectKey, c.type].filter(Boolean).join(" · ")}</span> : undefined}
      style={{ color: "var(--text)" }}>
      {c.name}
    </ListRow>
  );

  const jqlWay = parsed.choices.length > 0 && parsed.jql !== undefined;
  return (
    <TaskDialog title="Add to the sidebar" width={560} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      {jqlWay && <Button tone="primary" disabled={busy} onClick={addUrl}>{choice?.label ?? "Add"}</Button>}
    </>}>
     <div className="flex flex-col gap-3">
      <form className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); addUrl(); }}>
        <FilterField value={url} onChange={(v) => { setUrl(v); setErr(null); setWay(0); }} className="flex-1 min-w-0"
          label="Address of a board, filter or search" placeholder="Paste the address of a board, a filter or a search"
        />
        {!jqlWay && <Button type="submit" tone="primary" disabled={busy || !url.trim()}>Add</Button>}
      </form>
      {err && <div role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
      {/* The only row a person can take off the sidebar without removing it is the built-in one; this is the way back. */}
      {hidden.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0 text-[12px]" style={{ color: "var(--text3)" }}>“Assigned to me” is hidden from the sidebar.</span>
          <Button onClick={() => hidden.forEach((id) => setRailHidden(id, false))}>Show it again</Button>
        </div>
      )}
      {jqlWay ? (
        <div role="radiogroup" aria-label="How to add it" className="flex gap-2">
          <Choice on={way === 0} onClick={() => setWay(0)} icon={<SearchIcon size={ICON.lg} />} title="Add as a search">
            <span className="tabular-nums">{parsed.jql}</span><br />Shows exactly what that address shows, and keeps itself up to date.
          </Choice>
          {parsed.choices[1] && (
            <Choice on={way === 1} onClick={() => setWay(1)} icon={<LayersIcon size={ICON.lg} />} title="Add the whole project instead">
              {parsed.project}, every epic and board.
            </Choice>
          )}
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="What to add" className="flex gap-2">
            <Choice on={mode === "space"} onClick={() => setMode("space")} icon={<LayersIcon size={ICON.lg} />} title="Add a space">
              The whole project. New epics and boards show up on their own.
            </Choice>
            <Choice on={mode === "pick"} onClick={() => setMode("pick")} icon={<ListIcon size={ICON.lg} />} title="Pick a board or filter">
              Start from what Jira already has: boards and favourite filters.
            </Choice>
          </div>
          {mode === "pick" && (
            <div className="flex flex-col gap-3">
              <FilterField value={q} onChange={setQ} label="Search boards and filters" placeholder="Search boards and filters" />
              {pickErr && <div role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{pickErr}</div>}
              {!picks && !pickErr && <div className="text-[11px]" style={{ color: "var(--text3)" }}>Asking Jira…</div>}
              {picks && (
                <>
                  <Section title="Boards">
                    {picks.boards.length ? picks.boards.map(viewRow) : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No boards found.</div>}
                  </Section>
                  <Section title="Favourite filters">
                    {picks.filters.length ? picks.filters.map(viewRow) : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No favourite filters found.</div>}
                  </Section>
                  {picks.truncated && <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>More exist. Search to narrow the list.</div>}
                </>
              )}
            </div>
          )}
          {mode === "space" && (
            <div className="flex flex-col gap-2">
              <FilterField value={pq} onChange={setPq} label="Filter projects" placeholder="Filter projects" />
              {tree.picker.state === "error" && <div role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{tree.picker.error}</div>}
              {tree.picker.state !== "error" && tree.picker.state !== "ready" && !tree.picker.projects.length && <div className="text-[11px]" style={{ color: "var(--text3)" }}>Asking Jira…</div>}
              {tree.picker.state === "ready" && !shownProjects.length && <div className="text-[11px]" style={{ color: "var(--text3)" }}>No project matches.</div>}
              {shownProjects.map((p) => (
                <ListRow key={p.key} disabled={busy || p.added} onClick={() => addSpace(p.key)}
                  leading={<span aria-hidden className="grid place-items-center" style={{ width: 20, height: 20, borderRadius: 6, color: toneOf(p.key), background: `color-mix(in srgb, ${toneOf(p.key)} 14%, transparent)`, font: "700 9.5px/1 var(--font-mono, monospace)" }}>{p.key[0]}</span>}
                  trailing={<span className="text-[10.5px] tabular-nums">{p.key}{p.added ? " · Added" : ""}</span>}
                  style={{ color: "var(--text)" }}>
                  {p.name}
                </ListRow>
              ))}
            </div>
          )}
        </>
      )}
     </div>
    </TaskDialog>
  );
}

/** The board's add-a-view slot: this bar, which picks and says what it added instead of handing back text. */
export function JiraAddView({ onClose, onAddedView, onAddedFolder }: AddViewSlotProps) {
  return <AddBar onClose={onClose} onAddedView={(id) => onAddedView?.(id)} onAddedFolder={() => onAddedFolder?.()} />;
}

/*
 * Adding to the Jira rail: paste an address, pick a board or a favourite
 * filter from the site, or add a project. The pick lists are read when asked
 * for, never before, and a search waits for the typing to pause.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { JiraProjectChoice, JiraViewChoice } from "../../../../shared/providers.ts";
import { CHIP, CHIP_SURFACE, FilterField, LINE } from "../workspace/Chrome.tsx";
import type { AddViewSlotProps } from "../../lib/boardSource.ts";

/** How long the search box waits after the last key before it asks. */
export const SEARCH_WAIT_MS = 300;

type Picks = { boards: JiraViewChoice[]; filters: JiraViewChoice[]; truncated?: boolean };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{title}</div>
      {children}
    </div>
  );
}

export function AddBar({ onAddedView, onAddedFolder, onClose }: {
  /** The id of the view just added, for the rail to land on. */
  onAddedView: (id?: string) => void;
  onAddedFolder: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"pick" | "project" | null>(null);

  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<Picks | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const seq = useRef(0);
  const asked = useRef(false);

  const [projects, setProjects] = useState<JiraProjectChoice[] | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const [pq, setPq] = useState("");

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

  useEffect(() => {
    if (mode !== "project" || projects) return;
    void api.jiraProjectChoices().then((r) => {
      if (r.ok) { setProjects(r.projects); setProjErr(null); } else setProjErr(r.error || "Jira did not answer");
    }).catch(() => setProjErr("Could not reach agentglass"));
  }, [mode, projects]);

  const run = async <R extends { ok: boolean; error?: string }>(go: () => Promise<R>, done: (r: R) => void) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await go();
      if (r.ok) done(r); else setErr(r.error || "Could not add that");
    } catch { setErr("Could not reach agentglass"); }
    finally { setBusy(false); }
  };

  const pick = (c: JiraViewChoice) => void run(() => api.jiraAddView({ kind: c.kind, id: c.id }), (r) => onAddedView(r.view?.id));
  const needle = pq.trim().toLowerCase();
  const shownProjects = (projects ?? []).filter((p) => !needle || p.key.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle));

  const choice = (c: JiraViewChoice) => (
    <button key={`${c.kind}:${c.id}`} onClick={() => pick(c)} disabled={busy}
      className="agx-row text-left px-2 py-1.5 rounded-lg hover:bg-white/5 flex items-center gap-2 min-w-0">
      <span className="flex-1 min-w-0 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{c.name}</span>
      {(c.projectKey || c.type) && <span className="shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>{[c.projectKey, c.type].filter(Boolean).join(" · ")}</span>}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-3 overflow-y-auto agx-scroll" style={{ borderBottom: LINE, maxHeight: "55%" }}>
      <form className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (url.trim()) void run(() => api.jiraAddView({ url: url.trim() }), (r) => onAddedView(r.view?.id)); }}>
        <FilterField value={url} onChange={(v) => { setUrl(v); setErr(null); }} className="flex-1 min-w-0"
          label="Address of a board, filter or search" placeholder="Paste the address of a board, a filter or a search"
        />
        <button type="submit" className={CHIP} style={CHIP_SURFACE} disabled={busy || !url.trim()}>Add</button>
        <button type="button" className={CHIP} style={{ color: "var(--text3)" }} onClick={onClose}>Close</button>
      </form>
      {err && <div role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
      <div className="flex gap-2">
        <button className={CHIP} style={CHIP_SURFACE} aria-expanded={mode === "pick"} onClick={() => setMode(mode === "pick" ? null : "pick")}>Pick</button>
        <button className={CHIP} style={CHIP_SURFACE} aria-expanded={mode === "project"} onClick={() => setMode(mode === "project" ? null : "project")}>Add a project</button>
      </div>
      {mode === "pick" && (
        <div className="flex flex-col gap-3">
          <FilterField value={q} onChange={setQ} label="Search boards and filters" placeholder="Search boards and filters" />
          {pickErr && <div role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{pickErr}</div>}
          {!picks && !pickErr && <div className="text-[11px]" style={{ color: "var(--text3)" }}>Asking Jira…</div>}
          {picks && (
            <>
              <Section title="Boards">
                {picks.boards.length ? picks.boards.map(choice) : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No boards found.</div>}
              </Section>
              <Section title="Favourite filters">
                {picks.filters.length ? picks.filters.map(choice) : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No favourite filters found.</div>}
              </Section>
              {picks.truncated && <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>More exist. Search to narrow the list.</div>}
            </>
          )}
        </div>
      )}
      {mode === "project" && (
        <div className="flex flex-col gap-2">
          <FilterField value={pq} onChange={setPq} label="Filter projects" placeholder="Filter projects" />
          {projErr && <div role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{projErr}</div>}
          {!projects && !projErr && <div className="text-[11px]" style={{ color: "var(--text3)" }}>Asking Jira…</div>}
          {projects && (shownProjects.length ? shownProjects.map((p) => (
            <button key={p.key} disabled={busy} onClick={() => void run(() => api.jiraAddFolder(p.key), () => onAddedFolder())}
              className="agx-row text-left px-2 py-1.5 rounded-lg hover:bg-white/5 flex items-center gap-2 min-w-0">
              <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{p.key}</span>
              <span className="flex-1 min-w-0 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{p.name}</span>
            </button>
          )) : <div className="text-[11px]" style={{ color: "var(--text3)" }}>No project matches.</div>)}
        </div>
      )}
    </div>
  );
}

/** The board's add-a-view slot: this bar, which picks and says what it added instead of handing back text. */
export function JiraAddView({ onClose, onAddedView, onAddedFolder }: AddViewSlotProps) {
  return <AddBar onClose={onClose} onAddedView={(id) => onAddedView?.(id)} onAddedFolder={() => onAddedFolder?.()} />;
}

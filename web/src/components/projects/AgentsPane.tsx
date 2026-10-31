// "Where agents worked": the explicit sweep of every place an agent ran. It
// lists only what the sweep found OUTSIDE the folders already on the list, so
// the heading is true — the repos inside the added folders are not "where
// agents worked", they are where the person pointed. The sweep is one request
// with no progress to report, so it shows elapsed time and a Stop that keeps
// whatever has arrived (nothing, until it has).
import { useEffect, useRef, useState } from "react";
import type { GitRepoRef } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { sessionsByRoot } from "../../lib/projectsView.ts";
import { clock, relTime, tildify } from "../../lib/projectsPaths.ts";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { BranchIcon, SparkleIcon } from "../../lib/glyphIcons.tsx";
import { Foot, HAIR, Kbd, Status, PaneHead, StateCard, Tile } from "./ui.tsx";

type Phase = { t: "running"; since: number } | { t: "done"; found: GitRepoRef[] } | { t: "stopped" } | { t: "failed" };

/** What the sweep found that the list does not already show. */
export const freshFinds = (swept: readonly GitRepoRef[], listed: readonly string[]): GitRepoRef[] => {
  const have = new Set(listed);
  return swept.filter((r) => !have.has(r.root));
};

export function AgentsPane({ listed, busy, onAdd, onBack }: { listed: readonly string[]; busy: boolean; onAdd: (roots: string[]) => void; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>({ t: "running", since: Date.now() });
  const [now, setNow] = useState(Date.now());
  const [ticks, setTicks] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const token = useRef(0);
  const start = () => {
    const me = ++token.current;
    setPhase({ t: "running", since: Date.now() });
    api.gitReposAll(true)
      .then(({ repos }) => { if (me === token.current) { const found = freshFinds(repos, listed); setPhase({ t: "done", found }); setTicks(found.map((r) => r.root));
        // Counts come from the session list the app already keeps; a failed read leaves the rows without one.
        api.sessions(2000).then((rows) => { if (me === token.current) setCounts(sessionsByRoot(rows, found.map((r) => r.root))); }).catch(() => {}); } })
      .catch(() => { if (me === token.current) setPhase({ t: "failed" }); });
  };
  useEffect(() => { start(); return () => { token.current++; }; /* once per opening of the pane */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (phase.t !== "running") return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [phase.t]);

  const found = phase.t === "done" ? phase.found : [];
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <PaneHead title="Where agents worked" sub="from your agent history" onBack={onBack} />
      {phase.t === "running" && (
        <StateCard hue="primary" spin icon={<SparkleIcon size={ICON.lg} />} title="Reading history…" badge={<Status hue="primary">{clock((now - phase.since) / 1000)}</Status>}
          actions={<Button onClick={() => { token.current++; setPhase({ t: "stopped" }); }}>Stop</Button>}>
          Looking at where Claude Code and OpenCode ran on this machine. Read-only, nothing is changed.
        </StateCard>
      )}
      {phase.t === "stopped" && <StateCard hue="muted" icon={<SparkleIcon size={ICON.lg} />} title="Stopped" actions={<Button tone="primary" onClick={start}>Look again</Button>}>Nothing was added.</StateCard>}
      {phase.t === "failed" && <StateCard hue="error" icon={<SparkleIcon size={ICON.lg} />} title="Could not read the history" actions={<Button tone="primary" onClick={start}>Try again</Button>}>Nothing was changed.</StateCard>}
      {phase.t === "done" && !found.length && (
        <StateCard hue="muted" icon={<SparkleIcon size={ICON.lg} />} title="Nothing new in the agent history" actions={<Button onClick={onBack}>Back to list</Button>}>
          Every project an agent worked in is already on your list.
        </StateCard>
      )}
      {found.length > 0 && (
        <>
          <div className="pm-px mt-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text3)" }}>Found <span className="font-normal" style={{ color: "var(--text4)" }}>{found.length}</span>
            <span className="flex-1" /><button className="bg-transparent border-0 p-0 cursor-pointer font-semibold normal-case tracking-normal" style={{ color: "var(--primary)" }} onClick={() => setTicks(ticks.length ? [] : found.map((r) => r.root))}>{ticks.length ? "Untick all" : "Tick all"}</button></div>
          <div className="agx-scroll pm-mx mt-1.5 rounded-xl overflow-y-auto min-h-0 flex-1" style={{ border: EDGE }}>
            {found.map((r) => (
              <label key={r.root} className="grid items-center gap-x-2.5 px-3 cursor-pointer" style={{ gridTemplateColumns: "16px 22px minmax(0,1fr) 150px", height: 46, borderBottom: HAIR }}>
                <input type="checkbox" checked={ticks.includes(r.root)} onChange={() => setTicks((t) => (t.includes(r.root) ? t.filter((x) => x !== r.root) : [...t, r.root]))} style={{ accentColor: "var(--primary)" }} aria-label={`Add ${r.name}`} />
                <Tile hue="success"><BranchIcon size={ICON.xs} /></Tile>
                <span className="min-w-0"><b className="block text-[12.5px] truncate" title={r.name}>{r.name}</b><span className="block font-mono text-[11px] truncate" style={{ color: "var(--text3)" }} title={r.root}>{tildify(r.root)}</span></span>
                <span className="text-right text-[11px]" style={{ color: "var(--text3)" }}>{counts[r.root] ? `${counts[r.root]} session${counts[r.root] === 1 ? "" : "s"} · ` : ""}{relTime(r.touchedAt, Date.now())}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <span className="flex-1" />
      <Foot hint={<span><Kbd>Esc</Kbd> back</span>}>
        {found.length > 0 && <span className="text-[12px] font-semibold">{ticks.length} ticked <span className="font-normal" style={{ color: "var(--text3)" }}>of {found.length}</span></span>}
        <Button disabled={!ticks.length || busy} onClick={() => onAdd(ticks)}>Add ticked ({ticks.length})</Button>
        <Button tone="primary" disabled={!found.length || busy} onClick={() => onAdd(found.map((r) => r.root))}>Add all {found.length}</Button>
      </Foot>
    </div>
  );
}

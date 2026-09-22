/**
 * The dashboard's first line — see lib/fleetVerdict.ts for what it says and
 * why. This is only the drawing: one calm line when nothing needs a person,
 * the wash of the worst tone when something does, and every clause a way to
 * the thing it counted.
 *
 * The verdict is read once, by `useFleetVerdict`, in the dashboard, which
 * hands the same object to this line and to the KPI tiles under it: read
 * twice, the two could disagree for the length of a render. It reads the
 * Lantern's store and asks for nothing: the rail's pip already subscribes to
 * the same store for the life of the app, so this adds no poll of its own.
 */
import { useSyncExternalStore } from "react";
import { subscribeLantern, lanternRows, lanternFailed, lanternKnown } from "../lib/lanternStore.ts";
import { fleetVerdict, type FleetVerdict, type VerdictClause, type VerdictTone } from "../lib/fleetVerdict.ts";
import { jumpToPane } from "../lib/paneJump.ts";

const ink: Record<VerdictTone, string> = { calm: "var(--success)", warn: "var(--warning)", critical: "var(--error)" };

export function useFleetVerdict(): FleetVerdict | null {
  const rows = useSyncExternalStore(subscribeLantern, lanternRows, lanternRows);
  const failed = useSyncExternalStore(subscribeLantern, lanternFailed, lanternFailed);
  const known = useSyncExternalStore(subscribeLantern, lanternKnown, lanternKnown);
  return fleetVerdict(rows, Date.now(), failed, known);
}

export function FleetVerdictStrip({ verdict: v, onOpenLantern }: { verdict: FleetVerdict | null; onOpenLantern: () => void }) {
  if (!v) return null;
  const loud = v.tone !== "calm";
  /* One agent with a pane: go to it. Several, or none reachable: the Lantern,
     which lists them in the order this line counted them. */
  const go = (c: VerdictClause) => { if (!c.paneId || !jumpToPane(c.paneId)) onOpenLantern(); };
  return (
    <section
      aria-label="State of the fleet"
      className="shrink-0 px-3 py-1.5 flex items-center gap-2 min-w-0 text-[11.5px] border-b"
      style={{
        background: loud ? `color-mix(in srgb, ${ink[v.tone]} ${v.tone === "critical" ? 14 : 12}%, transparent)` : "transparent",
        borderColor: loud ? `color-mix(in srgb, ${ink[v.tone]} 35%, transparent)` : "color-mix(in srgb, var(--text) 12%, transparent)",
        color: "var(--text2)",
        opacity: v.stale ? 0.6 : 1,
      }}
      title={v.stale ? "The board could not be read just now; this is its last answer" : undefined}
    >
      <span aria-hidden className="shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: ink[v.tone] }} />
      <span className="flex items-center gap-1.5 min-w-0 overflow-hidden whitespace-nowrap">
        {v.clauses.map((c, i) => (
          /* The count is a few characters and is the answer to the first
             question; the long clauses are the ones that give way. */
          <span key={c.kind} className={`flex items-center gap-1.5 ${c.kind === "running" ? "shrink-0" : "min-w-0"}`}>
            {i > 0 && <span aria-hidden style={{ color: "var(--text4)" }}>·</span>}
            <button
              onClick={() => go(c)}
              className="truncate hover:underline"
              style={{ color: c.tone === "calm" ? "var(--text2)" : ink[c.tone], fontWeight: c.tone === "calm" ? 400 : 600 }}
              title={c.paneId ? "Go to its pane" : "Open the Lantern"}
            >
              {c.text}
            </button>
          </span>
        ))}
      </span>
      {v.stale && <span className="shrink-0 ml-auto text-[10px]" style={{ color: "var(--text4)" }}>stale</span>}
    </section>
  );
}

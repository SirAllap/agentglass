/*
 * The pictures of the Areas tree (lib/jiraAreas.ts holds the decisions): the
 * tree in the rail, the line over an Area or the sprint, and the Group control.
 *
 * Every control is always there once the board has the thing it controls, and a
 * control never moves because of what else is pressed: the Group control and
 * the scope switch sit in the same place in an Area, in the sprint and on a
 * board with neither (where the scope switch is simply not offered).
 */
import { HIT } from "../../lib/iconSize.ts";
import { GROUP_BY, epicLabel, type AreaRow, type GroupBy, type GroupPref, type ThenBy } from "../../lib/jiraAreas.ts";
import { epicTone, sprintLine } from "../../lib/jiraBoardContext.ts";
import type { JiraBoardSprint } from "../../../../shared/providers.ts";
import { Segmented, EDGE } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";

/** What the rail's Sprints entry and an Area are called when picked: an epic's key, or this. */
export const SPRINTS = "@sprints";

const CAPTION = "text-[8.5px] uppercase tracking-[0.18em] px-3 pt-3 pb-1";
const row = (on: boolean) => ({
  height: HIT, marginInline: 4, paddingLeft: 12, paddingRight: 8, borderRadius: 6, cursor: "pointer",
  fontSize: 12, fontWeight: on ? 600 : 400, color: on ? "var(--text)" : "var(--text2)",
  background: on ? "color-mix(in srgb, var(--primary) 10%, transparent)" : undefined,
} as const);

/** The rail's Areas and Sprints entries, under the project they belong to. */
export function JiraAreaRail({ project, areas, sprint, now, points, sel, onPick, state, truncated }: {
  project: string;
  areas: readonly AreaRow[];
  sprint?: JiraBoardSprint;
  now: number;
  points?: { todo: number; doing: number; done: number };
  sel: string | null;
  onPick: (key: string | null) => void;
  state: "loading" | "ready" | "error";
  truncated: boolean;
}) {
  const line = sprint ? sprintLine(sprint, now) : null;
  return (
    <div role="group" aria-label={`${project} areas`} data-testid="jira-areas-rail" style={{ borderTop: EDGE, marginTop: 8 }}>
      <div className={CAPTION} style={{ color: "var(--text4)" }}>{project} · Areas</div>
      {state === "loading" && !areas.length && <div className="px-3 py-1 text-[11px]" style={{ color: "var(--text3)" }}>Reading the areas…</div>}
      {state === "error" && !areas.length && <div className="px-3 py-1 text-[11px]" style={{ color: "var(--error-ink)" }}>Could not read the areas.</div>}
      {state === "ready" && !areas.length && <div className="px-3 py-1 text-[11px]" style={{ color: "var(--text3)" }}>This board has no epics to group by.</div>}
      {areas.map((a) => (
        <button key={a.key} onClick={() => onPick(sel === a.key ? null : a.key)} aria-pressed={sel === a.key}
          title={`${a.name} (${a.key}): ${a.total} cards, ${a.inSprint} in the sprint, ${a.done} done`}
          className="agx-rail-row w-full flex items-center gap-2 text-left" style={row(sel === a.key)}>
          <span aria-hidden className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: `var(${epicTone(a.color)})` }} />
          <span className="truncate min-w-0 flex-1">{epicLabel(a.name)}</span>
          <span className="shrink-0 truncate" style={{ color: "var(--text4)", fontSize: 10, fontWeight: 400, maxWidth: 56 }}>{a.key}</span>
          <span className="tabular-nums shrink-0" style={{ color: "var(--text3)", fontSize: 11 }}>{a.total}</span>
        </button>
      ))}
      {truncated && areas.length > 0 && <div className="px-3 py-1 text-[10.5px]" style={{ color: "var(--text4)" }}>Counts are at least: the project is larger than what is read.</div>}
      {sprint && (
        <>
          <div className={CAPTION} style={{ color: "var(--text4)" }}>Sprints</div>
          <button onClick={() => onPick(sel === SPRINTS ? null : SPRINTS)} aria-pressed={sel === SPRINTS} data-testid="jira-sprints-entry"
            className="agx-rail-row text-left flex flex-col justify-center"
            style={{ ...row(sel === SPRINTS), height: "auto", paddingBlock: 6, marginInline: 8, border: EDGE }}>
            <span className="flex items-center gap-2 min-w-0"><span className="truncate flex-1">{sprint.name}</span><span style={{ color: "var(--text3)", fontSize: 10.5 }}>active</span></span>
            <span className="tabular-nums" style={{ color: "var(--text3)", fontSize: 10.5, fontWeight: 400 }}>
              {[line?.range, points ? `${points.todo} / ${points.doing} / ${points.done} pts` : ""].filter(Boolean).join(" · ")}
            </span>
          </button>
        </>
      )}
    </div>
  );
}

/** The heading over an Area or the sprint: what it is, how many are in the sprint, and how far along it is. */
export function JiraAreaHead({ title, fullTitle, sub, line, hint, done, total, children }: {
  title: string; fullTitle?: string; sub?: string; line: string; hint?: string; done: number; total: number; children?: React.ReactNode;
}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="px-4 pt-2.5 pb-1.5 min-w-0" data-testid="jira-area-head">
      <div className="flex items-baseline gap-2.5 min-w-0">
        <span className="font-bold truncate" title={fullTitle} style={{ fontSize: 15, color: "var(--text)" }}>{title}</span>
        {sub && <span className="truncate text-[11px]" style={{ color: "var(--text3)" }}>{sub}</span>}
      </div>
      <div className="flex items-center gap-3 text-[11.5px] mt-0.5" style={{ color: "var(--text2)" }}>
        <span className="tabular-nums">{line}</span>
        <span aria-hidden className="rounded-full overflow-hidden" style={{ width: 140, height: 6, background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>
          <span className="block h-full" style={{ width: `${pct}%`, background: "var(--success)" }} />
        </span>
        <span className="tabular-nums" style={{ color: "var(--text3)" }}>{done} done · {Math.max(0, total - done)} open</span>
        {children}
      </div>
      {hint && <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text4)" }}>{hint}</div>}
    </div>
  );
}

/** Group by, and the second level under it. Both are always drawn once the board can group. */
export function JiraGroupControl({ pref, onPref, hasAreas }: { pref: GroupPref; onPref: (p: GroupPref) => void; hasAreas: boolean }) {
  const bys = GROUP_BY.filter((g) => hasAreas || g.id !== "area");
  const thens: { value: ThenBy; label: string }[] = pref.by === "status"
    ? [{ value: "none", label: "Nothing" }, ...(hasAreas ? [{ value: "area" as const, label: "Area" }] : [])]
    : [{ value: "none", label: "Nothing" }, { value: "status", label: "Status" }];
  return (
    <span className="inline-flex items-center gap-2" data-testid="jira-group-control">
      <span className="text-[8.5px] uppercase tracking-[0.18em]" style={{ color: "var(--text4)" }}>Group</span>
      <Select value={pref.by} title="Group the cards by"
        options={bys.map((g) => ({ value: g.id, label: g.label }))}
        onChange={(v) => onPref({ by: v as GroupBy, split: "none" })} />
      <span className="text-[8.5px] uppercase tracking-[0.18em]" style={{ color: "var(--text4)" }}>Then</span>
      <Select value={pref.split} title="Then split each group by"
        options={thens.map((t) => ({ value: t.value, label: t.label }))}
        onChange={(v) => onPref({ ...pref, split: v as ThenBy })} />
    </span>
  );
}

/** Sprint only / the whole Area. Offered only where there is a sprint to scope to. */
export function JiraScope({ only, onOnly, sprintName, total }: { only: boolean; onOnly: (v: boolean) => void; sprintName: string; total: number }) {
  return (
    <Segmented label="Scope" value={only ? "sprint" : "all"} onChange={(v) => onOnly(v === "sprint")}
      options={[{ id: "sprint", label: `${sprintName} only` }, { id: "all", label: `All ${total}` }]} />
  );
}

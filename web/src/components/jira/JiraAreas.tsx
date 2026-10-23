/*
 * The pictures of the Areas tree (lib/jiraAreas.ts holds the decisions): the
 * tree in the rail, the line over an Area or the sprint, and the Group control.
 *
 * Every control is always there once the board has the thing it controls, and a
 * control never moves because of what else is pressed: the Group control and
 * the scope switch sit in the same place in an Area, in the sprint and on a
 * board with neither (where the scope switch is simply not offered).
 */
import { useState } from "react";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { InfoIcon } from "../../lib/glyphIcons.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { GROUP_BY, barSegments, railTitle, rowText, type AreaRow, type GroupBy, type GroupPref, type ThenBy } from "../../lib/jiraAreas.ts";
import { epicTone, sprintLine } from "../../lib/jiraBoardContext.ts";
import type { JiraBoardSprint } from "../../../../shared/providers.ts";
import { Segmented, EDGE } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";

/** What the rail's Sprints entry and an Area are called when picked: an epic's key, or this. */
export const SPRINTS = "@sprints";

/** The key chip and the right-hand text of a rail row keep one width each, so the bars line up. */
const KEY_W = 62;
const TEXT_W = 52;
const BAR_MIN = 30;
const LEGEND: readonly [string, string][] = [["var(--success)", "done"], ["var(--warning)", "open in the sprint"], ["var(--text4)", "other open"]];

const CAPTION = "text-[8.5px] uppercase tracking-[0.18em] px-3 pt-3 pb-1";
const row = (on: boolean) => ({
  // minHeight, never height: an epic title wraps to two lines and a fixed row lets the second line print over the next row.
  minHeight: HIT, height: "auto", paddingBlock: 4, marginInline: 4, paddingLeft: 12, paddingRight: 8, borderRadius: 6, cursor: "pointer",
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
  const railRow = (a: AreaRow) => {
    const seg = barSegments(a);
    const txt = rowText(a, truncated);
    return (
      <button key={a.key} onClick={() => onPick(sel === a.key ? null : a.key)} aria-pressed={sel === a.key}
        title={txt.title} className="agx-rail-row w-full flex items-start gap-2.5 text-left" style={row(sel === a.key)}>
        <span aria-hidden className="shrink-0 rounded-full" style={{ width: 8, height: 8, marginTop: 6, background: `var(${epicTone(a.color)})` }} />
        <span className="min-w-0 flex-1 flex flex-col" style={{ gap: 4 }}>
          <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere", lineHeight: 1.3 }}>{railTitle(a.name)}</span>
          <span className="flex items-center min-w-0" style={{ gap: 8 }}>
            {/* A fixed width for the key (a longer key just widens its own chip) and for the text: every bar starts and ends at the same x, whatever the row says. */}
            <span className="shrink-0 text-center whitespace-nowrap" style={{ minWidth: KEY_W, boxSizing: "border-box", padding: "1px 8px", borderRadius: 999, fontSize: 9.5, fontWeight: 400, color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>{a.key}</span>
            <span aria-hidden className="flex-1 flex overflow-hidden" data-testid="jira-rail-bar"
              style={{ minWidth: BAR_MIN, height: 5, borderRadius: 3, background: txt.tone === "none" ? undefined : "color-mix(in srgb, var(--text) 10%, transparent)",
                backgroundImage: txt.tone === "none" ? "repeating-linear-gradient(90deg, color-mix(in srgb, var(--text) 16%, transparent) 0 3px, transparent 3px 6px)" : undefined }}>
              <span style={{ width: `${seg.done}%`, background: "var(--success)" }} />
              <span style={{ width: `${seg.sprint}%`, background: "var(--warning)" }} />
              <span style={{ width: `${seg.other}%`, background: "var(--text4)" }} />
            </span>
            <span className="shrink-0 text-right" style={{ width: TEXT_W, fontSize: 10.5, fontVariantNumeric: "tabular-nums", fontWeight: txt.tone === "open" ? 600 : txt.tone === "done" ? 500 : 400,
              color: txt.tone === "open" ? "var(--text)" : txt.tone === "done" ? "var(--success)" : "var(--text4)" }}>{txt.text}</span>
          </span>
        </span>
      </button>
    );
  };
  return (
    <div role="group" aria-label={`${project} areas`} data-testid="jira-areas-rail" style={{ borderTop: EDGE, marginTop: 8 }}>
      <div className={CAPTION} style={{ color: "var(--text4)" }}>{project} · Areas</div>
      {state === "loading" && !areas.length && <div className="px-3 py-1 text-[11px]" style={{ color: "var(--text3)" }}>Reading the areas…</div>}
      {state === "error" && !areas.length && <div className="px-3 py-1 text-[11px]" style={{ color: "var(--error-ink)" }}>Could not read the areas.</div>}
      {state === "ready" && !areas.length && <div className="px-3 py-1 text-[11px]" style={{ color: "var(--text3)" }}>This board has no epics to group by.</div>}
      {areas.filter((a) => a.group === "area").map(railRow)}
      {areas.some((a) => a.group === "epic") && <div className={CAPTION} style={{ color: "var(--text4)" }}>Epics</div>}
      {areas.filter((a) => a.group === "epic").map(railRow)}
      {areas.length > 0 && (
        <div className="flex flex-wrap items-center px-3 py-2" style={{ gap: "2px 10px", fontSize: 10, color: "var(--text3)" }} data-testid="jira-rail-legend">
          {LEGEND.map(([c, label]) => (
            <span key={label} className="inline-flex items-center gap-1"><span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: c }} />{label}</span>
          ))}
        </div>
      )}
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
const HINT_KEY = "agx.jira.epicHintDismissed";
const hintGone = (): boolean => { try { return sessionStorage.getItem(HINT_KEY) === "1"; } catch { return false; } };

const chip = (tone: "open" | "done" | "plain"): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 600, padding: "1px 8px", borderRadius: 999, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
  ...(tone === "open"
    ? { color: "var(--text)", background: "color-mix(in srgb, var(--accent, var(--primary)) 22%, transparent)" }
    : { color: "var(--text2)", background: "color-mix(in srgb, var(--text) 8%, transparent)", fontWeight: tone === "done" ? 500 : 400 }),
});

/** Epic header: the title above the key, open / done / sprint as chips beside the bar (they wrap on a narrow pane), the hint as a notice that can be put away for the session. */
export function JiraAreaHead({ title, fullTitle, sub, chips, hint, done, total, children }: {
  title: string; fullTitle?: string; sub?: string; chips: { open: string; done: string; sprint: string | null }; hint?: string; done: number; total: number; children?: React.ReactNode;
}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const [gone, setGone] = useState(hintGone);
  return (
    <div className="px-4 pt-2.5 pb-1.5 min-w-0" data-testid="jira-area-head">
      <div className="flex items-baseline flex-wrap gap-x-2.5 min-w-0">
        <span className="font-extrabold min-w-0" title={fullTitle} style={{ fontSize: 17, color: "var(--text)", overflowWrap: "anywhere" }}>{title}</span>
        {sub && <span className="text-[11px] font-normal" style={{ color: "var(--text3)" }}>{sub}</span>}
      </div>
      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-1 min-w-0">
        <span style={chip("open")}>{chips.open}</span>
        <span style={chip("done")}>{chips.done}</span>
        {chips.sprint && <span style={chip("plain")}>{chips.sprint}</span>}
        <span aria-hidden className="rounded-full overflow-hidden shrink" style={{ width: 120, maxWidth: "100%", height: 6, background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>
          <span className="block h-full" style={{ width: `${pct}%`, background: "var(--success)" }} />
        </span>
        {children}
      </div>
      {hint && !gone && (
        <div role="note" className="flex items-center gap-1.5 mt-1 text-[12px] min-w-0" style={{ color: "var(--text2)" }} data-testid="jira-epic-hint">
          <span className="shrink-0 inline-flex" style={{ color: "var(--text3)" }}><InfoIcon size={ICON.sm} /></span>
          <span className="min-w-0 flex-1">{hint}</span>
          <CloseButton size={ICON.xs} hit={22} title="Hide this note for the session"
            onClick={() => { try { sessionStorage.setItem(HINT_KEY, "1"); } catch { /* the note just stays hidden until reload */ } setGone(true); }} />
        </div>
      )}
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

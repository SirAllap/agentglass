/*
 * What a Jira board draws around its cards: the sprint it is in, the board's
 * own quick filters, the choice of grouping, and the heading of a parent's
 * group. The decisions (grouping, dates, colour) are in lib/jiraBoardContext.ts;
 * these are only the pictures of them, drawn from what the server sent.
 *
 * Every control is always there once the board has the thing it controls: a
 * chip is pressed or not, and never appears or moves because of what else is
 * pressed. A board with no quick filters draws no chip row, rather than an
 * empty one, and a board with no sprint draws no header.
 */
import type { JiraBoardSprint, JiraQuickFilter } from "../../../../shared/providers.ts";
import { epicTone, sprintLine, type GroupMode, type ParentGroup } from "../../lib/jiraBoardContext.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import { ON_CHIP } from "../tasks/chipStyle.ts";
import { TypeMark } from "./JiraSections.tsx";

const CHIP = "text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap";
const idle = { border: EDGE, color: "var(--text2)" } as const;

/** One line over the board: the sprint, its dates, how long is left, and its goal. */
export function JiraSprintHeader({ sprint, now }: { sprint: JiraBoardSprint; now: number }) {
  const line = sprintLine(sprint, now);
  return (
    <div className="flex items-center gap-2.5 px-4 py-1.5 min-w-0 text-[11px]" data-testid="jira-sprint">
      <span className="text-[8.5px] uppercase tracking-[0.18em] shrink-0" style={{ color: "var(--text4)" }}>Sprint</span>
      <span className="shrink-0 font-semibold" style={{ color: "var(--text)" }}>{sprint.name}</span>
      {line.range && <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)" }}>{line.range}</span>}
      {line.left && <span className="shrink-0 tabular-nums" style={{ color: line.late ? "var(--warning-ink)" : "var(--text3)" }}>{line.left}</span>}
      {sprint.goal && <span className="truncate min-w-0" style={{ color: "var(--text4)" }} title={sprint.goal}>{sprint.goal}</span>}
    </div>
  );
}

/** The board's own quick filters as chips. Pressing one asks the site for the narrower board. */
export function JiraQuickChips({ filters, picked, onToggle }: { filters: readonly JiraQuickFilter[]; picked: readonly string[]; onToggle: (id: string) => void }) {
  return (
    <>
      {filters.map((q) => {
        const on = picked.includes(q.id);
        return (
          <button key={q.id} onClick={() => onToggle(q.id)} aria-pressed={on} title={q.description || q.name}
            className={CHIP} style={on ? ON_CHIP : idle}>{q.name}</button>
        );
      })}
    </>
  );
}

/** Group the cards by status (the workflow) or by what they sit under. Both are always drawn. */
export function JiraGroupBy({ mode, onMode }: { mode: GroupMode; onMode: (m: GroupMode) => void }) {
  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label="Group cards by">
      {(["status", "parent"] as const).map((m) => (
        <button key={m} onClick={() => onMode(m)} aria-pressed={mode === m} className={CHIP} style={mode === m ? ON_CHIP : idle}
          title={m === "status" ? "Group the cards by status" : "Group the cards by their parent (epic or story)"}>by {m}</button>
      ))}
    </span>
  );
}

/** The heading of a parent's group: its kind, key and title, and how much of it is done. */
export function ParentLabel({ g, tone }: { g: ParentGroup; tone: string | undefined }) {
  if (!g.key) return <span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{g.title}</span>;
  return (
    <span className="flex items-center gap-2 min-w-0 text-[11.5px]">
      <span aria-hidden className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: `var(${epicTone(tone)})` }} />
      <TypeMark type={g.type} />
      <span className="tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{g.key}</span>
      <span className="truncate min-w-0" style={{ color: "var(--text)" }} title={g.title}>{g.title}</span>
      <span className="tabular-nums shrink-0" style={{ color: "var(--text3)" }} title={`${g.done} of ${g.rows.length} done`}>{g.done}/{g.rows.length}</span>
    </span>
  );
}

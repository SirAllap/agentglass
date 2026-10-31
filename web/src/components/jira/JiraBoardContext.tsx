/*
 * What a Jira board draws around its cards: the sprint it is in, the board's
 * own quick filters, and the heading of a parent's
 * group. The decisions (grouping, dates, colour) are in lib/jiraBoardContext.ts;
 * these are only the pictures of them, drawn from what the server sent.
 *
 * Every control is always there once the board has the thing it controls: a
 * chip is pressed or not, and never appears or moves because of what else is
 * pressed. A board with no quick filters draws no chip row, rather than an
 * empty one, and a board with no sprint draws no header.
 */
import type { JiraBoardSprint, JiraQuickFilter } from "../../../../shared/providers.ts";
import { epicTone, sprintLine, type ParentGroup } from "../../lib/jiraBoardContext.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import { ON_CHIP } from "../tasks/chipStyle.ts";
import { TypeMark } from "./JiraSections.tsx";

const CHIP = "text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap";
const idle = { border: EDGE, color: "var(--text2)" } as const;

/**
 * The sprint, as one badge on the toolbar's first row, where the board's name already is:
 * its name and how long is left. The dates, the points and the goal are in the badge's own
 * title and in the rail's Sprints entry, so the board keeps no row of its own for them.
 */
export function JiraSprintHeader({ sprint, now, totals }: { sprint: JiraBoardSprint; now: number; totals?: { todo: number; doing: number; done: number } }) {
  const line = sprintLine(sprint, now);
  const detail = [
    line.range,
    totals ? `${totals.todo} / ${totals.doing} / ${totals.done} points to do, in progress, done` : "",
    sprint.goal,
  ].filter(Boolean).join(" · ");
  return (
    <span className="shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full tabular-nums" data-testid="jira-sprint" title={detail || sprint.name}
      style={{
        height: 18, padding: "0 8px", fontSize: 10.5, fontWeight: 500,
        color: line.late ? "var(--warning-ink)" : "var(--info-ink, var(--primary-ink))",
        background: `color-mix(in srgb, ${line.late ? "var(--warning)" : "var(--info, var(--primary))"} 13%, transparent)`,
      }}>
      <span>{sprint.name}</span>
      {line.left && <span style={{ opacity: 0.85 }}>{line.left}</span>}
    </span>
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

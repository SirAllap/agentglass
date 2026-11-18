/*
 * A slim read-only strip under the tabs of a JQL or cross-space view that is one running sprint: the sprint chip's
 * look (mono, surface line, 4px corner), one chip per sprint, at most three, then "+N". What it decides is in
 * sprintStripModel.ts; this only draws it. Ceiling: no Start or Complete sprint here.
 */
import { tipAttr } from "../../../lib/tip.ts";
import type { JiraListModel } from "./model.ts";
import { MAX_SPRINTS, entryText, sprintStrip, type SprintEntry } from "./sprintStripModel.ts";

function Entry({ e }: { e: SprintEntry }) {
  const text = entryText(e);
  return (
    <span className="agx-jm-sprint tabular-nums min-w-0" data-testid="jira-sprint-strip-entry" {...(e.late ? { "data-late": "" } : {})}
      style={{ maxWidth: "100%", gap: 8 }} data-tip={tipAttr({ name: e.name, text: [text, e.goal].filter(Boolean).join(". ") })}>
      <span className="truncate" style={{ minWidth: 0, flex: "0 1 auto" }}>{e.name}</span>
      {e.left && <span className="shrink-0" style={{ color: e.late ? "var(--warning-ink)" : "var(--text2)" }}>{e.left}</span>}
      <span className="shrink-0" style={{ color: "var(--text3)" }}>{e.done}/{e.total} cards{e.points ? ` · ${e.points.done}/${e.points.total} pts` : ""}</span>
      {e.goal && <span className="truncate" style={{ color: "var(--text3)", minWidth: 0, flex: "1 1 0" }}>{e.goal}</span>}
    </span>
  );
}

export function JiraSprintStrip({ model, on }: { model: JiraListModel; on: boolean }) {
  const s = sprintStrip({ cards: model.cards, known: model.sprint, on, now: Date.now() });
  if (!s.entries.length) return null;
  return (
    <div data-slot="sprint-strip" data-testid="jira-sprint-strip" className="flex items-center shrink-0 min-w-0" style={{ gap: 6, padding: "0 24px", flexWrap: "wrap" }}>
      {s.entries.map((e) => <Entry key={e.id} e={e} />)}
      {s.more > 0 && <span className="text-[11px]" style={{ color: "var(--text3)" }} data-tip={tipAttr(`${s.more} more running ${s.more === 1 ? "sprint" : "sprints"} among these cards (the strip shows ${MAX_SPRINTS})`)}>+{s.more}</span>}
    </div>
  );
}

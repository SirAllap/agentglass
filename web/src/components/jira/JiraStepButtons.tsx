import { useRef, useState } from "react";
import { Select } from "../Select.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { useDialogs } from "../ConfirmDialog.tsx";
import { api } from "../../lib/api.ts";
import { putCard } from "../../lib/prCardStore.ts";
import { projectOf, useJiraSettings } from "../../lib/jiraSettings.ts";
import { STEPS_OFF, hasQuestions, stepOffers, useJiraSteps, type StepOffer } from "../../lib/jiraStepUi.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { fillTemplate } from "../../../../shared/stepBlocks.ts";
import { blocksSentence } from "../../lib/stepBlocksView.ts";
import { JIRA } from "../../lib/jiraWorkflow.ts";
import type { StatusOption } from "../../lib/trackerStatus.ts";
import type { JiraPerson, JiraStepChoice, JiraStepPr, ProviderTask } from "../../../../shared/providers.ts";

const NOBODY = "\u0000nobody";

/** What the person chose in the question, sent as the step's choice. */
type Chosen = JiraStepChoice;

/**
 * The question, when a block of the step asks when it runs: the status from the
 * card's own moves, whether the assignee comes off, who to give it to (from the
 * people this card can be assigned to), and the comment's words. What is chosen
 * goes back through `onChange` on every change, so the press that confirms sends
 * what the dialog shows.
 */
function Questions({ task, offer, moves, people, start, onChange }: {
  task: ProviderTask; offer: StepOffer; moves: StatusOption[]; people: JiraPerson[]; start: string;
  onChange: (c: Chosen) => void;
}) {
  const first = offer.to ?? moves[0]?.toStatus ?? "";
  const [to, setTo] = useState(first);
  const [clear, setClear] = useState(false);
  const [assign, setAssign] = useState<string | null | undefined>(undefined);
  const [comment, setComment] = useState(start);
  const send = (n: Partial<{ to: string; clear: boolean; assign: string | null | undefined; comment: string }>) => {
    const v = { to, clear, assign, comment, ...n };
    onChange({
      ...(offer.asksStatus && v.to ? { to: v.to } : null),
      ...(offer.asksClear ? { clear: v.clear } : null),
      ...(offer.asksAssign && v.assign !== undefined ? { assign: v.assign } : null),
      ...(offer.asksComment ? { comment: v.comment } : null),
    });
  };
  const on = task.people?.[0]?.name;
  const rows = "flex items-center gap-2 text-[11.5px]";
  return (
    <div className="flex flex-col gap-2.5" style={{ color: "var(--text2)" }}>
      {offer.asksStatus && (
        <label className={rows}>
          <span className="shrink-0">{JIRA.nouns.move}</span>
          <Select value={to} title="Status" onChange={(v) => { setTo(v); send({ to: v }); }}
            options={[...new Map(moves.map((m) => [m.toStatus, m])).values()].map((m) => ({ value: m.toStatus, label: m.toStatus, tint: m.color, pill: true, dim: m.toKind === "done" }))} />
        </label>
      )}
      {offer.asksClear && on && (
        <label className={rows}>
          <input type="checkbox" checked={clear} onChange={(e) => { setClear(e.target.checked); send({ clear: e.target.checked }); }} />
          Take {on} off the card
        </label>
      )}
      {offer.asksAssign && (
        <label className={rows}>
          <span className="shrink-0">Give it to</span>
          <Select value={assign === undefined ? "" : assign === null ? NOBODY : assign} title="Assignee"
            onChange={(v) => { const a = v === NOBODY ? null : v; setAssign(a); send({ assign: a }); }}
            options={[{ value: "", label: "Leave as is", dim: true }, { value: NOBODY, label: "Nobody" }, ...people.map((p) => ({ value: p.key, label: p.name }))]} />
        </label>
      )}
      {offer.asksComment && (
        <label className="flex flex-col gap-1 text-[11.5px]">
          <span>Comment</span>
          <textarea value={comment} rows={3} className="w-full px-2 py-1 rounded-md text-[12px]" style={{ background: "var(--bg)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }}
            onChange={(e) => { setComment(e.target.value); send({ comment: e.target.value }); }} />
        </label>
      )}
    </div>
  );
}

/**
 * The saved steps for a Jira card on a pull request: a button for each of the
 * hand-off and the review that is set up, which asks first when a block of it
 * asks when it runs. Each press is one request (POST /jira/step) in an order the
 * server holds; the reply says what landed, and a landing in part is a warning.
 * With the switch off the buttons are there and disabled, with one sentence that
 * says why. The merge step runs from the merge dialog, not from here.
 */
export function JiraStepButtons({ task, query, pr, onSaid, onTask }: {
  task: ProviderTask; query: string; pr?: JiraStepPr; onSaid: (s: string) => void; onTask?: (t: ProviderTask) => void;
}) {
  const read = useJiraSteps();
  const steps = read?.steps ?? null;
  const settings = useJiraSettings();
  const { ask, dialog } = useDialogs();
  const [busy, setBusy] = useState(false);
  const chosen = useRef<Chosen>({});
  const offers = stepOffers(steps, task, { project: projectOf(task), overrides: read?.overrides ?? [], rules: settings?.handoff ?? {} });
  if (!offers.length) return dialog;
  const writes = settings?.writes === true;

  const run = async (offer: StepOffer, choice: Chosen) => {
    setBusy(true);
    onSaid(`${offer.label.replace("…", "")}…`);
    const r = await api.jiraRunStep(task.customId || task.id, task.updated, offer.key, choice, pr).catch(() => ({ ok: false, error: "Could not reach the server" } as const));
    setBusy(false);
    const warn = !r.ok ? (("conflict" in r && r.conflict) ? "somebody changed this card while you had it open" : r.error || "Jira refused that") : ("partial" in r && r.partial ? r.partial : "");
    onSaid(warn ? `!${warn}` : "task" in r && r.task?.status ? `now ${r.task.status}` : "done");
    if ("task" in r && r.task) { putCard(query, r.task); onTask?.(r.task); }
  };

  const press = async (offer: StepOffer) => {
    if (busy || !writes) return;
    const blocks = steps ? steps[offer.key].blocks : [];
    const sentence = offer.byRule ? `This project keeps its own hand-off rule: ${offer.to ? `move the ${JIRA.nouns.item} to ${offer.to}` : "the status is asked next"}.` : blocksSentence({ lead: "This will:", trigger: offer.key === "handoff" ? "move" : "menu", blocks: blocks as never, item: JIRA.nouns.item, status: offer.to });
    if (!hasQuestions(offer)) {
      if (await ask({ title: `${offer.label}?`, node: <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>{sentence}</div>, confirmLabel: offer.label })) await run(offer, {});
      return;
    }
    let moves: StatusOption[] = [];
    if (offer.asksStatus) {
      const o = await TRACKERS.jira.statusOptions(task);
      if (!o.ok) { onSaid(`!${o.error || "the card's moves could not be read"}`); return; }
      // A move that asks for a field cannot be made from here.
      moves = (o.data ?? []).filter((m) => !m.needs?.length);
      if (!moves.length) { onSaid(`!${task.customId || task.id} has no move that can be made from here`); return; }
    }
    let people: JiraPerson[] = [];
    if (offer.asksAssign) {
      const r = await api.jiraAssignable(task.customId || task.id, "").catch(() => null);
      if (!r?.ok) { onSaid(`!${r?.error || "the people could not be read"}`); return; }
      people = r.people ?? [];
    }
    const start = offer.comment ? fillTemplate(offer.comment, { ...(pr ? { pr: `${pr.number ? `#${pr.number} ` : ""}${pr.title ?? ""}`.trim(), pr_url: pr.url } : null), ...(pr?.author ? { author: pr.author } : null) }).text : "";
    chosen.current = {
      ...(offer.asksStatus ? { to: offer.to ?? moves[0]!.toStatus } : null),
      ...(offer.asksClear ? { clear: false } : null),
      ...(offer.asksComment ? { comment: start } : null),
    };
    const yes = await ask({
      title: `${offer.label.replace("…", "")} ${task.customId || task.id}?`,
      node: <Questions task={task} offer={offer} moves={moves} people={people} start={start} onChange={(c) => { chosen.current = c; }} />,
      confirmLabel: offer.label.replace("…", ""),
    });
    if (yes) await run(offer, chosen.current);
  };

  return (
    <>
      {offers.map((o) => (
        <Button key={o.key} size="compact" data-step={o.key} onClick={() => { void press(o); }} pending={busy} disabled={busy || !writes}
          title={writes ? o.label.replace("…", "") : STEPS_OFF}>
          {o.label}
        </Button>
      ))}
      {settings && !writes && (
        <span className="text-[10px] basis-full" data-steps-off="" style={{ color: "var(--text3)" }}>{STEPS_OFF}</span>
      )}
      {dialog}
    </>
  );
}


import { useState } from "react";
import { Button } from "../workspace/Chrome.tsx";
import { useStepDialog } from "./JiraStepDialog.tsx";
import { api } from "../../lib/api.ts";
import { putCard } from "../../lib/prCardStore.ts";
import { projectOf, ruleFor, useJiraSettings } from "../../lib/jiraSettings.ts";
import { STEPS_OFF, stepOffers, useJiraSteps, type StepOffer } from "../../lib/jiraStepUi.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { fillTemplate } from "../../../../shared/stepBlocks.ts";
import { addJiraLink, readJiraLinks } from "../../lib/jiraLinks.ts";
import { alreadyLinked, assignable, onCard, ruleBlocks } from "../../lib/jiraStepPlan.ts";
import type { StatusOption } from "../../lib/trackerStatus.ts";
import type { JiraPerson, JiraStepChoice, JiraStepPr, ProviderTask, StepBlock } from "../../../../shared/providers.ts";

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
  const { show, dialog } = useStepDialog();
  const [busy, setBusy] = useState(false);
  const offers = stepOffers(steps, task, { project: projectOf(task), overrides: read?.overrides ?? [], rules: settings?.handoff ?? {} });
  if (!offers.length) return dialog;
  const writes = settings?.writes === true;

  /** What the press did, said where the button is. The step ran inside the dialog; this only reports and refreshes. */
  const landed = (r: Awaited<ReturnType<typeof api.jiraRunStep>>) => {
    const warn = !r.ok ? (("conflict" in r && r.conflict) ? "somebody changed this card while you had it open" : r.error || "Jira refused that") : ("partial" in r && r.partial ? r.partial : "");
    onSaid(warn ? `!${warn}` : "task" in r && r.task?.status ? `now ${r.task.status}` : "done");
    if ("task" in r && r.task) { putCard(query, r.task); onTask?.(r.task); }
  };

  const press = async (offer: StepOffer) => {
    if (busy || !writes) return;
    const key = task.customId || task.id;
    // A project whose older hand-off rule wins is run by that rule, so the rows are that rule's.
    const rule = offer.byRule ? ruleFor(settings, projectOf(task)) : null;
    const blocks: readonly StepBlock[] = rule ? ruleBlocks(rule) : steps ? steps[offer.key].blocks : [];
    setBusy(true);
    try {
      let moves: StatusOption[] = [];
      if (offer.asksStatus) {
        const o = await TRACKERS.jira.statusOptions(task);
        if (!o.ok) { onSaid(`!${o.error || "the card's moves could not be read"}`); return; }
        // A move that asks for a field cannot be made from here.
        moves = (o.data ?? []).filter((m) => !m.needs?.length);
        if (!moves.length) { onSaid(`!${key} has no move that can be made from here`); return; }
      }
      let people: JiraPerson[] = [];
      if (offer.asksAssign) {
        const r = await api.jiraAssignable(key, "").catch(() => null);
        if (!r?.ok) { onSaid(`!${r?.error || "the people could not be read"}`); return; }
        people = r.people ?? [];
      }
      // Read once and shared with the card's own pane; a card with no link block never asks.
      const linked = pr && blocks.some((b) => b.type === "link") ? alreadyLinked((await readJiraLinks(key)), pr.url) : null;
      const start = offer.comment ? fillTemplate(offer.comment, { ...(pr ? { pr: `${pr.number ? `#${pr.number} ` : ""}${pr.title ?? ""}`.trim(), pr_url: pr.url } : null), ...(pr?.author ? { author: pr.author } : null) }).text : "";
      setBusy(false);
      let last: Awaited<ReturnType<typeof api.jiraRunStep>> | null = null;
      await show({
        verb: offer.label.replace("…", ""),
        card: { key, title: task.title, status: task.status, statusColor: task.statusColor, assignee: onCard(task.people?.[0]) },
        blocks, to: offer.to, moves, comment: start, pr, linked, writes,
        asks: { status: offer.asksStatus, clear: offer.asksClear, assign: offer.asksAssign, comment: offer.asksComment },
        people: people.map(assignable),
        run: async (choice: JiraStepChoice) => {
          onSaid(`${offer.label.replace("…", "")}…`);
          const r = await api.jiraRunStep(key, task.updated, offer.key, choice, pr).catch(() => ({ ok: false, error: "Could not reach the server" } as const));
          last = r;
          return r;
        },
      });
      // Said once the dialog is closed: the card changing under it would take the button, and the result, away.
      if (last) {
        landed(last);
        const l = last as { ok: boolean; blocks?: { block: string; state: string }[] };
        if (pr && l.ok && l.blocks?.some((b) => b.block === "link" && b.state === "done")) addJiraLink(key, { url: pr.url, number: pr.number ?? 0, title: pr.title ?? "", resolved: false });
      }
    } finally { setBusy(false); }
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


import { useRef, useState } from "react";
import { Select } from "./Select.tsx";
import { Button } from "./workspace/Chrome.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { putCard } from "../lib/prCardStore.ts";
import { handoffOffer, handoffSaid } from "../lib/trackerPeople.ts";
import { projectOf, ruleFor, useJiraSettings } from "../lib/jiraSettings.ts";
import type { StatusOption } from "../lib/trackerStatus.ts";
import type { Tracker } from "../lib/trackerApi.ts";
import type { JiraHandoffRule, ProviderTask } from "../../../shared/providers.ts";

/** The card, where it goes, and who comes off it: what the hand-off will do, seen before it is done. */
function Summary({ task, to, clear }: { task: ProviderTask; to: string; clear: boolean }) {
  const on = task.people?.[0]?.name;
  return (
    <div className="text-[11.5px] flex flex-col gap-1" style={{ color: "var(--text2)" }}>
      <div><span style={{ color: "var(--text3)" }}>{task.customId || task.id}</span> {task.title}</div>
      <div>{task.status || "No status"} → <b style={{ color: "var(--text)" }}>{to}</b></div>
      <div>{on ? (clear ? `${on} comes off the card` : `${on} stays on it`) : "Nobody is on it"}</div>
    </div>
  );
}

/**
 * The question, when a value of the hand-off asks when it runs: the status
 * from the card's own moves, starting at the setting, and whether the
 * assignee comes off. What is chosen goes back through `onChange` on every
 * change, so the press that confirms writes what the dialog shows.
 */
function Asked({ task, rule, moves, onChange }: {
  task: ProviderTask; rule: JiraHandoffRule; moves: StatusOption[];
  onChange: (c: { to: string; name: string; clear: boolean }) => void;
}) {
  const start = moves.find((m) => m.toId === rule.to?.id) ?? moves[0];
  const [to, setTo] = useState(start?.toId ?? "");
  const [clear, setClear] = useState(rule.clear);
  const name = moves.find((m) => m.toId === to)?.toStatus ?? rule.to?.name ?? "";
  const tell = (t: string, c: boolean) => onChange({ to: t, name: moves.find((m) => m.toId === t)?.toStatus ?? "", clear: c });
  return (
    <div className="flex flex-col gap-2.5">
      {rule.askTo && (
        <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text2)" }}>
          <span className="shrink-0">Move to</span>
          <Select value={to} title="Hand-off status" onChange={(v) => { setTo(v); tell(v, clear); }}
            options={moves.map((m) => ({ value: m.toId!, label: m.toStatus, tint: m.color, pill: true, dim: m.toKind === "done" }))} />
        </label>
      )}
      {rule.askClear && task.people?.[0] && (
        <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text2)" }}>
          <input type="checkbox" checked={clear} onChange={(e) => { setClear(e.target.checked); tell(to, e.target.checked); }} />
          Take {task.people[0].name} off the card
        </label>
      )}
      {to ? <Summary task={task} to={name} clear={clear} /> : null}
    </div>
  );
}

/**
 * The hand-off for a card whose tracker has one (Jira): move it to the
 * project's hand-off status and, if the setting says so, take the assignee
 * off, in one request the server orders. Shown only where a hand-off is set.
 * A fixed destination is the label; a value set to "Ask when it runs" is
 * asked in the dialog, starting from the setting. An answer that landed only
 * in part is said as a warning, never as plain success.
 * ClickUp's hand-off is `CardReadyForQaButton`, and is not this.
 */
export function TrackerHandOffButton({ tracker, task, query, onSaid, onTask }: {
  tracker: Tracker; task: ProviderTask; query: string; onSaid: (s: string) => void;
  onTask?: (t: ProviderTask) => void;
}) {
  const settings = useJiraSettings();
  const { ask, dialog } = useDialogs();
  const [busy, setBusy] = useState(false);
  const chosen = useRef<{ to: string; name: string; clear: boolean } | null>(null);
  const rule = ruleFor(settings, projectOf(task));
  const offer = handoffOffer(rule);
  const run = tracker.handOff;
  if (!run || !rule || !offer) return dialog;
  // Already where a fixed hand-off would take it: nothing to offer.
  if (!rule.askTo && rule.to && task.statusId === rule.to.id) return dialog;

  const send = async (choice: { to?: string; clear?: boolean }) => {
    setBusy(true);
    onSaid("handing off…");
    const r = await run(task, choice);
    setBusy(false);
    onSaid(handoffSaid(r));
    if (r.task) { putCard(query, r.task); onTask?.(r.task); }
  };

  const press = async () => {
    if (busy) return;
    if (!offer.asks) {
      const clear = rule.clear;
      const yes = await ask({ title: `${offer.label}?`, node: <Summary task={task} to={rule.to!.name} clear={clear} />, confirmLabel: offer.label });
      if (yes) await send({ to: rule.to!.id, clear });
      return;
    }
    let moves: StatusOption[] = [];
    if (rule.askTo) {
      const o = await tracker.statusOptions(task);
      if (!o.ok) { onSaid(`!${o.error || "the card's moves could not be read"}`); return; }
      // One row per status; a move that asks for a field cannot be made from here.
      const seen = new Set<string>();
      moves = (o.data ?? []).filter((m) => m.toId && !m.needs?.length && !seen.has(m.toId) && !!seen.add(m.toId));
      if (!moves.length) { onSaid(`!${task.customId || task.id} has no move that can be made from here`); return; }
    }
    const start = rule.askTo ? (moves.find((m) => m.toId === rule.to?.id) ?? moves[0]!) : null;
    chosen.current = {
      to: start?.toId ?? rule.to?.id ?? "",
      name: start?.toStatus ?? rule.to?.name ?? "",
      clear: rule.clear,
    };
    if (!chosen.current.to) { onSaid("!choose where the hand-off goes in Settings"); return; }
    const yes = await ask({
      title: `Hand off ${task.customId || task.id}?`,
      node: rule.askTo
        ? <Asked task={task} rule={rule} moves={moves} onChange={(c) => { chosen.current = c; }} />
        : <Asked task={task} rule={rule} moves={[{ key: "", label: chosen.current.name, toStatus: chosen.current.name, toId: chosen.current.to, toKind: "open" }]} onChange={(c) => { chosen.current = c; }} />,
      confirmLabel: "Hand off",
    });
    if (!yes || !chosen.current.to) return;
    await send({ to: chosen.current.to, clear: chosen.current.clear });
  };

  return (
    <>
      <Button size="compact" onClick={() => { void press(); }} pending={busy} disabled={busy}
        title={`${offer.label.replace("…", "")}${rule.clear && !rule.askClear ? ", taking the assignee off" : ""}`}>
        {offer.label}
      </Button>
      {dialog}
    </>
  );
}

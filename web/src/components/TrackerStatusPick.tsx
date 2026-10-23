import { useCallback, useEffect, useState } from "react";
import { Select, type SelectOption } from "./Select.tsx";
import { putCard } from "../lib/prCardStore.ts";
import { useMoveForm } from "./jira/JiraMoveForm.tsx";
import { askHint } from "../lib/jiraMoveForm.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import type { Tracker } from "../lib/trackerApi.ts";
import type { StatusOptionsResult } from "../lib/trackerStatus.ts";

/** The row for the card's own status, in a list of picks that does not contain it. */
const CURRENT = "\u0000current";
/** The row that says why there is nothing to pick. */
const WHY_NOT = "\u0000why";

/**
 * The status control for a card whose tracker moves it by transition (Jira).
 * ClickUp's own picker is `CardStatusPick` in the pull request panel and is not
 * replaced by this.
 *
 * What it lists is whatever the tracker offers from where the card is now, read
 * the first time the list is opened (a card nobody touches costs no request).
 * A move that needs a field is in the list with the field named, and picking it
 * opens a form for the fields instead of moving at once; a card that cannot be
 * moved says so in the list instead of showing an empty one. `updated` rides along with the write, so a card that changed while
 * this was open comes back as a conflict.
 */
export function TrackerStatusPick({ tracker, task, query, onSaid, onTask, align }: {
  tracker: Tracker; task: ProviderTask; query: string; onSaid: (s: string) => void;
  /** Which edge of the control the list lines up with: `right` where the control sits at the end of a row. */
  align?: "left" | "right";
  /** The card after a move, for a list that holds its own copy (its new stamp rides the next write). */
  onTask?: (t: ProviderTask) => void;
}) {
  const [opts, setOpts] = useState<StatusOptionsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useMoveForm();
  const load = useCallback(() => {
    if (opts !== null) return;
    void tracker.statusOptions(task)
      .then(setOpts)
      .catch(() => setOpts({ ok: false, error: "Could not reach the server" }));
  }, [opts, tracker, task]);
  // A card that moved has different moves from here; what was read is no longer its list.
  useEffect(() => { setOpts(null); }, [task.status, task.updated, tracker.id]);

  const list = opts?.ok ? (opts.data ?? []) : [];
  const options: SelectOption[] = [
    { value: CURRENT, label: task.status, tint: task.statusColor || undefined, pill: true, dim: task.statusKind === "done" },
    ...list.map((x) => ({
      value: x.key, label: x.label, tint: x.color || undefined, pill: true, dim: x.toKind === "done",
      ...(x.needs?.length ? { hint: askHint(x.fields, x.needs) } : null),
    })),
    ...(opts && !opts.ok && opts.error ? [{ value: WHY_NOT, label: opts.error, disabled: true }] : []),
    // The list is read when it is first opened; until it lands the row says so, where the moves will be.
    ...(opts === null ? [{ value: WHY_NOT, label: "Reading what this card can do…", disabled: true }] : []),
  ];

  const move = async (key: string) => {
    const opt = list.find((x) => x.key === key);
    if (!opt || busy) return;
    // A move that asks for fields is made from the form, which sends it itself.
    if (opt.needs?.length && opt.fields?.length) {
      const asked = await form.show({
        card: { key: task.customId || task.id, title: task.title, status: task.status, statusColor: task.statusColor || undefined },
        to: { status: opt.toStatus, color: opt.color },
        fields: opt.fields,
        run: (values) => tracker.setStatus(task, opt, values),
      });
      if (asked?.ok) {
        onSaid(`now ${opt.toStatus}`);
        putCard(query, asked.task);
        if (asked.task) onTask?.(asked.task);
      }
      return;
    }
    setBusy(true);
    onSaid("moving…");
    const r = await tracker.setStatus(task, opt);
    setBusy(false);
    onSaid(r.ok ? `now ${opt.toStatus}` : `!${r.conflict ? "somebody changed this card while you had it open" : r.error || "the tracker refused that"}`);
    if (r.ok) putCard(query, r.task);
    if (r.ok && r.task) onTask?.(r.task);
  };

  return (
    <span className="min-w-0" onMouseEnter={load}>
      <Select value={CURRENT} onChange={(v) => { void move(v); }} onOpen={load} busy={busy} title="Status" options={options} align={align} />
      {form.dialog}
    </span>
  );
}

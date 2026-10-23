import { useCallback, useEffect, useState } from "react";
import { Select, type SelectOption } from "./Select.tsx";
import { putCard } from "../lib/prCardStore.ts";
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
 * A move that needs a field is in the list and cannot be picked, with the field
 * named; a card that cannot be moved says so in the list instead of showing an
 * empty one. `updated` rides along with the write, so a card that changed while
 * this was open comes back as a conflict.
 */
export function TrackerStatusPick({ tracker, task, query, onSaid }: {
  tracker: Tracker; task: ProviderTask; query: string; onSaid: (s: string) => void;
}) {
  const [opts, setOpts] = useState<StatusOptionsResult | null>(null);
  const [busy, setBusy] = useState(false);
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
      ...(x.needs?.length ? { disabled: true, hint: `needs ${x.needs.join(", ")}` } : null),
    })),
    ...(opts && !opts.ok && opts.error ? [{ value: WHY_NOT, label: opts.error, disabled: true }] : []),
  ];

  const move = async (key: string) => {
    const opt = list.find((x) => x.key === key);
    if (!opt || opt.needs?.length || busy) return;
    setBusy(true);
    onSaid("moving…");
    const r = await tracker.setStatus(task, opt);
    setBusy(false);
    onSaid(r.ok ? `now ${opt.toStatus}` : `!${r.conflict ? "somebody changed this card while you had it open" : r.error || "the tracker refused that"}`);
    if (r.ok) putCard(query, r.task);
  };

  return (
    <span className="min-w-0" onMouseEnter={load}>
      <Select value={CURRENT} onChange={(v) => { void move(v); }} onOpen={load} busy={busy} title="Status" options={options} />
    </span>
  );
}

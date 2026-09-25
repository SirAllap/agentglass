import { useEffect, useState } from "react";
import type { LaneRow } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";

/**
 * What the row says about lanes, or null for none. Owners first, counted once
 * each: "2 lanes · orbit ×2" would be noise, "orbit, acme" is who to ask.
 * Never the ids or anything a page said — this is a glance, not a list.
 */
export function lanesLabel(rows: readonly LaneRow[]): string | null {
  if (rows.length === 0) return null;
  const owners = [...new Set(rows.map((l) => l.as || "an agent"))];
  return `${rows.length} ${rows.length === 1 ? "lane" : "lanes"} · ${owners.slice(0, 3).join(", ")}${owners.length > 3 ? "…" : ""}`;
}

/**
 * The agents' private windows, as one quiet line in the Browser sidebar.
 *
 * A badge, not a notification, and it reveals nothing when clicked because
 * there is nothing to reveal: a lane has no window the person could look at.
 * Absent when there are none, so a person who never uses lanes never sees it.
 */
export function LanesRow() {
  const [rows, setRows] = useState<LaneRow[]>([]);
  const read = () => { void api.browserLanes().then((r) => setRows(r.lanes ?? []), () => { /* the server is restarting */ }); };
  useEffect(read, []);
  usePoll(true, read, 10_000);
  const label = lanesLabel(rows);
  if (!label) return null;
  return (
    <div className="shrink-0 px-2.5 py-1.5 text-[10.5px] truncate"
      style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--text3)" }}
      title="Private browser windows agents are working in. They are not on your screen.">
      {label}
    </div>
  );
}

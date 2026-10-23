import { StatusPill } from "./StatusPill.tsx";
import { Face } from "./AssignPicker.tsx";
import { FlagIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EDGE } from "./workspace/Chrome.tsx";

/*
 * The two pieces a hand-off dialog draws the same for every tracker: the card
 * it is about, and where its status goes. ClickUp's summary drew them inline;
 * they live here so the Jira step's dialog is the same drawing, not a copy of
 * it that drifts. Both take plain values, nothing of either tracker's task.
 */

/** The card: its id as a chip, its title under it. */
export function CardRef({ id, title }: { id: string; title: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ border: EDGE }}>
      <span className="inline-flex items-center gap-1 rounded px-1.5 text-[10.5px]" style={{ border: EDGE }}>
        <FlagIcon size={ICON.xs} />{id}
      </span>
      <div className="mt-1.5 text-[12.5px] leading-snug" style={{ color: "var(--text)" }}>{title}</div>
    </div>
  );
}

/** Where the card is and where it goes, each as its board draws the status; `to` absent is "stays". */
export function StatusMove({ from, fromColor, to, toColor }: { from: string; fromColor?: string | undefined; to?: string | undefined; toColor?: string | undefined }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <StatusPill status={from} color={fromColor} />
      {to ? <><span style={{ color: "var(--text3)" }}>→</span><StatusPill status={to} color={toColor} /></> : <span style={{ color: "var(--text3)" }}>stays</span>}
    </div>
  );
}

/** A person as a face and a name, always both: a picture is recognition, the name is who it is. */
export function PersonLine({ p, size = ICON.md, strike }: { p: { name: string; initials: string; avatar?: string | undefined; color?: string | undefined }; size?: number; strike?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0${strike ? " line-through" : ""}`} data-person="">
      <Face m={p} size={size} />
      <span className="truncate">{p.name}</span>
    </span>
  );
}

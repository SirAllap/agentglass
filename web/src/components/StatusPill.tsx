import { CHIP_H } from "../lib/priority.tsx";
/**
 * A tracker status, as its board draws it.
 *
 * Lived inside TasksPanel, where the merge dialog could not reach it — and the
 * merge dialog needed exactly this: a board is recognised by colour before it
 * is read by word, and seventeen statuses rendered as seventeen identical grey
 * lines is a list somebody has to parse rather than glance at.
 *
 * `dim` is for the ones a board files under done or closed: still legible,
 * deliberately quieter, because "COMPLETED" is not news the way "BLOCKED" is.
 * With no colour it takes the app's own tone — never one invented to fill the
 * gap, which would stand beside real ones and read as real.
 */
export function StatusPill({ status, color, dim }: { status: string; color?: string; dim?: boolean }) {
  if (!status) return null;
  const c = color || "var(--text3)";
  return (
    /* `CHIP_H` and `leading-none`: this let its line-height set its height and
       came out three pixels taller than the id chip beside it on the board's
       card. Every chip on a row is the same height now, by number rather than
       by each one's own padding arithmetic. */
    <span className="text-[9.5px] tracking-[0.06em] px-1.5 rounded whitespace-nowrap inline-flex items-center leading-none"
      title={status}
      style={{
        height: CHIP_H,
        color: dim ? "var(--text4)" : c,
        background: `color-mix(in srgb, ${c} ${dim ? 8 : 15}%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} ${dim ? 18 : 34}%, transparent)`,
      }}>
      {status.toUpperCase()}
    </span>
  );
}

/*
 * THE TRACKER A BLOCK WRITES TO, as a badge: its glyph and its name.
 *
 * Beside a card id, "ORBIT-1042" alone leaves the reader guessing which system
 * the status and the person below it will land in, and the guess is wrong the
 * moment two trackers are connected. A word and a mark, no sentence — the
 * decision of WHICH tracker is `lib/trackerBadge.ts`', and the caller passes
 * the value its own write uses.
 */
import { CheckboxIcon, FlagIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { trackerBadge, type BadgeTracker } from "../lib/trackerBadge.ts";

const INK: Record<BadgeTracker, string> = { jira: "var(--info)", clickup: "var(--primary)" };

export function TrackerBadge({ tracker }: { tracker: BadgeTracker | null | undefined }) {
  const look = trackerBadge(tracker);
  if (!look || !tracker) return null;
  const Icon = look.icon === "flag" ? FlagIcon : CheckboxIcon;
  return (
    <span className="inline-flex items-center gap-1" data-tracker-badge={tracker}
      style={{ color: INK[tracker], fontSize: 10.5, fontWeight: 600, letterSpacing: "0.02em" }}>
      <Icon size={ICON.xs} />
      {look.label}
    </span>
  );
}

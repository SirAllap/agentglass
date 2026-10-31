import { avatarSlot, initialsOf } from "../../lib/avatarColour.ts";
import { ICON } from "../../lib/iconSize.ts";

/** The author's initials on a colour fixed by the author — no image, no network. */
export function CommitAvatar({ author, size = ICON.md }: { author?: string; size?: number }) {
  if (!author) return null;
  return (
    <span aria-label={author} title={author} className="inline-grid shrink-0 place-items-center font-semibold"
      style={{ width: size, height: size, borderRadius: "50%", fontSize: Math.round(size * 0.46), lineHeight: 1, color: "var(--on-primary)", background: `var(--graph-${avatarSlot(author)})` }}>
      {initialsOf(author)}
    </span>
  );
}

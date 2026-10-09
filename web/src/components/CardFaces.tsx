import { CircleIcon, CommentIcon, CrossIcon, DoneIcon, RefreshIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { moreTitle, type CardFace, type CardReviewers } from "../lib/cardReviewers.ts";
import { Avatar } from "./Avatar.tsx";

/*
 * The ring says where a person stands; the badge says it again by shape, for
 * anyone who cannot tell amber from grey. Amber solid is "asked again after
 * they answered", grey dashed is "asked, never answered" (the same hollow the
 * pull request's own reviewer list draws), red blocks, green approved.
 */
const TINT: Record<CardFace["state"], string> = {
  again: "var(--warning)", await: "var(--text4)", changes: "var(--error)", approved: "var(--success)", comment: "var(--text4)",
};
const GLYPH: Record<CardFace["state"], (s: number) => JSX.Element> = {
  again: (s) => <RefreshIcon size={s} />, await: (s) => <CircleIcon size={s} />, changes: (s) => <CrossIcon size={s} />,
  approved: (s) => <DoneIcon size={s} />, comment: (s) => <CommentIcon size={s} />,
};

/** Every person the band waits on or has heard from. No control: the whole
 *  card opens on a press, and each face is a tooltip. */
export function CardFaces({ r }: { r: CardReviewers }) {
  if (r.faces.length === 0) return null;
  return (
    <span aria-hidden className="shrink-0 flex items-center" data-card-faces style={{ gap: 8, paddingRight: 6 }}>
      {r.faces.map((f) => (
        <span key={f.login} title={f.title} data-face-state={f.state} className="relative inline-flex shrink-0 rounded-full"
          style={{ width: ICON.md, height: ICON.md }}>
          {f.team
            ? <span className="rounded-full inline-flex items-center justify-center"
                style={{ width: ICON.md, height: ICON.md, fontSize: 7, color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 24%, transparent)" }}>
                {f.login.slice(0, 2).toUpperCase()}
              </span>
            : <Avatar login={f.login} size={ICON.md} />}
          {/* Outside the avatar, so the face keeps its 16px and the band its 22. */}
          <span className="absolute rounded-full pointer-events-none"
            style={{ inset: -3, border: `1.5px ${f.state === "await" ? "dashed" : "solid"} ${TINT[f.state]}` }} />
          <span className="absolute inline-flex items-center justify-center rounded-full"
            style={{ right: -4, bottom: -3, width: ICON.xs, height: ICON.xs, color: TINT[f.state], background: "var(--surface-card)", boxShadow: "0 0 0 1px var(--surface-card)" }}>
            {GLYPH[f.state](ICON.xs)}
          </span>
        </span>
      ))}
      {r.more.length > 0 && (
        <span title={moreTitle(r)} data-card-more className="inline-flex items-center rounded-full tabular-nums"
          style={{ height: ICON.md, padding: "0 6px", fontSize: 9.5, fontWeight: 600, color: "var(--text2)", background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>
          +{r.more.length}
        </span>
      )}
    </span>
  );
}

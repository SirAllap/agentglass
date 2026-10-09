import type { ReviewerState } from "../../../shared/reviewRoster.ts";
import { CrossIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { PERSON_TINT, badgeGlyph, barLayout, wash } from "../lib/reviewBar.ts";
import { Avatar } from "./Avatar.tsx";

/**
 * A reviewer's face, and where they stand.
 *
 * The one place a GitHub login in the merge box becomes a picture: the Review
 * stage's bar, the rows under it, the history. The state is a ring in its
 * colour and, when `badge` is set, a small mark at the corner — the picture
 * says who, the colour says where they are, and the text beside it still says
 * both in words. A team has no portrait to ask the proxy for, so it gets its
 * initials; a login without a picture falls back inside `Avatar`.
 */
export function ReviewFace({ login, state, size = ICON.xl, badge, team }: {
  login: string; state?: ReviewerState; size?: number; badge?: boolean; team?: boolean;
}) {
  const tint = state ? PERSON_TINT[state] : undefined;
  const glyph = state && badge ? badgeGlyph(state) : "none";
  const dot = Math.round(size * 0.5);
  return (
    <span aria-hidden className="relative shrink-0 inline-flex rounded-full"
      style={{ width: size, height: size, boxShadow: tint ? `0 0 0 2px var(--surface-card), 0 0 0 3.5px ${tint}` : undefined }}>
      {team || state === "team"
        ? <span className="rounded-full inline-flex items-center justify-center" title={`${login} (team)`}
            style={{ width: size, height: size, fontSize: size * 0.42, color: "var(--text2)", background: wash("var(--primary)", 24) }}>
            {login.slice(0, 2).toUpperCase()}
          </span>
        : <Avatar login={login} size={size} />}
      {badge && tint && (
        <span className="absolute grid place-items-center rounded-full"
          style={{
            width: dot, height: dot, right: -dot * 0.3, bottom: -dot * 0.3, background: tint,
            color: "var(--bg)", boxShadow: "0 0 0 1.5px var(--surface-card)",
          }}>
          {glyph === "tick" ? <DoneIcon size={dot} /> : glyph === "cross" ? <CrossIcon size={dot} /> : null}
        </span>
      )}
    </span>
  );
}

/**
 * The Review stage's bar: one segment per reviewer, the whole width of the
 * cell, split evenly — line, face, line — so one approval of one is a full bar
 * with its person in the middle, and two reviewers are half each. Which
 * segments carry a face is `barLayout`'s call. A tooltip hangs from the left of
 * the whole bar, not of its segment: the Review stage is the first cell of the
 * box, so a tooltip centred on a segment is cut by the box's left edge, and the
 * room is to the right.
 */
export function ReviewBar({ tally }: { tally: { key: ReviewerState; login: string; label: string }[] }) {
  const layout = barLayout(tally.length);
  // Segments that carry no face are a fixed stub, and the gaps close up: split
  // evenly, six segments left each faced one 24px and its face sat on the line.
  const crowded = layout.some((s) => !s.face);
  return (
    <div className={`relative flex ${crowded ? "gap-1" : "gap-2"} mt-2`} role="group" aria-label={tally.map((t) => t.label).join(", ")}>
      {layout.map((seg) => {
        const t = tally[seg.index]!;
        const line = (
          <span aria-hidden className="h-1.5 rounded-full flex-1 min-w-[6px]"
            style={{ background: PERSON_TINT[t.key], boxShadow: t.key === "requested" || t.key === "team" ? `inset 0 0 0 1px ${wash("var(--text)", 30)}` : undefined }} />
        );
        return (
          <span key={`${t.login}:${t.key}`} tabIndex={0} aria-label={t.label}
            className={`group flex items-center gap-1.5 rounded-full outline-none focus-visible:ring-2 ${seg.face ? "flex-1 min-w-0" : "w-3 shrink-0"}`}>
            {line}
            {seg.face && <ReviewFace login={t.login} state={t.key} size={ICON.md} />}
            {seg.face && line}
            <span role="tooltip"
              className="pointer-events-none absolute z-20 top-full left-0 mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] leading-snug w-max max-w-[240px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ background: "var(--text)", color: "var(--bg)" }}>
              <ReviewFace login={t.login} size={ICON.md} team={t.key === "team"} />
              <span className="min-w-0">{t.label}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

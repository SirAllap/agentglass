/*
 * The collapsible heading of a group of cards, shared by the trackers' lists.
 *
 * The whole heading is the control, not a glyph beside it. A nine-pixel
 * triangle is a target you aim at; a row you can hit anywhere is one you use.
 */
import type { ReactNode } from "react";
import { ICON } from "../../lib/iconSize.ts";
import { LINE } from "../workspace/Chrome.tsx";

export function GroupHead({ label, count, points, folded, onToggle, first }: {
  label: ReactNode;
  count: number;
  points?: number;
  folded: boolean;
  onToggle: () => void;
  /** The first group has no rule above it. */
  first: boolean;
}) {
  return (
    <button onClick={onToggle}
      aria-expanded={!folded}
      title={folded ? "Show these" : "Hide these"}
      className="agx-group-head w-full flex items-center py-2 text-left hover:bg-white/5"
      style={{ borderTop: first ? undefined : LINE }}>
      <span className="agx-stick-group flex items-center gap-2">
      {/* A drawn chevron, not a text glyph. `▸` at a readable size renders as a
          speck in this font, and the thing it controls is a section of the
          board. This is a real 20px target with a stroke somebody can see. */}
      <span aria-hidden className="inline-flex items-center justify-center shrink-0"
        style={{ width: 20, height: 20, borderRadius: 6, background: "color-mix(in srgb, var(--text) 6%, transparent)" }}>
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none"
          style={{ transform: folded ? "none" : "rotate(90deg)", transition: "transform 120ms ease" }}>
          <path d="M4 2.5 L8.5 6 L4 9.5" stroke="var(--text2)" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {label}
      <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{count}</span>
      {points != null && points > 0 && (
        <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>· {points} pts</span>
      )}
      {folded && (
        <span className="text-[10px]" style={{ color: "var(--text4)" }}>· hidden</span>
      )}
      </span>
    </button>
  );
}

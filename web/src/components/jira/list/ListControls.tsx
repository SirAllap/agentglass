/*
 * The two controls the Jira list's top rows are made of: a 28 high text control and a 28 square icon button. One height,
 * one hover (the house `agx-chip`) and one focus ring (the global :focus-visible), so a row of them lines up and answers
 * the pointer the same way. The edge is a box-shadow ring, not a border, so a control that turns on does not move.
 * Every icon-only control carries its tooltip (`data-tip`, drawn by TipHost) and the same words as its aria-label.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { ICON } from "../../../lib/iconSize.ts";
import { tipAttr, type TipSpec } from "../../../lib/tip.ts";
import { CTRL_H } from "../../workspace/Chrome.tsx";

const RING = "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)";
const REST = "color-mix(in srgb, var(--text) 5%, transparent)";
const ringOf = (hue: string) => `inset 0 0 0 1px color-mix(in srgb, ${hue} 40%, transparent)`;

export type CtlTone = "plain" | "ok" | "primary" | "quiet" | "danger";

function look(tone: CtlTone, pressed: boolean | undefined) {
  if (tone === "primary") return { background: "var(--primary)", color: "var(--on-primary)", boxShadow: "none", fontWeight: 600 };
  if (tone === "quiet") return { background: "transparent", color: "var(--text3)", boxShadow: "none" };
  if (tone === "danger") return { background: REST, color: "var(--error-ink)", boxShadow: RING };
  if (pressed) {
    const hue = tone === "ok" ? "var(--success)" : "var(--primary)";
    return { background: `color-mix(in srgb, ${hue} 14%, transparent)`, color: "var(--text)", boxShadow: ringOf(hue), fontWeight: 600 };
  }
  return { background: REST, color: "var(--text2)", boxShadow: RING };
}

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "children" | "style"> & { btnRef?: Ref<HTMLButtonElement> };

/** A text control, 28 high, 10 of inline padding. `pressed` makes it a toggle (aria-pressed). */
export function Ctl({ tone = "plain", pressed, tip, compact, btnRef, children, ...rest }: BtnProps & {
  tone?: CtlTone; pressed?: boolean; tip?: string | TipSpec; compact?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" ref={btnRef} {...rest} {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      {...(tip ? { "data-tip": tipAttr(tip) } : {})}
      className="agx-chip inline-flex items-center whitespace-nowrap shrink-0 disabled:opacity-50"
      style={{
        height: compact ? CTRL_H.compact : CTRL_H.regular, padding: "0 10px", gap: 6, borderRadius: 8, fontSize: compact ? 10.5 : 11,
        cursor: rest.disabled ? "not-allowed" : undefined, ...look(tone, pressed),
      }}>
      {children}
    </button>
  );
}

function iconLook(size: number, edge: boolean | undefined, on: boolean | undefined) {
  return {
    width: size, height: size, borderRadius: 8,
    ...(edge || on
      ? { background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : REST, color: "var(--text)", boxShadow: on ? ringOf("var(--primary)") : RING }
      : { background: "transparent", color: "var(--text3)" }),
  };
}

/** An icon-only control, 28 square. `label` is both the tooltip's name and the aria-label. */
export function ListIconBtn({ label, tip, on, edge, size = CTRL_H.regular, btnRef, children, ...rest }: BtnProps & {
  label: string; tip?: string | TipSpec; on?: boolean; edge?: boolean; size?: number; children: ReactNode;
}) {
  return (
    <button type="button" ref={btnRef} {...rest} aria-label={label} data-tip={tipAttr(tip ?? label)}
      {...(on !== undefined ? { "aria-pressed": on } : {})}
      className="agx-chip inline-grid place-items-center shrink-0 disabled:opacity-50"
      style={{ ...iconLook(size, edge, on), cursor: rest.disabled ? "not-allowed" : undefined }}>
      {children}
    </button>
  );
}

/** The same square, as a link that leaves the app (Open in Jira). */
export function IconLink({ label, tip, href, edge, children }: { label: string; tip?: string | TipSpec; href: string; edge?: boolean; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" aria-label={label} data-tip={tipAttr(tip ?? label)}
      className="agx-chip inline-grid place-items-center shrink-0" style={iconLook(CTRL_H.regular, edge, undefined)}>
      {children}
    </a>
  );
}

/** The caret of a control that opens a menu, turned to point down. */
export const Caret = () => (
  <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3.4 5.4 7 9l3.6-3.6" />
  </svg>
);

export const FunnelIcon = ({ size = ICON.sm }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 3.2h10L8.2 7.6v3.2L5.8 12V7.6Z" />
  </svg>
);

/** A small caption in the chips row ("Group", "Then"). */
export const Eyebrow = ({ children }: { children: ReactNode }) => (
  <span className="text-[10.5px] uppercase shrink-0" style={{ letterSpacing: ".04em", color: "var(--text4)" }}>{children}</span>
);

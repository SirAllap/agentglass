import type { CSSProperties, ReactNode } from "react";
import { LINE, tintEdge } from "../workspace/Chrome.tsx";

/**
 * The page's own blocks: a numbered section heading, and the white card the
 * sections sit on. The approved mock draws the page as four numbered steps,
 * each a heading with one sentence under it and, at the right, the one action
 * that belongs to it; these two pieces are that, said once.
 *
 * The card is `--bg`, not `--surface-card`: the mock's cards are the page's own
 * colour with an edge, so a card inside the page never reads as a grey box in a
 * grey box.
 */
export function Sec({ n, title, sub, right, id }: { n: number; title: string; sub: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div id={id} data-sec={n} className="flex flex-wrap items-end gap-3 mt-8 mb-3">
      <span aria-hidden className="t-mono self-start mt-1 text-[11px] font-semibold px-2 rounded-xl tabular-nums"
        style={{ color: "var(--text3)", border: "1px solid var(--border)" }}>{n}</span>
      <div className="min-w-0">
        <h2 className="m-0 text-[15px] font-semibold leading-tight" style={{ color: "var(--text)" }}>{title}</h2>
        <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--text3)" }}>{sub}</p>
      </div>
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export const CARD: CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border2)", borderRadius: 12, boxShadow: "var(--surface-lift)", padding: 16,
};

export function Card({ children, style, ...rest }: { children: ReactNode; style?: CSSProperties } & Record<`data-${string}`, string | undefined>) {
  return <div {...rest} className="min-w-0" style={{ ...CARD, ...style }}>{children}</div>;
}

/** A small label above a block, as the mock's "Right now for orbit". */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: "var(--text3)" }}>{children}</div>;
}

/** The rule between two things on a card. */
export const RULE = LINE;
export const tint = tintEdge;

/**
 * A pill track with one white thumb: the compact "pick one of a few" control
 * of the Orchestration page (a preset, a project). Buttons, not a select,
 * because every choice is in view; `aria-pressed` carries the state, never the
 * fill alone. An option may be disabled and say why in its title.
 */
export function OrchSeg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T | "";
  options: readonly { id: T; label: ReactNode; title?: string; disabled?: boolean; own?: boolean }[];
  onChange: (id: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="agx-orch-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} title={o.title} data-own={o.own ? "" : undefined}
          disabled={disabled || o.disabled} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

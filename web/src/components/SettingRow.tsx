/*
 * The one row every settings page is made of.
 *
 * Lifted out of SettingsModal so the pages that live in their own files —
 * the agents list, remote access — are built from the same thing as the ones
 * that do not. When it was private to the modal, "use the primitive" meant
 * "move your page into a 2,700-line file", so nobody did, and twelve pages
 * grew their own idea of what a row looks like.
 */
import { createContext, isValidElement, useContext, useState } from "react";

/* ─────────────────────────── Searching the settings ─────────────────────────
 *
 * The box in the nav used to filter the PAGES. That answers "which page is
 * this on", which is the question you have when you already know the setting
 * exists — and it is the smaller half of what people type into a settings
 * search. The other half is "where is the thing that stops the beeping", and
 * for that the useful unit is the row, not the page.
 *
 * VS Code's settings search is the shape everyone recognises, and the reason
 * it works is that the result is a list of SETTINGS you can operate in place,
 * not a list of places to go and look. So: the nav still narrows to the pages
 * that match, and inside the page the rows that do not match step aside.
 *
 * Two rules keep it from lying:
 *   - if nothing on the page matches by row, the page shows in full. It got
 *     here on its keywords, and hiding every row would read as an empty page
 *     rather than as a search that went wide.
 *   - a banner says filtering is on. A page silently missing half its rows is
 *     how somebody concludes a setting was removed.
 */
export const Filter = createContext<{ on: boolean; q: string; seen: (matched: boolean) => void }>(
  { on: false, q: "", seen: () => { /* no filtering outside the dialog */ } },
);

/** The words a row is made of. Labels and hints are React nodes — a string, or
 *  a sentence with a <span> in the middle of it — so this flattens rather than
 *  demanding every caller pass a plain string it would then have to repeat. */
export function textOf(n: React.ReactNode): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (isValidElement(n)) return textOf((n.props as { children?: React.ReactNode }).children);
  return "";
}

export function SettingRow({ label, hint, control, onClick, href, download, disabled, role, ariaChecked, align }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  control?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  download?: string;
  disabled?: boolean;
  /** Toggle keeps role="switch" on the ROW, which is what makes the whole row
   *  operable rather than the 34px switch at the end of it. */
  role?: string;
  ariaChecked?: boolean;
  /** A control taller than its label — a stack of buttons, a QR code — reads
   *  better hung from the top than floated in the middle. */
  align?: "center" | "start";
}) {
  const { on, q, seen } = useContext(Filter);
  // Counted on every render, filtering or not: the count is what decides
  // whether filtering is worth doing at all on this page.
  const matched = !q || (textOf(label) + " " + textOf(hint)).toLowerCase().includes(q);
  seen(matched);
  if (on && !matched) return null;

  const body = (
    <>
      <span className="min-w-0">
        <span className="block text-[13.5px]" style={{ color: "var(--text)" }}>{label}</span>
        {/* mt-1, not mt-0.5. A 2px gap under 13.5px type is not a gap — the
            sweep found this pair "touching" on every settings pane there is,
            which is the single most repeated instance of the complaint that
            started this: things that belong together drawn as one block of
            text. 4px is the step for "these two are one thought". */}
        {hint !== undefined && hint !== "" && <span className="block text-[12px] t-dim mt-1">{hint}</span>}
      </span>
      {control !== undefined && <span className="min-w-0">{control}</span>}
    </>
  );
  const cls = `agx-settings-row${align === "start" ? " items-start" : ""}${onClick || href ? " agx-hover" : ""}`;
  const style: React.CSSProperties | undefined = disabled ? { opacity: 0.55 } : undefined;
  if (href) return <a href={href} download={download} className={cls} style={style}>{body}</a>;
  if (onClick) {
    return (
      <button onClick={onClick} disabled={disabled} role={role} aria-checked={ariaChecked}
        className={`${cls} text-left disabled:cursor-not-allowed`} style={style}>{body}</button>
    );
  }
  return <div className={cls} style={style}>{body}</div>;
}

/**
 * A row that opens.
 *
 * Settings pages accumulate paragraphs that are true, useful and read once —
 * why a route is safe, what to do when a phone shows a blank page. Left open
 * they are most of the page's height and all of its weight; deleted they are
 * a support question. So they fold: the row states what is behind it, and the
 * words are one click away instead of nought.
 *
 * It is a SettingRow, not a <details>, because it has to sit on the same grid
 * as everything above and below it — the same left edge, the same hover, the
 * same behaviour under search. The chevron is in the label rather than the
 * control column so the control column stays what it is everywhere else: the
 * place where the thing you operate lives.
 */
export function Fold({ label, hint, children, defaultOpen }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <>
      <SettingRow
        onClick={() => setOpen((v) => !v)}
        label={<span className="flex items-baseline gap-2">
          <span className="inline-block w-2.5 shrink-0 text-[10px]" style={{ color: "var(--text4)" }} aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          {label}
        </span>}
        hint={hint === undefined ? undefined : <span className="block pl-[18px]">{hint}</span>}
      />
      {open && (
        <div className="pb-3 text-[12px] leading-relaxed" style={{ color: "var(--text2)", marginLeft: 18 }}>
          {children}
        </div>
      )}
    </>
  );
}

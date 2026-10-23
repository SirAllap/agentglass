/*
 * The one row every settings page is made of.
 *
 * Lifted out of SettingsModal so the pages that live in their own files —
 * the agents list, remote access — are built from the same thing as the ones
 * that do not. When it was private to the modal, "use the primitive" meant
 * "move your page into a 2,700-line file", so nobody did, and twelve pages
 * grew their own idea of what a row looks like.
 */
import { createContext, isValidElement, useContext, useLayoutEffect, useState } from "react";
import { Disclosure } from "./SettingsKit.tsx";
import { rowMatches, rowId } from "../lib/settingsIndex.ts";

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
 *
 * Considered and dropped: landing on the matching row instead of hiding the
 * rest — scroll to it, mark it, leave its neighbours standing. It teaches
 * more on a first visit, but it loses the one thing hiding is good for: on a
 * page with forty rows, "is it here at all" answered by a glance rather than
 * a scan. This app's settings pages run that long — Notifications, Rail,
 * Shortcuts — and a search that exists to answer that question fast is
 * worth more here than one that also teaches geography. The banner already
 * names the page, so a second search for the same thing is a click away,
 * not a re-read of the whole list.
 */
export const Filter = createContext<{ on: boolean; q: string; seen: (matched: boolean) => void; flash?: string | null }>(
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

/*
 * A description is shown whole.
 *
 * It used to fold past twelve words into one clipped line and a More button.
 * Measured across the settings pages, that cut 89 descriptions mid-sentence
 * and put 85 More buttons on screen, and a reader has to press every one to
 * find the row they came for. A description is now one or two sentences,
 * written to be read in full; anything longer goes in a `detail` disclosure
 * named for what it holds (see SettingsKit's Disclosure).
 */

/** A segmented choice whose options do not fit beside a name in a narrow card:
 *  about 30 characters of labels, padding counted in (4k 10k 25k 50k is 27 and
 *  fits; Auto GPU Canvas Compatibility is 42 and does not). */
export function choiceIsWide(labels: readonly string[]): boolean {
  return labels.reduce((n, l) => n + l.length + 4, 0) >= 30;
}

/** Secondary words behind a named disclosure. */
export type RowDetail = { summary: string; body: React.ReactNode };

export function SettingRow({ label, hint, control, status, actions, below, detail, rowRef, rowProps, minHeight, onClick, href, download, disabled, role, ariaChecked, align, modified, settingId, wide }: {
  /** The SettingDef this row binds to (web/src/lib/settingsRegistry.ts), written
   *  BEFORE `label` so the settings index generator reads it with the row. Also
   *  `agentExempt`, a row that is not a setting, which is read from source only. */
  settingId?: string;
  agentExempt?: boolean;
  agentNever?: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Inline, in the control column: one switch, segmented set, select,
   *  stepper, or at most two buttons. A text field, a textarea, a form, a
   *  preview or a list is `below`, never here. */
  control?: React.ReactNode;
  /** The verdict on this row (a StatusBadge), always first in the control
   *  column, so it stays put whatever comes after it. */
  status?: React.ReactNode;
  /** What can be done to the established thing (Disconnect, Change), after
   *  the status. A confirmation replaces its action in the same place. */
  actions?: React.ReactNode;
  /** The stacked slot under the description, full width: forms, text fields,
   *  previews, lists. Not on a row that is itself a button or a link. */
  below?: React.ReactNode;
  /** Secondary detail in a named disclosure under the description. A row that
   *  is itself a button or a link cannot hold a <details>, so its disclosure is
   *  drawn as the next sibling, tucked under the row (`.agx-row-more`). */
  detail?: RowDetail;
  /** A plain row only: measured by a caller that holds its height while it
   *  waits for an answer, so the page does not jump when the answer lands. */
  rowRef?: React.Ref<HTMLDivElement>;
  /** A plain row only: attributes for the row element itself, for a row that
   *  is dragged or dropped on. A wrapper div around the row would take it out
   *  of the card body, where its divider is drawn. */
  rowProps?: Pick<React.HTMLAttributes<HTMLDivElement>, "draggable" | "onDragStart" | "onDragEnd" | "onDragOver" | "onDrop" | "style">;
  minHeight?: number;
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
  /** Differs from the shipped default: a dot before the label. */
  modified?: boolean;
  /** The control is wider than a narrow card can spare beside the words: under
   *  560px of card it drops under them, left-aligned. */
  wide?: boolean;
}) {
  const { on, q, seen } = useContext(Filter);
  // Counted on every render, filtering or not: the count is what decides
  // whether filtering is worth doing at all on this page.
  const matched = !q || rowMatches(textOf(label) + " " + textOf(hint), q);
  seen(matched);
  if (on && !matched) return null;
  const operable = !!(onClick || href);
  // A button or a link cannot hold a form or a <details>: those slots are for
  // plain rows only (see the props).
  const stacked = operable ? undefined : below;
  const more = operable ? undefined : detail;
  const moreBelow = operable && detail ? <div className="agx-row-more"><Disclosure summary={detail.summary}>{detail.body}</Disclosure></div> : null;
  // Status, actions and anything stacked hang from the top: a badge centred
  // against a three-line description lands in the middle of nowhere, and it
  // must not move when the description grows a line.
  const slotted = status !== undefined || actions !== undefined;
  const top = align === "start" || slotted || stacked !== undefined || more !== undefined;

  const body = (
    <>
      <span className="min-w-0">
        <span className="agx-row-name">
          {modified && (
            <span role="img" aria-label="Changed from default" title="Changed from default"
              className="inline-block rounded-full mr-2 align-middle"
              style={{ width: 6, height: 6, background: "var(--success)" }} />
          )}
          {label}
        </span>
        {/* The help is one muted line under the name, and a 4px gap: a 2px gap
            under 13.5px type is not a gap (the sweep found this pair "touching"
            on every settings pane there is). See `.agx-row-help` in index.css. */}
        {hint !== undefined && hint !== "" && (
          <span className="agx-row-help">{hint}</span>
        )}
        {more && stacked === undefined && <Disclosure summary={more.summary}>{more.body}</Disclosure>}
      </span>
      {slotted
        ? <span className="agx-slot">{status}{control}{actions}</span>
        : control !== undefined && (
          /* A switch is `inline-block`, and an inline-block sitting on a text baseline
             leaves the descender gap under it: 7px more space below a toggle than
             above it once the control drops under the words (the sweep measured
             row padding of 14 above and 21 below). A flex wrapper has no line box. */
          <span className={`min-w-0${role === "switch" ? " flex" : ""}`}>{control}</span>
        )}
      {stacked !== undefined && <div className="agx-row-below">{stacked}</div>}
      {/* With a control stacked under the words, the Details come after it: the control is what the row is for. */}
      {more && stacked !== undefined && <div className="agx-row-below" style={{ marginTop: 0 }}><Disclosure summary={more.summary}>{more.body}</Disclosure></div>}
    </>
  );
  const cls = `agx-settings-row${top ? " items-start" : ""}${onClick || href ? " agx-hover" : ""}${wide ? " agx-row-wide" : ""}`;
  const style: React.CSSProperties | undefined = disabled || minHeight
    ? { ...(disabled ? { opacity: 0.55 } : null), ...(minHeight && !operable ? { minHeight } : null) }
    : undefined;
  // The row's own anchor. openSettings(pane, row) and the command palette
  // both scroll to and flash `[data-row=…]` after the page mounts — derived
  // from the label text so it can never fall out of sync with what the row
  // is now called.
  const dataRow = rowId(textOf(label));
  if (href) return <><a href={href} download={download} className={cls} style={style} data-row={dataRow}>{body}</a>{moreBelow}</>;
  const dataSetting = settingId ? { "data-setting-id": settingId } : undefined;
  if (onClick) {
    return (
      <>
        <button onClick={onClick} disabled={disabled} role={role} aria-checked={ariaChecked}
          className={`${cls} text-left disabled:cursor-not-allowed`} style={style} data-row={dataRow} {...dataSetting}>{body}</button>
        {moreBelow}
      </>
    );
  }
  return <div ref={rowRef} className={cls} data-row={dataRow} {...dataSetting} {...rowProps} style={{ ...style, ...rowProps?.style }}>{body}</div>;
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
/** The on/off pill every toggle row draws, drawn by `.agx-switch` in index.css:
 *  the track is `inline-block` there, because a bare `<span>` ignores its own
 *  width and height and collapses to a dot. On is the success colour, off a
 *  tint of the text, the knob the page's ground on both, so position AND colour
 *  carry the state. A named export rather than a copy per pane. */
export function Switch({ on, busy }: { on: boolean; busy?: boolean }) {
  return (
    <span className="agx-switch" data-on={on ? "" : undefined} style={busy ? { opacity: 0.5 } : undefined}>
      <span className="agx-switch-knob" />
    </span>
  );
}

export function Fold({ label, hint, children, defaultOpen }: {
  /** See SettingRow: a read-out that is not a setting. */
  agentExempt?: boolean;
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const { on, flash } = useContext(Filter);
  const [open, setOpen] = useState(!!defaultOpen || !!flash);
  /*
   * A search result or a deep link inside a closed fold has nothing to land
   * on: the count included it, the highlight and the flash found no row.
   * While a filter is on the fold is open, and a pending flash opens it for
   * good. The ceiling: it cannot tell WHICH fold holds the row (the children
   * are not rendered while closed), so a pending flash opens every fold on
   * the page it lands on.
   */
  useLayoutEffect(() => { if (flash) setOpen(true); }, [flash]);
  const shown = open || on || !!flash;
  return (
    <>
      <SettingRow
        onClick={() => setOpen((v) => !v)}
        label={<span className="flex items-baseline gap-2">
          <span className="inline-block w-2.5 shrink-0 text-[10px]" style={{ color: "var(--text4)" }} aria-hidden>
            {shown ? "▾" : "▸"}
          </span>
          {label}
        </span>}
        hint={hint === undefined ? undefined : <span className="block pl-[18px]">{hint}</span>}
      />
      {shown && (
        /*
         * Flush with the rows above and below it, and with a gap of its own
         * under the header.
         *
         * It used to be `pb-3` with an 18px left margin: padding on one side
         * only, and an indent on one side only. Measured on the Agents pane,
         * that left the open body with an 18px gutter on its left and 0 on its
         * right — a block visibly shoved right inside a card whose every other
         * row is flush — and pressed against the header, which on the plugin
         * declaration (a stack of cards rather than a sentence) read as one
         * more card jammed under the title.
         *
         * The indent was there to line the body up with the label rather than
         * the caret. That reads as an outline when the content is a sentence
         * continuing the label, and as a mistake when it is anything with a
         * border, which is most of what folds hold here.
         */
        <div className="pt-1.5 pb-3 text-[12px] leading-relaxed agx-fold-body" style={{ color: "var(--text2)" }}>
          {children}
        </div>
      )}
    </>
  );
}

export function Toggle({ on, onClick, label, hint, disabled, modified, settingId, detail }: {
  on: boolean; onClick: () => void; label: string; hint: string;
  /** The longer words behind a "Details" link under the row; the hint stays one line. */
  detail?: RowDetail;
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean; agentNever?: string;
  /** Differs from the shipped default: SettingRow draws the dot. */
  modified?: boolean;
  /** A host that cannot do this at all — the row stays, greyed, saying why in
   *  its hint, because a switch that vanishes reads as a feature you imagined. */
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} hint={hint} onClick={onClick} disabled={disabled} modified={modified} settingId={settingId} detail={detail}
      role="switch" ariaChecked={on}
      /* A real switch: position carries the state, so it reads at a glance
         instead of having to be parsed. */
      control={<Switch on={on} />} />
  );
}

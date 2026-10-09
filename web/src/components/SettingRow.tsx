/*
 * The one row every settings page is made of.
 *
 * Lifted out of SettingsModal so the pages that live in their own files —
 * the agents list, remote access — are built from the same thing as the ones
 * that do not. When it was private to the modal, "use the primitive" meant
 * "move your page into a 2,700-line file", so nobody did, and twelve pages
 * grew their own idea of what a row looks like.
 */
import { createContext, isValidElement, useContext, useId, useLayoutEffect, useState } from "react";
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

/** A hint longer than this is one line and a More control. Twelve words is what
 *  fits a 760px column at 12px without wrapping; measured on the Terminal page,
 *  where the long hints were the reason two rows sat at four times the height
 *  of their neighbours. */
export const HINT_FOLD_WORDS = 12;

export function hintNeedsFold(text: string): boolean {
  const t = text.trim();
  return t !== "" && t.split(/\s+/).length > HINT_FOLD_WORDS;
}

/*
 * The More/Less control after a folded hint.
 *
 * A real <button>, and never inside the row's own button or link: a control
 * nested in a `role="switch"` is presentational to assistive tech (its name
 * is flattened into the switch's and it is never exposed as a button), and
 * axe fails it as nested-interactive. So an operable row draws it as a
 * sibling under the row (see SettingRow); a plain row draws it inline.
 * `controls` names the hint it opens.
 */
function HintMore({ open, toggle, controls, className }: { open: boolean; toggle: () => void; controls: string; className?: string }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={controls}
      onClick={toggle}
      className={`text-[12px] t-dim underline cursor-pointer ${className ?? ""}`}>
      {open ? "Less" : "More"}
    </button>
  );
}

export function SettingRow({ label, hint, control, onClick, href, download, disabled, role, ariaChecked, align, modified, settingId }: {
  /** The SettingDef this row binds to (web/src/lib/settingsRegistry.ts), written
   *  BEFORE `label` so the settings index generator reads it with the row. Also
   *  `agentExempt`, a row that is not a setting, which is read from source only. */
  settingId?: string;
  agentExempt?: boolean;
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
  /** Differs from the shipped default: a dot before the label. */
  modified?: boolean;
}) {
  const { on, q, seen } = useContext(Filter);
  const [hintOpen, setHintOpen] = useState(false);
  const hintId = useId();
  // Counted on every render, filtering or not: the count is what decides
  // whether filtering is worth doing at all on this page.
  const matched = !q || rowMatches(textOf(label) + " " + textOf(hint), q);
  seen(matched);
  if (on && !matched) return null;
  const fold = hintNeedsFold(textOf(hint));
  const operable = !!(onClick || href);
  // Under the row, not inside it: see HintMore. Pulled up into the row's own
  // bottom padding so the pair still reads as one row.
  const more = fold && operable ? (
    <div className="px-4 -mt-2.5 pb-3">
      <HintMore open={hintOpen} toggle={() => setHintOpen((v) => !v)} controls={hintId} />
    </div>
  ) : null;

  const body = (
    <>
      <span className="min-w-0">
        <span className="block text-[13.5px]" style={{ color: "var(--text)" }}>
          {modified && (
            <span role="img" aria-label="Changed from default" title="Changed from default"
              className="inline-block rounded-full mr-2 align-middle"
              style={{ width: 6, height: 6, background: "var(--success)" }} />
          )}
          {label}
        </span>
        {/* mt-1, not mt-0.5. A 2px gap under 13.5px type is not a gap — the
            sweep found this pair "touching" on every settings pane there is,
            which is the single most repeated instance of the complaint that
            started this: things that belong together drawn as one block of
            text. 4px is the step for "these two are one thought". */}
        {hint !== undefined && hint !== "" && (
          <span className="block text-[12px] t-dim mt-1">
            {/* The words stay in the DOM when folded, so search still finds them. */}
            {fold ? <span id={hintId} className={hintOpen ? undefined : "agx-settings-hint-clamp"}>{hint}</span> : hint}
            {fold && !operable && <HintMore open={hintOpen} toggle={() => setHintOpen((v) => !v)} controls={hintId} className="ml-1.5" />}
          </span>
        )}
      </span>
      {control !== undefined && <span className="min-w-0">{control}</span>}
    </>
  );
  const cls = `agx-settings-row${align === "start" ? " items-start" : ""}${onClick || href ? " agx-hover" : ""}`;
  const style: React.CSSProperties | undefined = disabled ? { opacity: 0.55 } : undefined;
  // The row's own anchor. openSettings(pane, row) and the command palette
  // both scroll to and flash `[data-row=…]` after the page mounts — derived
  // from the label text so it can never fall out of sync with what the row
  // is now called.
  const dataRow = rowId(textOf(label));
  if (href) return <><a href={href} download={download} className={cls} style={style} data-row={dataRow}>{body}</a>{more}</>;
  const dataSetting = settingId ? { "data-setting-id": settingId } : undefined;
  if (onClick) {
    return (
      <>
        <button onClick={onClick} disabled={disabled} role={role} aria-checked={ariaChecked}
          className={`${cls} text-left disabled:cursor-not-allowed`} style={style} data-row={dataRow} {...dataSetting}>{body}</button>
        {more}
      </>
    );
  }
  return <div className={cls} style={style} data-row={dataRow} {...dataSetting}>{body}</div>;
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
/** The on/off pill every toggle row draws. The track is a bare `<span>`,
 *  which defaults to `display: inline` — an inline element ignores its own
 *  `width`/`height`, so without `inline-block` the 34×19 track collapses to
 *  the size of its content (nothing, since the knob is `position: absolute`
 *  and out of flow) and only the 15px knob paints. That read as a plain dot
 *  rather than a switch, which is the whole reason this is a named export
 *  instead of a copy pasted per pane. */
export function Switch({ on, busy }: { on: boolean; busy?: boolean }) {
  return (
    <span className="inline-block shrink-0 relative rounded-full transition-colors" style={{
      width: 34, height: 19, opacity: busy ? 0.5 : 1,
      background: on ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
    }}>
      <span className="absolute rounded-full transition-transform" style={{
        width: 15, height: 15, top: 2, left: 2,
        transform: on ? "translateX(15px)" : "translateX(0)",
        background: on ? "var(--primary-hover)" : "var(--text3)",
      }} />
    </span>
  );
}

export function Fold({ label, hint, children, defaultOpen }: {
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
        <div className="pt-1.5 pb-3 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>
          {children}
        </div>
      )}
    </>
  );
}

export function Toggle({ on, onClick, label, hint, disabled, modified, settingId }: {
  on: boolean; onClick: () => void; label: string; hint: string;
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean;
  /** Differs from the shipped default: SettingRow draws the dot. */
  modified?: boolean;
  /** A host that cannot do this at all — the row stays, greyed, saying why in
   *  its hint, because a switch that vanishes reads as a feature you imagined. */
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} hint={hint} onClick={onClick} disabled={disabled} modified={modified} settingId={settingId}
      role="switch" ariaChecked={on}
      /* A real switch: position carries the state, so it reads at a glance
         instead of having to be parsed. */
      control={<Switch on={on} />} />
  );
}

/*
 * The blocks a settings page is built from, beside SettingRow.
 *
 * One card per group, a header that carries the group's status and its one
 * action, a row whose status and actions always sit in the same column, a
 * form of stacked labelled fields, and a disclosure named for what it holds.
 * The rules they encode, and how a page moves onto them, are in
 * docs/design-system.md under "Settings pages".
 *
 * Why new class names (`agx-scard*`) rather than the old `agx-settings-section`
 * and `agx-settings-rows`: the old box draws a border-top on every sibling of
 * every wrapper (`* + *`), which is where the doubled lines, the line under a
 * heading and the text pressed against a rule came from — measured on every
 * page there is. A card built from these draws exactly one divider, between
 * two rows, and nothing the old rules reach. Pages that have not moved keep
 * the old box until they do.
 */
import { useId, useState, type ReactNode } from "react";
import { CaretIcon, DoneIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import type { SavePhase } from "../lib/settingsStates.ts";
import { ICON } from "../lib/iconSize.ts";
import { Button, CHIP_SURFACE, CHIP_SURFACE_CLS, CTRL_H } from "./workspace/Chrome.tsx";

/**
 * What a card is for. `default` is a group of settings. `decision` is a card
 * that needs the person to decide something (the gate is off, a step is theirs):
 * an amber edge along its top, so a page of cards says which one to read first.
 * `danger` is the separate red-tinted "Danger zone" card: its actions are
 * outline buttons, never filled, and what they do can be undone.
 * `error` is the card whose service failed (Jira's token was refused): the
 * same red tint, but its buttons stay filled, because "Try again" is the way out.
 */
export type CardTone = "default" | "decision" | "danger" | "error";

/**
 * A group of settings: an optional icon chip, a title, one sentence under it,
 * and the rows.
 *
 * `status` is the group's verdict ("2 of 5 connected"), `actions` its one
 * action (Recheck, Add). Both sit at the top right in every state, so a
 * verdict that is still loading does not move the button beside it. The
 * header's line is the first row's divider (see index.css), so a card with no
 * header has no line above its first row.
 *
 * `wide` is for a card that is a list, an editor or a table: it takes the whole
 * width of the page instead of one column of the card flow.
 *
 * It hides itself when a search has filtered away every row in it (see the
 * `:has(> .agx-scard-body:empty)` rule in index.css).
 */
export function SettingsCard({ title, desc, status, actions, children, label, fold, icon, tone = "default", wide }: {
  title?: string;
  desc?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** The card's accessible name when it has no visible title. */
  label?: string;
  /** A card that opens and closes from its header: the whole header is the
   *  target. Status and actions still sit at its right. */
  fold?: { open: boolean; onToggle: (open: boolean) => void };
  /** The mark in the tinted chip before the title: a nav-style icon element. */
  icon?: ReactNode;
  tone?: CardTone;
  wide?: boolean;
}) {
  const id = useId();
  const head = (title || status || actions) ? (
    <>
      <div className="agx-scard-top">
        {fold && (
          <span aria-hidden className="agx-disclosure-caret" style={fold.open ? { transform: "none" } : undefined}>
            <CaretIcon size={ICON.sm} />
          </span>
        )}
        {icon && <span aria-hidden className="agx-scard-ic">{icon}</span>}
        {title && <h3 id={id} className="agx-settings-head-t m-0">{title}</h3>}
        {(status || actions) && (
          <div className="agx-slot">{status}{actions}</div>
        )}
      </div>
      {desc && <div className="agx-scard-desc">{desc}</div>}
    </>
  ) : null;
  const name = {
    "aria-labelledby": title ? id : undefined, "aria-label": title ? undefined : label,
    "data-tone": tone === "default" ? undefined : tone,
    className: wide ? "agx-scard agx-scard-wide" : "agx-scard",
  };
  if (fold) {
    return (
      <section {...name}>
        <details open={fold.open} onToggle={(e) => fold.onToggle((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="agx-scard-head agx-fold list-none">{head}</summary>
          <div className="agx-scard-body">{children}</div>
        </details>
      </section>
    );
  }
  return (
    <section {...name}>
      {head && <div className="agx-scard-head">{head}</div>}
      <div className="agx-scard-body">{children}</div>
    </section>
  );
}

/**
 * The segmented control: an inset track with the chosen option raised on the
 * page's ground. For a short, exclusive choice that belongs in a row's control
 * column: Window's display size, a 12h/24h clock, a preset. `label` names the
 * question for a screen reader. Not a tab bar: it swaps a value, not a panel.
 */
export function SegControl<T extends string>({ value, options, onPick, label, disabled }: {
  value: T | undefined;
  options: readonly { v: T; label: ReactNode }[];
  onPick: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="agx-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onPick(o.v)} disabled={disabled}
          aria-pressed={value === o.v} className="agx-seg-b disabled:cursor-not-allowed">
          {o.label}
        </button>
      ))}
    </span>
  );
}

/**
 * The verdict on one thing, as a chip: a dot and a few words. One family for a
 * row, a card header and the page header alike.
 *
 *   ok        connected, ready: a filled dot, success ink
 *   warn      the person is needed: warning ink. Only then: "not connected"
 *             on something optional is `off`, not a warning
 *   err       broken: error ink
 *   info      worth knowing, nothing to do: info ink
 *   off       not connected, not installed: a hollow dot, neutral
 *   checking  no answer yet: neutral, and says so
 *   saving    a write is out: info, with a spinner where the dot is
 *
 * Text is always the `--*-ink` of its hue, never the bare hue: the bare
 * warning yellow measured about 1.6:1 on the light card. The look is in
 * index.css (`.agx-badge`), drawn from the theme's own tokens.
 */
export type StatusTone = "ok" | "warn" | "err" | "info" | "off" | "checking" | "saving";

/**
 * The bar at the foot of a card whose edits are held until Save: what state the
 * draft is in on the left, Cancel and Save on the right. It sits inside the card
 * body as a band of its own (not a row), so the divider logic ignores it.
 */
export function SaveBar({ dirty, canSave = true, busy, onSave, onCancel, note, saveLabel = "Save", extra }: {
  dirty: boolean; canSave?: boolean; busy?: boolean; onSave: () => void; onCancel: () => void;
  saveLabel?: string;
  /** Something that is not part of the draft, kept in the band (a reset). */
  extra?: ReactNode;
  /** What to say when there is nothing to save (the last result). */
  note?: ReactNode;
}) {
  // Nothing to save and nothing else to offer: no band (it draws when there is a draft).
  if (!dirty && !extra) return null;
  return (
    <div className="agx-savebar" data-dirty={dirty ? "" : undefined}>
      {dirty || note
        ? <span className="agx-savebar-state" role="status"><i aria-hidden />{dirty ? "Not saved yet" : note}</span>
        : <span />}
      <span className="flex items-center gap-2">
        {extra}
        {dirty && <Button disabled={busy} onClick={onCancel}>Cancel</Button>}
        {(dirty || !extra) && <Button tone="primary" disabled={busy || !dirty || !canSave} onClick={onSave}>{saveLabel}</Button>}
      </span>
    </div>
  );
}

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  // The spinner is the house `.agx-spin`; it breathes instead of turning under reduced motion.
  return tone === "saving"
    ? <span className="agx-badge" data-tone="info"><span className="agx-spin" aria-hidden />{children}</span>
    : <span className="agx-badge" data-tone={tone}><i aria-hidden />{children}</span>;
}

/**
 * What a write says about itself, for a card header or a row: "Saving" while it
 * is out, "Saved" for a moment after, nothing otherwise. Polite, so a screen
 * reader hears that a write happened without being pulled off what it is on.
 */
export function SaveChip({ phase }: { phase: SavePhase }) {
  return (
    <span role="status" aria-live="polite" className="agx-save">
      {phase === "saving" && <StatusBadge tone="saving">Saving</StatusBadge>}
      {phase === "saved" && <StatusBadge tone="ok">Saved</StatusBadge>}
    </span>
  );
}

/**
 * A service that did not answer, said where the cards would be: what failed in
 * one bold line, why under it, and the way out at the end. Red ground, so it
 * is the first thing read on the page; the same words are in the page header's
 * chip and behind the nav's red dot, which the page reports (SettingsPageState).
 */
export function ProblemNote({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="agx-settings-row agx-problem" role="alert">
      <span aria-hidden className="agx-problem-ic"><WarningIcon size={ICON.md} /></span>
      <div className="agx-problem-b">
        <b>{title}</b>
        {children && <span>{children}</span>}
      </div>
      {action && <div className="agx-slot">{action}</div>}
    </div>
  );
}

/**
 * Secondary detail, behind a summary that says what it holds — "Where the
 * token is stored", never "More" or "About this one". A reader decides from
 * the summary whether to open it; a vague one makes them open all of them.
 */
export function Disclosure({ summary, children, defaultOpen, wide }: {
  summary: string; children: ReactNode; defaultOpen?: boolean;
  /** Full width of the row, for a body that is structure rather than a paragraph. */
  wide?: boolean;
}) {
  return (
    <details className="agx-disclosure" open={defaultOpen}>
      <summary className="agx-disclosure-s">
        <span aria-hidden className="agx-disclosure-caret"><CaretIcon size={ICON.xs} /></span>
        {summary}
      </summary>
      <div className={wide ? "agx-disclosure-b agx-wide" : "agx-disclosure-b"}>{children}</div>
    </details>
  );
}

/**
 * A stacked form: one labelled field under the next, at most 480px wide, the
 * submit at the end. Enter in any field submits, which is what a form does;
 * the submit handler decides whether the form is ready.
 */
export function SettingsForm({ onSubmit, children, label }: {
  onSubmit: () => void; children: ReactNode; label: string;
}) {
  return (
    <form className="agx-sform" aria-label={label} noValidate
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {children}
    </form>
  );
}

/**
 * One field: its label above, the control, then one line that answers "what
 * do I put here". `link` is the "How to get one ↗" that belongs to this field,
 * on the label's line. `error` replaces nothing — it is added under the help
 * and announced.
 */
export function Field({ label, help, link, error, children, htmlFor }: {
  label: string;
  help?: ReactNode;
  link?: { href: string; text: string };
  error?: string | null;
  /** The control. It must carry `id={htmlFor}` so the label names it. */
  children: ReactNode;
  htmlFor: string;
}) {
  const helpId = `${htmlFor}-help`;
  return (
    <div className="agx-field">
      <div className="agx-field-top">
        <label htmlFor={htmlFor} className="agx-field-l">{label}</label>
        {link && (
          <a href={link.href} target="_blank" rel="noreferrer" className="agx-field-link">{link.text} ↗</a>
        )}
      </div>
      {children}
      {help && <div id={helpId} className="agx-field-h">{help}</div>}
      {error && <div role="alert" className="agx-field-e">{error}</div>}
    </div>
  );
}

/** The id `Field` gives its help line, for the control's `aria-describedby`. */
export const helpIdFor = (htmlFor: string) => `${htmlFor}-help`;

/**
 * A card with nothing in it yet: one sentence saying what will be here and
 * how it gets here. The action that fills it lives in the card's header, not
 * in here, so it is in the same place once the card has rows.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="agx-settings-row agx-empty">{children}</div>;
}

/**
 * A link that leaves the app, drawn as a plain `Button`: the same height,
 * edge and fill, so a row's one action looks the same whether it runs here
 * or opens a page. The arrow says it opens elsewhere.
 */
export function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener"
      className={`agx-btn ${CHIP_SURFACE_CLS} inline-flex items-center justify-center rounded-lg whitespace-nowrap leading-none text-[11px] px-2.5`}
      style={{ height: CTRL_H.regular, ...CHIP_SURFACE, fontWeight: 500 }}>
      {children} ↗
    </a>
  );
}

/** A Select wide enough for its longest option: the default trigger caps at
 *  160px, which cut "Auto (bundled first)" mid-word. Its look, in a settings
 *  page, is `.agx-settings-col .agx-select` in index.css: the page's own ground
 *  and an edge, at the large control height, the same for every select there. */
export const SELECT_BOX = { maxWidth: 260 } as const;

/** The class of a Select that fills a form field's width (an editor's Group, Model, Skill): the themed
 *  kit select, never a native one, whose list and arrow the OS draws. */
export const FIELD_SELECT = "agx-select w-full justify-between rounded-lg outline-none";



/**
 * A command to run, with the one button that copies it whole: never retyped
 * from a screenshot of a terminal. It sits under a row's description, drawn as
 * an inset line (a fill, no border) so a row does not hold a box.
 */
export function CommandLine({ command, shown }: { command: string; /** What is drawn, when the copied text is longer (an address without its scheme). */ shown?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(command)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => { /* no clipboard permission: the command is on screen anyway */ });
  };
  return (
    <div className="flex items-start gap-2 min-w-0">
      <code className="t-mono text-[11.5px] min-w-0 flex-1 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-all"
        style={{ color: "var(--text)", background: "var(--surface-inset)" }}>{shown ?? command}</code>
      <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

/**
 * One fact about a thing, as a line: a mark that says how it stands (a tick, a
 * warning, a dash), the name of the fact, and its value at the right. The rows
 * of a tool or service tile, where "Installed", "Account" and "Checked" are what
 * the person scans for; a sentence is a SettingRow, not this. The mark is the
 * tone and nothing else: ok is a tick, warn and err a warning, off a dash.
 */
export function CheckRow({ tone, label, value }: { tone: "ok" | "warn" | "err" | "off"; label: ReactNode; value?: ReactNode }) {
  return (
    <div className="agx-chk" data-tone={tone}>
      <span aria-hidden className="agx-chk-m">{tone === "ok" ? <DoneIcon size={ICON.sm} /> : tone === "off" ? "–" : <WarningIcon size={ICON.sm} />}</span>
      <span className="agx-chk-l">{label}</span>
      {value !== undefined && value !== "" && <span className="agx-chk-v">{value}</span>}
    </div>
  );
}

/**
 * A link that saves a file, drawn as a plain `Button`: the same height, edge and fill. It does not
 * open anything or leave the app, so it has no arrow and no new tab: the browser downloads it.
 */
export function DownloadButton({ href, download, children }: { href: string; download: string; children: ReactNode }) {
  return (
    <a href={href} download={download}
      className={`agx-btn ${CHIP_SURFACE_CLS} inline-flex items-center justify-center rounded-lg whitespace-nowrap leading-none text-[11px] px-2.5`}
      style={{ height: CTRL_H.regular, ...CHIP_SURFACE, fontWeight: 500 }}>
      {children}
    </a>
  );
}

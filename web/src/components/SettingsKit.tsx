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
import { CaretIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { Button, CHIP_SURFACE, CHIP_SURFACE_CLS, CTRL_H } from "./workspace/Chrome.tsx";

/**
 * A group of settings: a title, one sentence under it, and the rows.
 *
 * `status` is the group's verdict ("2 of 5 connected"), `actions` its one
 * action (Recheck, Add). Both sit at the top right in every state, so a
 * verdict that is still loading does not move the button beside it. There is
 * no line under the header: the space is the break.
 *
 * It hides itself when a search has filtered away every row in it (see the
 * `:has(> .agx-scard-body:empty)` rule in index.css).
 */
export function SettingsCard({ title, desc, status, actions, children, label, fold }: {
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
}) {
  const id = useId();
  const head = (title || status || actions) ? (
    <>
      <div className="min-w-0 flex items-start gap-2">
        {fold && (
          <span aria-hidden className="agx-disclosure-caret mt-0.5" style={fold.open ? { transform: "none" } : undefined}>
            <CaretIcon size={ICON.sm} />
          </span>
        )}
        <div className="min-w-0">
          {title && <h3 id={id} className="agx-settings-head-t m-0">{title}</h3>}
          {desc && <div className="agx-scard-desc">{desc}</div>}
        </div>
      </div>
      {(status || actions) && (
        <div className="agx-slot">{status}{actions}</div>
      )}
    </>
  ) : null;
  const name = { "aria-labelledby": title ? id : undefined, "aria-label": title ? undefined : label };
  if (fold) {
    return (
      <section className="agx-scard" {...name}>
        <details open={fold.open} onToggle={(e) => fold.onToggle((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="agx-scard-head agx-fold list-none">{head}</summary>
          <div className="agx-scard-body">{children}</div>
        </details>
      </section>
    );
  }
  return (
    <section className="agx-scard" {...name}>
      {head && <div className="agx-scard-head">{head}</div>}
      <div className="agx-scard-body">{children}</div>
    </section>
  );
}

/**
 * The verdict on one thing: a dot and a few words, at the compact height.
 *
 *   ok        connected, ready — a filled dot in success ink
 *   warn      the person is needed — warning ink. Only then: "not connected"
 *             on something optional is `off`, not a warning
 *   err       broken — error ink
 *   off       not connected, not installed — a hollow dot, neutral
 *   checking  no answer yet — neutral, and says so
 *
 * Text is always the `--*-ink` of its hue, never the bare hue: the bare
 * warning yellow measured about 1.6:1 on the light card.
 */
export type StatusTone = "ok" | "warn" | "err" | "off" | "checking";

const TONE_HUE: Record<StatusTone, string | null> = {
  ok: "var(--success)", warn: "var(--warning)", err: "var(--error)", off: null, checking: null,
};
const TONE_INK: Record<StatusTone, string> = {
  ok: "var(--success-ink)", warn: "var(--warning-ink)", err: "var(--error-ink)", off: "var(--text3)", checking: "var(--text3)",
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const hue = TONE_HUE[tone];
  const ink = TONE_INK[tone];
  const hollow = !hue;
  return (
    <span className="agx-badge inline-flex items-center gap-1.5 whitespace-nowrap rounded-full text-[11px] px-2.5"
      data-tone={tone}
      style={{
        height: CTRL_H.compact, color: ink,
        background: hue ? `color-mix(in srgb, ${hue} 12%, transparent)` : "transparent",
        boxShadow: `inset 0 0 0 1px ${hue ? `color-mix(in srgb, ${hue} 40%, transparent)` : "var(--surface-line)"}`,
      }}>
      <span aria-hidden className="inline-block rounded-full shrink-0" style={{
        width: 6, height: 6,
        background: hollow ? "transparent" : ink,
        boxShadow: hollow ? `inset 0 0 0 1px ${ink}` : undefined,
      }} />
      {children}
    </span>
  );
}

/**
 * Secondary detail, behind a summary that says what it holds — "Where the
 * token is stored", never "More" or "About this one". A reader decides from
 * the summary whether to open it; a vague one makes them open all of them.
 */
export function Disclosure({ summary, children, defaultOpen }: {
  summary: string; children: ReactNode; defaultOpen?: boolean;
}) {
  return (
    <details className="agx-disclosure" open={defaultOpen}>
      <summary className="agx-disclosure-s">
        <span aria-hidden className="agx-disclosure-caret"><CaretIcon size={ICON.xs} /></span>
        {summary}
      </summary>
      <div className="agx-disclosure-b">{children}</div>
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

/** A Select drawn at the house control height with the chip edge, and wide
 *  enough for its longest option: the default trigger is borderless and caps at
 *  160px, which cut "Auto (bundled first)" mid-word. */
export const SELECT_BOX = { height: CTRL_H.regular, maxWidth: 260, ...CHIP_SURFACE } as const;



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

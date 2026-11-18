/*
 * What a board draws when it has no cards to draw: the skeleton while the first
 * read is on its way, the block that says why there is nothing (empty, filtered
 * out, or the tracker would not answer), and the note strip over a board whose
 * rows are old. Both trackers' boards and card panes use these three, so a state
 * looks the same wherever it turns up and carries the same two buttons.
 */
import { useEffect, useState, type ReactNode } from "react";
import { openSettings } from "../../lib/openSettings.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";

/** How long a read runs before the skeleton offers Cancel. */
export const STILL_READING_MS = 8000;
const BAR_WIDTHS = [80, 60, 72, 50, 66, 58];
/** The bars of a card pane that is being read: fewer, with no dot, since a card has no rows. */
export const CARD_BARS = [70, 55, 80, 40, 65];

/** Bars where the rows will be, and one line that says what is being read. */
export function BoardSkeleton({ label, widths = BAR_WIDTHS, dots = true, lead = 8, onCancel }: {
  label: string; widths?: readonly number[]; dots?: boolean;
  /** Past 8 s the block adds "Still reading… Cancel" when the read can be stopped. */
  onCancel?: () => void;
  /** The lead's size: 8 is a dot (a card), 16 is a checkbox (a task). */
  lead?: number;
}) {
  /* Loading, the pattern: shapes only after 150 ms, so a read that lands at once draws nothing. */
  const [seen, setSeen] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSeen(true), 150); return () => clearTimeout(id); }, []);
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), STILL_READING_MS); return () => clearTimeout(id); }, []);
  return (
    <div className="flex flex-col" style={{ padding: "16px 14px", gap: 16, visibility: seen ? "visible" : "hidden" }} role="status" aria-live="polite">
      {widths.map((w, i) => (
        <div key={i} className="flex items-center" style={{ gap: 12 }} aria-hidden>
          {dots && <div className="agx-skeleton shrink-0" style={{ width: lead, height: lead, borderRadius: lead > 8 ? 5 : 999 }} />}
          <div className="agx-skeleton" style={{ width: `${w}%`, height: 12, borderRadius: 6 }} />
        </div>
      ))}
      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{label}</div>
      {slow && onCancel && (
        <div className="flex items-center gap-2 text-[10.5px]" style={{ color: "var(--text3)" }} data-state="still-reading">
          Still reading…<StateButton onClick={onCancel}>Cancel</StateButton>
        </div>
      )}
    </div>
  );
}

/** A centred block: a 44px tile with an icon, a title, one line of body and the buttons that go with it. */
export function BoardEmpty({ tone = "quiet", icon, title, body, children }: {
  tone?: "quiet" | "error"; icon: ReactNode; title: string; body?: ReactNode; children?: ReactNode;
}) {
  const err = tone === "error";
  return (
    <div className="flex flex-col items-center justify-center text-center" style={{ gap: 8, padding: "40px 20px", minHeight: 200, color: "var(--text3)" }}
      role={err ? "alert" : "status"}>
      <div className="grid place-items-center" aria-hidden style={{
        width: 44, height: 44, borderRadius: 12,
        background: err ? "color-mix(in srgb, var(--error) 12%, transparent)" : "color-mix(in srgb, var(--text) 6%, transparent)",
        color: err ? "var(--error-ink)" : "var(--text3)",
      }}>{icon}</div>
      <b className="text-[12.5px]" style={{ color: "var(--text)" }}>{title}</b>
      {body && <span className="text-[11.5px] max-w-[46ch]">{body}</span>}
      {children && <span className="flex flex-wrap justify-center" style={{ gap: 6 }}>{children}</span>}
    </div>
  );
}

/** One of the block's buttons: 28px, the primary one filled. */
export function StateButton({ onClick, primary, children, href, title }: {
  onClick?: () => void; primary?: boolean; children: ReactNode; href?: string; title?: string;
}) {
  const cls = "agx-btn inline-flex items-center rounded-lg text-[11px] px-2.5 gap-1.5 no-underline";
  const style = primary
    ? { height: CTRL_H.regular, background: "var(--primary)", color: "var(--on-primary, var(--bg))" }
    : { height: CTRL_H.regular, border: EDGE, color: "var(--text2)" };
  return href
    ? <a href={href} target="_blank" rel="noreferrer noopener" className={cls} style={style} title={title}>{children}</a>
    : <button onClick={onClick} className={cls} style={style} title={title}>{children}</button>;
}

/** The strip over the rows: a warning for rows that are old, an error for a tracker that did not answer. */
export function BoardNote({ tone, children, action }: { tone: "warn" | "err"; children: ReactNode; action?: ReactNode }) {
  const c = tone === "warn" ? "warning" : "error";
  return (
    <div className="flex items-center gap-2 text-[11.5px] shrink-0" role="status"
      style={{ margin: "0 14px 8px", padding: "6px 12px", borderRadius: 8, color: `var(--${c}-ink)`, background: `color-mix(in srgb, var(--${c}) 10%, transparent)` }}>
      <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" />
      </svg>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export const InboxIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 13l2.6-7.2A2 2 0 0 1 7.5 4.5h9a2 2 0 0 1 1.9 1.3L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 13h5l1.5 2.5h5L16 13h5" />
  </svg>
);
export const SearchOffIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
export const WarnIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3.5 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17.5v.01" />
  </svg>
);

/* The five state patterns beyond the three above (docs/design-system.md, "States"). */

/** Empty, collapses: a field, section or list the person cannot fill from here draws nothing. One name so a screen says so. */
export function StateCollapse(_: { when?: boolean }): null { return null; }

/** Several empty sections as one quiet line, with the one Add that fills them. */
export function StateFold({ line, adds }: { line: string; adds?: ReadonlyArray<{ label: string; run: () => void }> }) {
  const [more, setMore] = useState(false);
  if (!line) return null;
  const btn = "agx-btn shrink-0 rounded-md px-1.5 py-0.5";
  return (
    <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[11px] min-w-0" style={{ color: "var(--text4)" }} data-state="fold">
      <span className="min-w-0 truncate">{line}</span>
      {adds && adds.length > 0 && <span aria-hidden>·</span>}
      {adds && adds.length > 0 && <button type="button" className={btn} style={{ color: "var(--text2)" }} aria-expanded={more} onClick={() => setMore((m) => !m)}>+ Add</button>}
      {more && adds?.map((a) => <button key={a.label} type="button" className={btn} style={{ color: "var(--text2)" }} onClick={() => { setMore(false); a.run(); }}>{a.label}</button>)}
    </div>
  );
}

/** Error: what failed, the cause in one plain line, Try again, and where to change it. */
export function StateError({ title, cause, onRetry, where, retryLabel = "Try again", children }: { title: string; cause?: string | undefined; onRetry?: () => void; where?: ReactNode; retryLabel?: string; children?: ReactNode }) {
  /* Where to change it is always said: the caller's own line, or the Settings button. */
  return (
    <BoardEmpty tone="error" icon={<WarnIcon />} title={title} body={<>{cause}{where ? <> {where}</> : null}</>}>
      {onRetry && <StateButton primary onClick={onRetry}>{retryLabel}</StateButton>}
      {!where && <StateButton onClick={() => openSettings()}>Open settings</StateButton>}
      {children}
    </BoardEmpty>
  );
}

/** Disconnected: a page state that names the service and why, the one button that connects, and the cached rows below, dimmed, with their age. */
export function StateDisconnected({ service, why, onConnect, onSettings, age, children, connectLabel = "Reconnect", actions }: {
  service: string; why: string; onConnect: () => void; onSettings?: () => void; /** Already a phrase: "12m ago". */ age?: string; children?: ReactNode; connectLabel?: string; actions?: ReactNode;
}) {
  return (
    <>
      <BoardEmpty tone="error" icon={<WarnIcon />} title={`${service} is not connected`} body={age ? `${why} Your last read, ${age}, is shown below.` : why}>
        <StateButton primary onClick={onConnect}>{connectLabel}</StateButton>
        {onSettings && <StateButton onClick={onSettings}>Open settings</StateButton>}
        {actions}
      </BoardEmpty>
      {children && <div style={{ opacity: 0.55 }} aria-label={`Cached from ${service}`}>{children}</div>}
    </>
  );
}

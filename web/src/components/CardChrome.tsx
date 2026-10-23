/*
 * The pieces of a card pane that do not belong to one tracker: the action bar,
 * the chip row, a title with its copy button, the tab strip and a labelled
 * field. The ClickUp card (TasksPanel.tsx) draws the same things inline; these
 * take only plain props, so a tracker whose card behaves differently fills them
 * with its own data and leaves out what it cannot honour.
 * Ceiling: the ClickUp card does not use these yet (its source tests read the
 * inline markup), so a change to the look is made in both places.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CopyIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { externalUrl } from "../lib/externalUrl.ts";
import { EDGE, LINE, RefreshButton } from "./workspace/Chrome.tsx";

export const EYEBROW = "text-[8.5px] uppercase tracking-[0.18em]";
const ID_CHIP = "text-[10px] px-1.5 py-0.5 rounded-md leading-[1.35] whitespace-nowrap";
const BAR_BTN = "text-[10.5px] px-2.5 min-h-[28px] inline-flex items-center rounded-lg";

export type Copied = "id" | "url" | "title";

/** Writes to the clipboard and remembers for a moment what was written, so its button can say so. */
export function useCopied(): [Copied | null, (value: string, which: Copied) => Promise<void>] {
  const [copied, setCopied] = useState<Copied | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (value: string, which: Copied) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1200);
    } catch { /* no clipboard */ }
  }, []);
  return [copied, copy];
}

const Done = () => <span className="inline-flex items-center gap-1">copied<DoneIcon size={ICON.xs} /></span>;

/**
 * Above the card: what you reach for after reading it. The hand-off sits first on the left (a tracker that
 * may not write passes nothing), then the two copies; Open and Refresh share the far right corner.
 */
export function CardActionBar({ id, url, handoff, copied, onCopy, onRefresh, refreshing }: {
  id: string; url: string; handoff?: ReactNode;
  copied: Copied | null; onCopy: (value: string, which: Copied) => void;
  onRefresh: () => void; refreshing: boolean;
}) {
  const open = externalUrl(url);
  return (
    <div className="flex items-center gap-1.5 flex-wrap pb-1.5" style={{ borderBottom: LINE }} role="toolbar" aria-label="Card actions">
      {handoff}
      <button onClick={() => onCopy(id, "id")} className={BAR_BTN} style={{ border: LINE, color: "var(--text2)" }}>
        {copied === "id" ? <Done /> : `Copy ${id.replace(/-\d+$/, "") === id ? "id" : `${id.replace(/-\d+$/, "")} id`}`}
      </button>
      {url && (
        <button onClick={() => onCopy(url, "url")} className={BAR_BTN} style={{ border: LINE, color: "var(--text2)" }} title={url}>
          {copied === "url" ? <Done /> : "Copy URL"}
        </button>
      )}
      <span className="flex-1" />
      {open && <a href={open} target="_blank" rel="noreferrer" className={BAR_BTN} style={{ border: LINE, color: "var(--text2)" }}>Open ↗</a>}
      <RefreshButton onRefresh={onRefresh} busy={refreshing} title="Read this card again" />
    </div>
  );
}

/** The key as a chip that copies itself, and the badge for a card that is yours. */
export function CardChips({ id, copied, onCopy, mine, extra }: {
  id: string; copied: Copied | null; onCopy: (value: string, which: Copied) => void; mine?: boolean; extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button onClick={() => onCopy(id, "id")} className={`${ID_CHIP} tabular-nums`}
        style={{ color: "var(--primary-ink)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
        title={`Copy ${id}: the id for a branch, a commit or a colleague`}>
        {copied === "id" ? <Done /> : id}
      </button>
      {extra}
      {mine && (
        <span className={`${ID_CHIP} tracking-[0.08em]`}
          style={{ color: "var(--success-ink)", background: "color-mix(in srgb, var(--success) 15%, transparent)" }}>YOURS</span>
      )}
    </div>
  );
}

/** The title, with the button that copies it after its last word, so it follows the wrap. */
export function CardTitle({ title, copied, onCopy }: { title: string; copied: Copied | null; onCopy: (value: string, which: Copied) => void }) {
  return (
    <h2 className="text-[13px] font-semibold leading-snug" style={{ color: "var(--text)", textWrap: "balance" }}>
      {title}
      <button onClick={() => onCopy(title, "title")}
        className="inline-flex items-center justify-center align-middle ml-1.5 rounded hover:bg-white/10"
        style={{ width: 20, height: 20, color: copied === "title" ? "var(--success)" : "var(--text4)" }}
        title="Copy the title" aria-label={copied === "title" ? "Title copied" : "Copy the title"}>
        {copied === "title" ? <DoneIcon size={ICON.sm} /> : <CopyIcon size={ICON.sm} />}
      </button>
    </h2>
  );
}

/** A strip of tabs: a lit pill and an underline for the one you are on, a count where there is something to count, and no rule above or below. */
export function CardTabs<Id extends string>({ tabs, active, onPick }: {
  tabs: readonly { id: Id; label: string; count?: number }[]; active: Id; onPick: (id: Id) => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="tablist" aria-label="Card sections">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} aria-current={active === t.id ? "page" : undefined} onClick={() => onPick(t.id)}
          className="agx-btn text-[10px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-t-md"
          style={{
            color: active === t.id ? "var(--text)" : "var(--text3)",
            background: active === t.id ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
            borderBottom: `2px solid ${active === t.id ? "var(--primary)" : "transparent"}`,
          }}>
          {t.label}{t.count ? ` ${t.count}` : ""}
        </button>
      ))}
    </div>
  );
}

/** A label above its value: in a narrow pane the other shape leaves the value a few words. */
export function CardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={`${EYEBROW} mb-1.5 truncate`} style={{ color: "var(--text4)" }} title={label}>{label}</div>
      <div className="text-[11.5px] leading-normal break-words">{children}</div>
    </div>
  );
}

/** The framed band of what is read at a glance: each child is a `CardBandField`. */
export function CardBand({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-wrap items-start"
      style={{ gap: "14px 20px", background: "color-mix(in srgb, var(--text) 4%, transparent)", border: EDGE }}>
      {children}
    </div>
  );
}

export function CardBandField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0" style={{ maxWidth: 210 }}>
      <span className={`${EYEBROW} truncate`} style={{ color: "var(--text4)" }} title={label}>{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

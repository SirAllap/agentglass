/*
 * The line a card pane opens with while the board is read-only: what is wrong
 * and the one button that turns it off. Both trackers' panes draw this one, so
 * the sentence and the button sit in the same place on either.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { LockIcon } from "../../lib/glyphIcons.tsx";
import { tipAttr } from "../../lib/tip.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";

/** `flush` leaves the space under it to the column it sits in (the Jira dock spaces its blocks with a gap). */
export function ReadOnlyNote({ onAllow, title, flush }: { onAllow: () => void; title?: string; flush?: boolean }) {
  return (
    <div className={`${flush ? "" : "mb-3 "}flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11.5px]`} {...(flush ? { "data-tip": title ? tipAttr(title) : undefined } : { title })}
      style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--info, var(--primary)) 10%, transparent)" }}>
      <LockIcon size={ICON.sm} />
      <span className="flex-1">This board is read-only.</span>
      <button onClick={onAllow} className="agx-btn text-[10.5px] px-2 rounded-lg" style={{ border: EDGE, height: CTRL_H.compact }}>Allow changes</button>
    </div>
  );
}

/**
 * A row whose control a read-only board has disabled: the lock says so, the
 * sentence says what to do, and the WHOLE row is the way to do it. A disabled
 * button takes no click, so asking lives on the wrapper; the control inside
 * stays disabled until the grant arrives.
 */
export function ReadOnlyRow({ locked, onAllow, className, children }: { locked: boolean; onAllow?: () => void; className?: string; children: ReactNode }) {
  if (!locked) return <>{children}</>;
  return (
    <div onClick={onAllow} title={READ_ONLY_TIP} className={`relative min-w-0 ${onAllow ? "cursor-pointer" : ""} ${className ?? ""}`}
      {...(onAllow ? { role: "button", tabIndex: 0, onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAllow(); } } } : null)}>
      {/* Mouse-inert: a disabled control swallows the click, and the row is what asks. */}
      <div className="pointer-events-none">{children}</div>
      <span aria-hidden className="absolute top-0 right-0 flex" style={{ color: "var(--text4)" }}><LockIcon size={ICON.xs} /></span>
    </div>
  );
}
export const READ_ONLY_TIP = "Read-only board. Turn changes on to edit";

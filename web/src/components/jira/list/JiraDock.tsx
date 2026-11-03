import { useEffect, type MouseEvent } from "react";
import type { BoardSource } from "../../../lib/boardSource.ts";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { JiraCard } from "../JiraCard.tsx";
import { JiraHead } from "../JiraFacts.tsx";
import { LINE } from "../../workspace/Chrome.tsx";
import { useCardMode } from "../../../lib/jiraCardMode.ts";
import { useModalDialog } from "../../../lib/focusTrap.ts";

/**
 * Slot: the card dock, 620 wide. Empty it says so; with a card it is the Jira card drawn straight into the dock.
 * With the "over the list" choice (`jiraCardMode`) the same card is drawn as a dialog over the list instead, and
 * with no card there is nothing to draw.
 */
export interface JiraDockProps {
  source: BoardSource;
  card: ProviderTask | null;
  writable: boolean;
  /** A write changed the card: what the site now says. */
  onTask: (t: ProviderTask) => void;
  onClose: () => void;
  onAllow: () => void;
  /** A right-click on a sub-task row, for the list's own menu. */
  onSubtaskMenu?: (e: MouseEvent, sub: ProviderTask) => void;
}

export const DOCK_W = 620;

/** Esc closes the card, unless it is leaving a field, a menu or a dialog that already took the key. */
export function escCloses(e: Pick<KeyboardEvent, "key" | "defaultPrevented" | "target">): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return false;
  /* The over-the-list card is itself a dialog (data-slot="dock"); Esc inside it is the card's own. */
  return !(el && el.closest?.('[role="dialog"]:not([data-slot="dock"]),[role="menu"],[role="listbox"]'));
}

export function JiraDock(props: JiraDockProps) {
  return <DockLayout {...props} over={useCardMode() === "modal"} />;
}

/** The layout apart from where the choice is stored, so a test can ask for either (the server render always says "side"). */
export function DockLayout({ card, writable, onTask, onClose, onAllow, onSubtaskMenu, over }: JiraDockProps & { over: boolean }) {
  const open = !!card;
  const dialog = useModalDialog(open && over, card?.title ?? "Card");
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => { if (escCloses(e)) onClose(); };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [open, onClose]);
  const content = card && (
    <div className="flex-1 min-h-0 overflow-hidden text-[11.5px] flex flex-col">
      <JiraCard key={card.id} t={card} writes={writable} onTask={onTask} onAllow={onAllow} onSubtaskMenu={onSubtaskMenu}
        header={(r) => <JiraHead t={card} writable={writable} onTask={r.onTask} onRefresh={r.onRefresh} refreshing={r.refreshing} ed={r.ed} follow={r.follow} onClose={onClose} />} />
    </div>
  );
  if (over) {
    if (!content) return null;
    /* Over the whole list pane (the root is `relative`), not over the table inside it, so the toolbar is dimmed too. */
    return (
      <div className="absolute inset-0 z-30 flex items-stretch justify-center p-2" data-testid="jira-card-over"
        style={{ background: "color-mix(in srgb, var(--bg) 62%, transparent)" }} onClick={onClose}>
        <aside data-slot="dock" {...dialog} onClick={(e) => e.stopPropagation()} className="flex flex-col min-h-0 rounded-xl overflow-hidden outline-none"
          style={{ width: "min(1100px, 100%)", background: "var(--bg)", border: LINE, boxShadow: "0 18px 50px color-mix(in srgb, var(--shadow) 55%, transparent)" }}>
          {content}
        </aside>
      </div>
    );
  }
  return (
    <aside data-slot="dock" className="flex flex-col min-w-0 min-h-0 shrink-0"
      style={{ width: DOCK_W, maxWidth: "55%", borderLeft: LINE, background: "var(--bg)" }}>
      {content || <div className="m-auto text-[12px]" style={{ color: "var(--text3)" }}>Select a card</div>}
    </aside>
  );
}

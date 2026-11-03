/*
 * The menus of the Local and GitHub sources: the filter drops under the bar, the
 * "other ways to start" list, the row context menus and the terminal menu.
 *
 * One look for all of them: a row is 28px, a hint sits under its label, a check
 * marks the current choice, and a destructive row is red. They open on the same
 * `ContextMenu` the ClickUp board uses, so Escape, a click outside and a window
 * edge behave as they do there.
 *
 * Ceiling: no arrow-key walk through the rows; a menu is a pointer thing here and
 * every action in one also has a key on the board.
 */
import { useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "../ContextMenu.tsx";
import { CaretIcon, DoneIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { LINE } from "../workspace/Chrome.tsx";

export function TaskMenuItem({ label, hint, kbd, checked, disabled, danger, onClick }: {
  label: ReactNode; hint?: string; kbd?: string; checked?: boolean; disabled?: boolean; danger?: boolean; onClick: () => void;
}) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled}
      className="agx-btn flex items-center gap-2 px-2 rounded-md text-left text-[12px] disabled:opacity-45"
      style={{ minHeight: 28, color: danger ? "var(--error-ink)" : "var(--text)", cursor: disabled ? "not-allowed" : undefined }}>
      <span className="min-w-0 flex-1 flex flex-col" style={{ paddingBlock: hint ? 3 : 0 }}>
        <span className="truncate">{label}</span>
        {hint && <span className="text-[10.5px] leading-snug" style={{ color: "var(--text3)" }}>{hint}</span>}
      </span>
      {kbd && <kbd className="text-[10.5px]" style={{ color: "var(--text3)" }}>{kbd}</kbd>}
      {checked && <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><DoneIcon size={ICON.xs} /></span>}
    </button>
  );
}

export const MenuSep = () => <div role="separator" style={{ borderTop: LINE, margin: "4px 2px" }} />;

/** A menu that opens under the element it was asked from. */
export function useMenuAt() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = (el: Element) => { const r = el.getBoundingClientRect(); setAt({ x: r.left, y: r.bottom + 4 }); };
  return { at, open, close: () => setAt(null) };
}

/** A chip with a caret that opens a menu: Priority, Project, Tag and Sort under the bar. */
export function ChipMenu({ label, value, disabled, width = 200, children }: {
  label: string;
  /** What is chosen, shown after the label; null for nothing chosen. */
  value: string | null;
  disabled?: boolean;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const { at, open, close } = useMenuAt();
  const btn = useRef<HTMLButtonElement>(null);
  const on = value !== null;
  return (
    <>
      <button ref={btn} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={!!at}
        onClick={(e) => open(e.currentTarget)}
        className="agx-chip text-[11px] px-2.5 min-h-[28px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap disabled:opacity-45"
        style={{
          border: on ? "1px solid color-mix(in srgb, var(--primary) 34%, transparent)" : "1px solid color-mix(in srgb, var(--text) 14%, transparent)",
          background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : undefined,
          color: on ? "var(--primary-ink)" : "var(--text2)",
          cursor: disabled ? "not-allowed" : undefined,
        }}>
        {label}{on && <>: <b style={{ fontWeight: 600 }}>{value}</b></>}
        <CaretIcon size={ICON.xs} />
      </button>
      {at && <ContextMenu x={at.x} y={at.y} onClose={close} width={width}>{children(close)}</ContextMenu>}
    </>
  );
}

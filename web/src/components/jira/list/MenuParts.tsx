/* The rows the toolbar's small menus (Status, Group, Then) are made of: one 28 high row, one eyebrow, one rule. */
import type { ReactNode } from "react";
import { DoneIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { LINE } from "../../workspace/Chrome.tsx";

export function MenuRowBtn({ on, danger, onClick, lead, count, label, children }: {
  on?: boolean; danger?: boolean; onClick: () => void; lead?: ReactNode; count?: number; label: string; children: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" aria-label={on ? `${label}, selected` : label} onClick={onClick}
      className="agx-chip flex items-center text-left min-w-0"
      style={{ height: 28, gap: 8, padding: "0 8px", borderRadius: 8, fontSize: 12, background: "transparent", color: danger ? "var(--error-ink)" : on ? "var(--text)" : "var(--text2)", fontWeight: on ? 600 : 400 }}>
      {lead}
      <span className="truncate min-w-0">{children}</span>
      {on && <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><DoneIcon size={ICON.xs} /></span>}
      {count != null && <span className="ml-auto shrink-0 tabular-nums" style={{ fontSize: 10.5, fontWeight: 400, color: "var(--text4)" }}>{count}</span>}
    </button>
  );
}

export const MenuHead = ({ children }: { children: ReactNode }) => (
  <div className="uppercase" style={{ padding: "8px 8px 4px", fontSize: 10.5, letterSpacing: ".04em", color: "var(--text4)" }}>{children}</div>
);

export const MenuRule = () => <div role="separator" style={{ borderTop: LINE, margin: "4px 2px" }} />;

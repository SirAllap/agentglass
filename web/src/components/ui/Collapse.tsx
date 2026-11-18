import type { ReactNode } from "react";
/*
 * House component for the states pattern. Branch states1 adds the shared rule in
 * web/src/lib/stateRule.ts and the Jira screens: at merge those screens should
 * import this one rather than keep a copy.
 */

/**
 * Fields that are not set fold into ONE line: "Not set: labels, assignees" with a
 * quiet "+ Add" for each. A field with a value draws itself; this draws the rest.
 */
export function Collapse({ items }: { items: { key: string; label: string; onAdd: (e: React.MouseEvent<HTMLButtonElement>) => void }[] }): ReactNode {
  if (!items.length) return null;
  return (
    <div data-collapse className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10.5px]" style={{ color: "var(--text3)" }}>
      <span>Not set:</span>
      {items.map((i) => (
        <button key={i.key} type="button" onClick={i.onAdd} aria-label={`Add ${i.label}`}
          className="agx-btn rounded px-1 hover:bg-white/5" style={{ color: "var(--text2)" }}>+ {i.label}</button>
      ))}
    </div>
  );
}

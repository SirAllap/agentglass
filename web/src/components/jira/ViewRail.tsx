/*
 * The Jira tab's left rail: the built-in list, saved views, and projects with
 * their boards. One stop in the Tab order; the arrow keys move inside it
 * (lib/railTree.ts decides where a key goes).
 */
import { useRef, useState } from "react";
import { RAIL_W_MIN, railKey } from "../../lib/railTree.ts";
import { viewKindLabel, type RailEntry } from "../../lib/jiraViews.ts";
import { ICON } from "../../lib/iconSize.ts";
import { IconButton, LINE } from "../workspace/Chrome.tsx";

export function ViewRail({ entries, current, adding, onPick, onToggle, onRemove, onAdd }: {
  entries: RailEntry[];
  current: string;
  adding: boolean;
  onPick: (id: string) => void;
  onToggle: (id: string) => void;
  onRemove: (e: RailEntry) => void;
  onAdd: () => void;
}) {
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const focusRow = (i: number) => { setAt(i); box.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus(); };
  const use = (e: RailEntry) => (e.kind === "folder" ? onToggle(e.id) : onPick(e.id));

  const onKey = (ev: React.KeyboardEvent, i: number) => {
    if (ev.target !== ev.currentTarget) return; // the remove button keeps its own keys
    const m = railKey(entries, i, ev.key);
    if (!m) return;
    ev.preventDefault();
    if (m.kind === "focus") focusRow(m.index);
    else use(entries[m.index]);
  };

  return (
    <div className="flex flex-col shrink-0 min-h-0" style={{ width: RAIL_W_MIN, borderRight: LINE }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: LINE }}>
        <span className="flex-1 text-[11px]" style={{ color: "var(--text2)" }}>Views</span>
        <IconButton onClick={onAdd} title="Add a board, a filter or a project" on={adding} expanded={adding}>
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M6 2.5 V9.5 M2.5 6 H9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>
      <div ref={box} role="tree" aria-label="Jira views" className="flex-1 min-h-0 overflow-y-auto agx-scroll py-1">
        {entries.map((e, i) => {
          const on = e.kind === "view" && e.id === current;
          return (
            <div key={`${e.kind}:${e.id}`} role="treeitem" aria-level={e.level + 1}
              aria-selected={e.kind === "view" ? on : undefined}
              aria-expanded={e.kind === "folder" ? !!e.expanded : undefined}
              data-i={i} tabIndex={i === at ? 0 : -1}
              title={e.kind === "folder" ? "Project" : viewKindLabel(e.id)}
              onClick={() => { setAt(i); use(e); }}
              onFocus={(ev) => { if (ev.target === ev.currentTarget) setAt(i); }}
              onKeyDown={(ev) => onKey(ev, i)}
              className="agx-row group flex items-center gap-1.5 pr-1.5 py-1.5 cursor-pointer hover:bg-white/5"
              style={{
                paddingLeft: 12 + e.level * 14,
                background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : undefined,
                boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
              }}>
              {e.kind === "folder" && (
                <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0"
                  style={{ transform: e.expanded ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }}>
                  <path d="M4 2.5 L8.5 6 L4 9.5" stroke="var(--text2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <span className="flex-1 min-w-0 truncate text-[11.5px]"
                style={{ color: on ? "var(--text)" : "var(--text2)", fontWeight: e.kind === "folder" ? 500 : 400 }}>{e.name}</span>
              {!e.builtin && e.level === 0 && (
                <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100" onClick={(ev) => ev.stopPropagation()}>
                  <IconButton onClick={() => onRemove(e)} title={`Remove ${e.name}`}>
                    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden>
                      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </IconButton>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

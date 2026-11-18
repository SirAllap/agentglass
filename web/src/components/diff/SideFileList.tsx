/*
 * The file list of the Diff in the terminal side panel. That surface exists to
 * watch what THIS tab's agent is changing, so it is a plain list: a folder as a
 * thin muted line, then one line per file (letter, name, +N −N). No read state,
 * no pills, no times. The newest change is first and carries a dot for a minute.
 * The full Diff page keeps its own, richer rows.
 */

import { Fragment } from "react";
import type { ChangeRow } from "../../../../shared/types.ts";
import type { RowGroup } from "../../lib/changeRows.ts";
import { tipAttr } from "../../lib/tip.ts";

const LETTER: Record<ChangeRow["status"], { c: string; ch: string }> = {
  added: { c: "var(--success)", ch: "A" },
  untracked: { c: "var(--success)", ch: "A" },
  modified: { c: "var(--info)", ch: "M" },
  deleted: { c: "var(--error)", ch: "D" },
  renamed: { c: "var(--warning)", ch: "R" },
  typechange: { c: "var(--warning)", ch: "T" },
};

/** Changed in the last minute: the file the agent is working on right now. */
export const JUST_NOW_MS = 60_000;

export const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** Middle-truncate a long folder path: the two ends say which tree and which leaf. */
export const midTrunc = (p: string, max = 34): string =>
  p.length <= max ? p : `${p.slice(0, Math.ceil((max - 1) / 2))}…${p.slice(p.length - Math.floor((max - 1) / 2))}`;

/** Newest change first, so the file being edited now is the top row. */
export const newestFirst = (rows: readonly ChangeRow[]): ChangeRow[] =>
  [...rows].sort((a, b) => b.changedAt - a.changedAt);

export function SideFileList({ groups, selKey, onSelect, now = Date.now() }: {
  groups: RowGroup[]; selKey: string | null; onSelect: (key: string) => void; now?: number;
}) {
  return (
    <div className="agx-scroll flex-1 min-h-0 overflow-y-auto pb-2" data-side-list>
      {groups.flatMap((g) => newestFirst(g.rows)).map((r, i, all) => {
        const dir = dirOf(r.path);
        const name = r.path.slice(r.path.lastIndexOf("/") + 1);
        const s = LETTER[r.status];
        const on = r.key === selKey;
        const fresh = !!r.changedAt && now - r.changedAt < JUST_NOW_MS;
        return (
          <Fragment key={r.key}>
            {dir && dir !== dirOf(all[i - 1]?.path ?? "") && (
              <div className="truncate text-[10px] px-1 py-0.5 pl-3" style={{ color: "var(--text3)" }}
                data-tip={tipAttr({ name: dir })}>{midTrunc(dir)}</div>
            )}
            <div data-sel={on ? "1" : undefined} role="button" tabIndex={-1} onClick={() => onSelect(r.key)}
              data-tip={tipAttr({ name: r.path })}
              className="w-full flex items-center gap-1 pl-3 pr-1.5 py-0.5 cursor-default agx-hover"
              style={{
                background: on ? "color-mix(in srgb, var(--primary) 9%, var(--bg))" : undefined,
                boxShadow: on ? "inset 2px 0 0 var(--primary)" : undefined,
              }}>
              <span className="shrink-0 text-center leading-none font-semibold" style={{ width: 12, fontSize: 10, color: s.c }}>{s.ch}</span>
              <span className="truncate min-w-0 text-[10.5px]"
                style={{ color: "var(--text2)", textDecoration: r.status === "deleted" ? "line-through" : undefined }}>{name}</span>
              {fresh && <span aria-label="changed just now" data-just-now className="shrink-0 rounded-full"
                style={{ width: 5, height: 5, background: "var(--primary)" }} />}
              <span className="ml-auto pl-1 text-[10px] shrink-0 tabular-nums">
                <span style={{ color: "var(--success-ink)" }}>+{r.additions}</span>
                {r.deletions > 0 && <span style={{ color: "var(--error-ink)" }}> −{r.deletions}</span>}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

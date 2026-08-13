/*
 * The git view's lists, rewritten.
 *
 * Eight sections — branches, remotes, tags, stashes, worktrees, submodules,
 * reflog, log — used to be eight layouts. Each had grown its own grid, its own
 * type sizes, its own chip colours and its own row of buttons, tuned in place
 * until they no longer agreed with each other; in Remotes the tracks added up
 * to more than the pane and the buttons landed on the branch name.
 *
 * This file is the answer to that: one list, parameterised. A section says what
 * its columns are, what each row's chips say, and which catalogue kind it is —
 * and gets the same grid, the same density, the same hover, the same right-
 * click and the same reserved action column as the other seven. Adding a
 * section is describing it, not drawing it.
 *
 * The data still comes from the endpoints the panel already used. What is gone
 * is the drawing, not the plumbing.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import type {
  GitBranch, GitTag, GitStash, GitWorktree, GitRemote, GitRemoteBranch,
  GitSubmodule, GitReflogEntry,
} from "../../../../shared/types.ts";
import { Row, Subject, Meta, Chip, RowAction, GroupHead, Empty, type Tone } from "./ui.tsx";
import { primaryAction, groupByPrefix, type GitKind, type GitRowState } from "../../lib/gitActions.ts";

/** What every row hands the list: how to draw it and what it can do. */
export interface ListRow {
  key: string;
  /** The catalogue kind, which decides the menu and the primary action. */
  kind: GitKind;
  /** The name the catalogue and the menu use. */
  name: string;
  state: GitRowState;
  /** What is drawn, left to right, before the reserved action column. */
  cells: ReactNode[];
  /** Dispatcher for this row's actions — the same one the palette uses. */
  run: (id: string) => void;
  /** Rows that are the current branch / checkout read differently. */
  tone?: "current" | "muted";
}

export function List({ rows, cols, cursor, onCursor, onMenu, busy, what, group, disabled }: {
  rows: ListRow[];
  /** Grid tracks WITHOUT the action column — the list appends that itself. */
  cols: string;
  cursor: number;
  onCursor: (i: number) => void;
  onMenu: (row: ListRow, x: number, y: number) => void;
  busy?: boolean;
  what: string;
  /** Fold rows into prefix families. Only branches ask for this. */
  group?: boolean;
  /** Read-only repository: the primary action is not drawn at all. */
  disabled?: boolean;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const groups = useMemo(
    () => (group ? groupByPrefix(rows, (r) => r.name) : [{ prefix: "", rows }]),
    [group, rows],
  );

  if (!rows.length) return <Empty what={what} busy={busy} />;

  return (
    <div className="px-2 pb-3">
      {groups.map((g) => (
        <Fragment key={g.prefix || "(no prefix)"}>
          {group && groups.length > 1 && (
            <GroupHead
              label={g.prefix ? `${g.prefix}/` : "no prefix"}
              count={g.rows.length}
              folded={folded.has(g.prefix)}
              onToggle={() => setFolded((prev) => {
                const next = new Set(prev);
                next.has(g.prefix) ? next.delete(g.prefix) : next.add(g.prefix);
                return next;
              })}
            />
          )}
          {!folded.has(g.prefix) && g.rows.map((r) => {
            const i = rows.indexOf(r);
            const primary = disabled ? null : primaryAction(r.kind, r.name, r.state);
            return (
              <Row key={r.key} cols={cols} selected={i === cursor} tone={r.tone}
                onClick={() => onCursor(i)}
                onContextMenu={(e) => { e.preventDefault(); onCursor(i); onMenu(r, e.clientX, e.clientY); }}>
                {r.cells}
                {primary
                  ? <RowAction label={primary.label} danger={primary.danger}
                      onClick={() => r.run(primary.id)}
                      title={`${primary.label} — right-click for everything else`} />
                  : <span />}
              </Row>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- the sections --
//
// Each of these turns one payload into ListRows. They are the only place that
// knows what a tag is as opposed to a stash, and none of them decides anything
// about spacing, colour or size.

export const BRANCH_COLS = "16px minmax(0, 22rem) auto minmax(0, 1fr) 5.5rem";

export function branchRows(
  branches: GitBranch[],
  ctx: {
    current: string;
    worktreeOf: (name: string) => GitWorktree | undefined;
    root: string;
    picked: Set<string>;
    onPick: (name: string) => void;
    run: (id: string, b: GitBranch) => void;
    track: (raw: string) => { ahead: number; behind: number; gone: boolean };
  },
): ListRow[] {
  return branches.map((b) => {
    const t = ctx.track(b.track);
    const wt = ctx.worktreeOf(b.name);
    const elsewhere = !!wt && wt.path !== ctx.root;
    const isCurrent = b.name === ctx.current;
    const state: GitRowState = {
      current: isCurrent, gone: t.gone, ahead: t.ahead, behind: t.behind,
      upstream: !!b.upstream, elsewhere, merged: b.mergedIntoTrunk === true,
    };
    return {
      key: b.name, kind: "branch", name: b.name, state,
      tone: isCurrent ? "current" : undefined,
      run: (id) => ctx.run(id, b),
      cells: [
        <span key="tick" className="text-center text-[11px]" style={{ color: "var(--primary)" }}>
          {isCurrent && !ctx.picked.size ? "⎇" : (
            <span onClick={(e) => { e.stopPropagation(); ctx.onPick(b.name); }}
              className={`cursor-pointer ${ctx.picked.size ? "" : "opacity-0 group-hover:opacity-100"} transition-opacity`}
              style={{ color: ctx.picked.has(b.name) ? "var(--primary)" : "var(--text3)" }}>
              {ctx.picked.has(b.name) ? "☑" : "☐"}
            </span>
          )}
        </span>,
        <Subject key="name" title={b.name}>{b.name}</Subject>,
        <span key="chips" className="flex items-center gap-1 shrink-0">
          {t.gone && <Chip tone="bad" title="its remote branch no longer exists">gone</Chip>}
          {b.mergedIntoTrunk === true && !t.gone && <Chip>merged</Chip>}
          {t.ahead > 0 && <Chip tone="good">↑{t.ahead}</Chip>}
          {t.behind > 0 && <Chip tone="warn">↓{t.behind}</Chip>}
          {elsewhere && <Chip tone="accent" title={wt!.path}>worktree</Chip>}
        </span>,
        <Meta key="subject" title={b.subject}>{b.subject}</Meta>,
        <Meta key="date" align="right">{b.date}</Meta>,
      ],
    };
  });
}

export const TAG_COLS = "minmax(0, 20rem) 5rem minmax(0, 1fr) 5.5rem";

export function tagRows(tags: GitTag[], run: (id: string, t: GitTag) => void): ListRow[] {
  return tags.map((t) => ({
    key: t.name, kind: "tag", name: t.name, state: {},
    run: (id) => run(id, t),
    cells: [
      <Subject key="n" title={t.name}>{t.annotated ? "⚑ " : "· "}{t.name}</Subject>,
      <Meta key="h" mono>{t.hash}</Meta>,
      <Meta key="s" title={t.subject}>{t.subject}</Meta>,
      <Meta key="d" align="right">{t.date}</Meta>,
    ],
  }));
}

export const STASH_COLS = "5.5rem minmax(0, 1fr)";

export function stashRows(stashes: GitStash[], run: (id: string, s: GitStash) => void): ListRow[] {
  return stashes.map((s) => ({
    key: s.ref, kind: "stash", name: s.ref, state: {},
    run: (id) => run(id, s),
    cells: [
      <Meta key="r" mono>{s.ref}</Meta>,
      <Subject key="m" mono={false} title={s.message}>{s.message}</Subject>,
    ],
  }));
}

export const WORKTREE_COLS = "16px minmax(0, 18rem) minmax(0, 16rem) 5rem minmax(0, 1fr)";

export function worktreeRows(
  worktrees: GitWorktree[],
  ctx: { busyPaths?: Set<string>; run: (id: string, w: GitWorktree) => void },
): ListRow[] {
  return worktrees.map((w) => ({
    key: w.path, kind: "worktree", name: w.path,
    state: { current: w.current, busy: ctx.busyPaths?.has(w.path) },
    tone: w.current ? "current" : undefined,
    run: (id) => ctx.run(id, w),
    cells: [
      <span key="i" className="text-center text-[11px]" style={{ color: "var(--primary)" }}>{w.current ? "▸" : ""}</span>,
      <Subject key="p" title={w.path}>{w.path.split("/").pop()}</Subject>,
      <span key="b" className="flex items-center gap-1 min-w-0">
        <Chip tone="accent" title={w.branch}>⎇ {w.branch}</Chip>
        {w.locked && <Chip tone="warn">locked</Chip>}
      </span>,
      <Meta key="h" mono>{w.head}</Meta>,
      <Meta key="d" title={w.path}>{w.path}</Meta>,
    ],
  }));
}

export const REMOTE_BRANCH_COLS = "minmax(0, 24rem) auto minmax(0, 1fr) 5.5rem";

export function remoteBranchRows(
  rows: GitRemoteBranch[],
  ctx: { root: string; run: (id: string, b: GitRemoteBranch) => void },
): ListRow[] {
  return rows.map((b) => ({
    key: b.ref, kind: "remote-branch", name: b.name,
    // `merged` here means "you already have it locally" — see the catalogue.
    state: { merged: !!b.local, elsewhere: !!b.worktree && b.worktree !== ctx.root },
    run: (id) => ctx.run(id, b),
    cells: [
      <Subject key="n" title={b.ref} tint={b.local ? "var(--text)" : "var(--text2)"}>{b.name}</Subject>,
      <span key="c" className="flex items-center gap-1 shrink-0">
        {b.worktree ? <Chip tone="accent" title={b.worktree}>worktree</Chip>
          : b.local ? <Chip tone="good">local</Chip> : null}
      </span>,
      <Meta key="s" title={b.subject}>{b.subject}</Meta>,
      <Meta key="d" align="right">{b.date}</Meta>,
    ],
  }));
}

export const REMOTE_COLS = "minmax(0, 12rem) minmax(0, 1fr)";

export function remoteRows(remotes: GitRemote[], run: (id: string, r: GitRemote) => void): ListRow[] {
  return remotes.map((r) => ({
    key: r.name, kind: "remote", name: r.name, state: {},
    run: (id) => run(id, r),
    cells: [
      <Subject key="n">{r.name}</Subject>,
      <Meta key="u" title={r.fetchUrl}>{r.fetchUrl}</Meta>,
    ],
  }));
}

export const SUBMODULE_COLS = "minmax(0, 20rem) auto 5rem minmax(0, 1fr)";

export function submoduleRows(subs: GitSubmodule[], run: (id: string, s: GitSubmodule) => void): ListRow[] {
  const tone = (status: string): Tone =>
    status === "clean" ? "good" : status === "uninitialized" ? "warn" : "bad";
  return subs.map((s) => ({
    key: s.path, kind: "submodule", name: s.path, state: {},
    run: (id) => run(id, s),
    cells: [
      <Subject key="p" title={s.path}>{s.path}</Subject>,
      <span key="s" className="shrink-0"><Chip tone={tone(s.status)}>{s.status}</Chip></span>,
      <Meta key="h" mono>{s.sha.slice(0, 7)}</Meta>,
      <Meta key="u" title={s.url}>{s.url}</Meta>,
    ],
  }));
}

export const REFLOG_COLS = "5rem 8rem minmax(0, 1fr) 5.5rem";

export function reflogRows(entries: GitReflogEntry[], run: (id: string, e: GitReflogEntry) => void): ListRow[] {
  return entries.map((e, i) => ({
    key: `${e.shortHash}-${i}`, kind: "commit", name: e.shortHash, state: {},
    run: (id) => run(id, e),
    cells: [
      <Meta key="h" mono>{e.shortHash}</Meta>,
      <Meta key="s" mono title={e.ref}>{e.ref}</Meta>,
      <Subject key="m" mono={false} title={`${e.action} — ${e.subject}`}>
        <span style={{ color: "var(--text2)" }}>{e.action}</span>{e.subject ? ` · ${e.subject}` : ""}
      </Subject>,
      <Meta key="d" align="right">{e.date}</Meta>,
    ],
  }));
}

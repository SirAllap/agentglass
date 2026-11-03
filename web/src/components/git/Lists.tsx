/*
 * The git view's lists.
 *
 * Every section used to draw its own table: its own grid, its own type sizes,
 * its own chips, its own row of buttons. They stopped agreeing with each other,
 * and in Remotes they stopped agreeing with the pane — seven tracks plus three
 * buttons added up to more than the width and the actions landed on the name.
 *
 * Now a section says what a row IS — its name, what state it is in, and the
 * handful of facts worth knowing about it — and `ui.tsx` decides how that
 * looks. The rows are cards with a status rail and two lines, not table rows;
 * the point of that is a thirty-branch list you can read without reading, by
 * colour down the left and by one 13px name per card.
 *
 * The data still comes from the endpoints the panel always used. This file
 * replaced the drawing, not the plumbing.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { layoutGraph, type GraphRow } from "../../lib/gitGraph.ts";
import { MiniGraph } from "./MiniGraph.tsx";
import { CommitAvatar } from "./CommitAvatar.tsx";
import { RefChips } from "./RefChips.tsx";
import { shortAgo } from "../../lib/gitLogView.ts";
import type {
  GitBranch, GitTag, GitStash, GitWorktree, GitRemote, GitRemoteBranch,
  GitSubmodule, GitReflogEntry,
} from "../../../../shared/types.ts";
import { Row, Chip, RowAction, GroupHead, Empty, TickBox, Tile, Drift, wash, INSPECTOR_RULE, type Tone } from "./ui.tsx";
import { branchDrift, type BranchSection } from "../../lib/gitBranchList.ts";
import { primaryAction, actionsFor, grouped, type GitKind, type GitRowState } from "../../lib/gitActions.ts";
import { BranchIcon, DoneIcon, FolderIcon, PinIcon, IconLabel } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";

export interface ListRow {
  key: string;
  kind: GitKind;
  name: string;
  state: GitRowState;
  /** The colour of the rail: what this row's state IS, at a glance. */
  rail?: Tone;
  /** Status words. Coloured; everything else on the card is not. */
  chips?: ReactNode;
  /** The second line, joined with dots. Order matters: most-asked first. */
  facts?: ReactNode[];
  /** The branch you are on, the checkout you are in. */
  current?: boolean;
  run: (id: string) => void;
  /** Drawn instead of the name when a row wants more than a string. */
  title?: ReactNode;
  /** Drawn outside the card, full height — the commit graph. */
  gutter?: ReactNode | ((cursor: boolean) => ReactNode);
  /** `line` for the log: see `Row`. */
  variant?: "card" | "line" | "item";
  /** The log: the commit is in the pick set, and its number in graph order. */
  picked?: boolean;
  pickMark?: number;
  /** `item` rows: the leading tick and tile, the right-edge arrows, and a step back for finished ones. */
  lead?: ReactNode;
  trail?: ReactNode;
  dim?: boolean;
}

export function List({ rows, cursor, onCursor, onMenu, busy, what, sections, aboveList, disabled, measure, inspector, flush }: {
  rows: ListRow[];
  cursor: number;
  onCursor: (i: number) => void;
  onMenu: (row: ListRow, x: number, y: number) => void;
  busy?: boolean;
  what: string;
  /**
   * Contiguous runs of `rows`, in order, each under its own heading. A foldable
   * one can be shut; the one holding the cursor opens by itself, so the
   * keyboard never lands on a row nobody can see.
   */
  sections?: BranchSection[];
  /** Drawn at the top of the scrolling list, above the first heading (a notice). */
  aboveList?: ReactNode;
  disabled?: boolean;
  /**
   * How wide the list is allowed to be.
   *
   * 860 is a reading measure for a card, which is a name and a sentence. The log
   * is neither: it is one line per commit whose whole content is a subject, and
   * at 860 a merge commit's subject was cut mid-branch-name — "from
   * acme/ORBIT-1042-cove…" — with 700px of window sitting empty beside it.
   */
  measure?: number;
  /**
   * Log and Reflog: the picked row's inspector takes the right-hand side, and
   * the row carries no button of its own. What can be done lives in the dock
   * under the list; the row's right-click menu stays.
   */
  inspector?: (index: number) => ReactNode;
  /** The log: the list takes the width the inspector leaves, edge to edge, instead of a centred reading measure. */
  flush?: boolean;
}) {
  // Sections the person toggled away from how they start.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const plan = useMemo(() => {
    let at = 0;
    return (sections ?? [{ id: "", label: "", foldable: false, startsFolded: false, size: rows.length } as BranchSection]).map((s) => {
      const part = { s, from: at, to: at + s.size };
      at += s.size;
      return part;
    });
  }, [sections, rows.length]);
  const folded = (id: string, startsFolded: boolean, holdsCursor: boolean) => startsFolded !== flipped.has(id) && !holdsCursor;

  if (!rows.length) return <Empty what={what} busy={busy} />;

  const active = rows[Math.min(cursor, rows.length - 1)];

  return (
    // Centred as a pair rather than pinned left: on a 2000px window the list
    // plus its detail come to ~1300, and letting the remaining 700 sit on one
    // side is what made the old view feel like a form in the corner of a page.
    <div className={`flex-1 min-h-0 flex w-full ${flush ? "" : "mx-auto"}`} style={flush ? undefined : { maxWidth: 1480 }}>
      {/* The list keeps a reading measure — a card is a name and a sentence,
          and a 1900px sentence is not read, it is scanned past — and the width
          left over goes to the detail pane rather than to blank card. */}
      <div className={flush ? "agx-scroll flex-1 min-w-0 overflow-y-auto p-2 flex flex-col gap-0.5" : "agx-scroll flex-1 min-w-0 overflow-y-auto px-3 pb-4"}
        style={flush ? { borderRight: INSPECTOR_RULE } : { maxWidth: measure ?? 860 }}>
      {aboveList}
      {plan.map(({ s: sec, from, to }) => {
        const shut = sec.foldable && folded(sec.id, sec.startsFolded, cursor >= from && cursor < to);
        return (
        <Fragment key={sec.id || "(all)"}>
          {sections && (
            <GroupHead
              label={sec.label} raw={sec.raw}
              count={sec.foldable && shut ? undefined : sec.id === "recent" ? sec.size : undefined}
              note={shut ? <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{sec.size} folded</span> : undefined}
              folded={shut}
              onToggle={sec.foldable ? () => setFlipped((prev) => {
                const next = new Set(prev);
                next.has(sec.id) ? next.delete(sec.id) : next.add(sec.id);
                return next;
              }) : undefined}
            />
          )}
          {!shut && rows.slice(from, to).map((r, k) => {
            const i = from + k;
            const primary = disabled || inspector ? null : primaryAction(r.kind, r.name, r.state);
            return (
              <Row key={r.key} rail={r.rail} title={r.title ?? r.name} chips={r.chips} facts={r.facts}
                gutter={r.gutter} variant={r.variant} lead={r.lead} trail={r.trail} dim={r.dim} picked={r.picked} pickMark={r.pickMark}
                selected={i === cursor} current={r.current} title2={r.name}
                onClick={() => onCursor(i)}
                onContextMenu={(e) => { e.preventDefault(); onCursor(i); onMenu(r, e.clientX, e.clientY); }}
                action={primary
                  ? <RowAction label={primary.label} danger={primary.danger}
                      onClick={() => r.run(primary.id)}
                      title={`${primary.label} — right-click for everything else`} />
                  : undefined}
              />
            );
          })}
        </Fragment>
        );
      })}
      </div>
      {/*
        The right half, which is where all that empty space was going.

        A list of thirty branches was drawn at 1900px for content that fits in
        700, so every card was a mostly-blank strip and its action sat a screen
        away from its name. The list is capped now, and what the width buys is a
        detail pane: the selected row's facts as a readable stack, and its FULL
        action set as named buttons — the same catalogue the right-click shows,
        because there is finally room to show it without hiding it.
      */}
      {active && (inspector ? inspector(Math.min(cursor, rows.length - 1)) : <Detail row={active} disabled={disabled} />)}
    </div>
  );
}

function Detail({ row, disabled }: { row: ListRow; disabled?: boolean }) {
  const groups = grouped(actionsFor(row.kind, row.name, row.state));
  return (
    // A different ground, not just a hairline: the detail is a second surface,
    // and saying so with depth means the eye stops treating the whole pane as
    // one very wide list.
    <aside className="agx-scroll hidden lg:flex flex-col gap-4 flex-1 min-w-0 max-w-[28rem] overflow-y-auto px-5 py-4"
      style={{ borderLeft: INSPECTOR_RULE, background: wash("--bg2", 40) }}>
      <div>
        <div className="text-[10px] uppercase tracking-[0.11em] mb-1" style={{ color: "var(--text3)" }}>{row.kind}</div>
        <div className="text-[15px] font-medium break-all"
          style={{ color: "var(--text)", fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
          {row.name}
        </div>
        {/* `chips-stack`: down here there is room for the whole thing, so the
            chip wraps rather than running off the column — the row's ellipsis
            is a row's compromise and this is not a row. */}
        {!!row.chips && <div className="chips-stack flex flex-wrap items-start gap-1.5 mt-2 min-w-0">{row.chips}</div>}
      </div>

      {!!row.facts?.length && (
        <div className="flex flex-col gap-1.5">
          {row.facts.filter(Boolean).map((f, i) => (
            <div key={i} className="text-[10.5px] leading-relaxed break-words" style={{ color: "var(--text2)" }}>{f}</div>
          ))}
        </div>
      )}

      {!disabled && groups.map((g) => (
        <div key={g[0].group} className="flex flex-col gap-1">
          <div className="text-[9.5px] uppercase tracking-[0.11em]" style={{ color: "var(--text3)" }}>
            {g[0].group === "go" ? "do" : g[0].group}
          </div>
          {g.map((a) => (
            <button key={a.id} onClick={() => row.run(a.id)}
              className="text-left text-[11px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors"
              style={{
                color: a.danger ? "var(--error)" : "var(--text2)",
                background: a.danger ? wash("--error", 7) : wash("--text", 4),
                border: `1px solid ${a.danger ? wash("--error", 22) : wash("--text", 7)}`,
              }}>
              <span className="flex-1 truncate">{a.label}</span>
              {a.shortcut && <span className="text-[9px]" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{a.shortcut}</span>}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

// ------------------------------------------------------------- the sections --

export function branchRows(
  branches: GitBranch[],
  ctx: {
    current: string;
    worktreeOf: (name: string) => GitWorktree | undefined;
    root: string;
    trunk?: string | null;
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
    const merged = b.mergedIntoTrunk === true && !t.gone && !isCurrent;
    const drift = branchDrift(b, ctx.trunk, t);
    // The tile says what the branch IS in one colour: where you are, done with,
    // or ordinary. Chips below say the rest in words.
    const tone = isCurrent ? "var(--primary)" : merged ? "var(--success)" : t.gone ? "var(--error)" : "var(--text3)";
    // The third fact is the one that answers "where": the folder it is held in,
    // what a branch you are on tracks, or whose it is.
    const third = elsewhere ? `../${wt!.path.split("/").pop()}` : isCurrent ? b.upstream ?? undefined : b.author;
    return {
      key: b.name, kind: "branch", name: b.name, state, current: isCurrent, variant: "item" as const, dim: merged,
      run: (id) => ctx.run(id, b),
      lead: (
        <>
          {/* Always drawn, as the mockup does: a bulk action starts from an empty box you can see.
              The branch you are on has none, since it cannot be deleted. */}
          {!isCurrent && (
            <TickBox on={ctx.picked.has(b.name)} onClick={() => ctx.onPick(b.name)}
              title={ctx.picked.has(b.name) ? "Untick" : "Tick for a bulk action"} />
          )}
          <Tile tone={tone}><BranchIcon size={ICON.xs} /></Tile>
        </>
      ),
      trail: <Drift ahead={drift.ahead} behind={drift.behind}
        title={drift.vs === "trunk" ? `${drift.ahead} only here, ${drift.behind} only on ${ctx.trunk ?? "the trunk"}` : `${drift.ahead} to push, ${drift.behind} to pull`} />,
      title: b.name,
      chips: (
        <>
          {isCurrent && <Chip tone="accent"><IconLabel icon={<PinIcon size={ICON.xs} />}>here</IconLabel></Chip>}
          {t.gone && <Chip tone="bad" title="its remote branch no longer exists">gone</Chip>}
          {elsewhere && <Chip title={wt!.path}><IconLabel icon={<FolderIcon size={ICON.xs} />}>in a worktree</IconLabel></Chip>}
          {!b.upstream && <Chip tone="warn">no upstream</Chip>}
          {merged && <Chip tone="good"><IconLabel icon={<DoneIcon size={ICON.xs} />}>merged</IconLabel></Chip>}
        </>
      ),
      facts: [b.subject, b.date, third],
    };
  });
}

export function tagRows(tags: GitTag[], run: (id: string, t: GitTag) => void, extra?: (name: string) => ReactNode): ListRow[] {
  return tags.map((t) => ({
    key: t.name, kind: "tag", name: t.name, state: {}, rail: "neutral",
    run: (id) => run(id, t),
    chips: <>{t.annotated ? <Chip tone="accent">annotated</Chip> : <Chip>lightweight</Chip>}{extra?.(t.name)}</>,
    facts: [t.date, t.hash, t.subject],
  }));
}

export function stashRows(stashes: GitStash[], run: (id: string, s: GitStash) => void): ListRow[] {
  return stashes.map((s) => ({
    key: s.ref, kind: "stash", name: s.ref, state: {}, rail: "warn",
    run: (id) => run(id, s),
    title: s.message,
    facts: [s.ref],
  }));
}

export function worktreeRows(
  worktrees: GitWorktree[],
  ctx: { run: (id: string, w: GitWorktree) => void },
): ListRow[] {
  return worktrees.map((w) => ({
    key: w.path, kind: "worktree", name: w.path,
    state: { current: w.current },
    rail: w.current ? "accent" : w.locked ? "warn" : "neutral",
    current: w.current,
    run: (id) => ctx.run(id, w),
    title: w.path.split("/").pop(),
    chips: (
      <>
        <Chip tone="accent" title={w.branch}><IconLabel icon={<BranchIcon size={ICON.xs} />}>{w.branch}</IconLabel></Chip>
        {w.current && <Chip>you are here</Chip>}
        {w.locked && <Chip tone="warn">locked</Chip>}
      </>
    ),
    facts: [w.head, w.path],
  }));
}

export function remoteBranchRows(
  rows: GitRemoteBranch[],
  ctx: { root: string; run: (id: string, b: GitRemoteBranch) => void },
): ListRow[] {
  return rows.map((b) => ({
    key: b.ref, kind: "remote-branch", name: b.name,
    state: { merged: !!b.local, elsewhere: !!b.worktree && b.worktree !== ctx.root },
    rail: b.worktree ? "accent" : b.local ? "good" : "neutral",
    run: (id) => ctx.run(id, b),
    chips: (
      <>
        {b.worktree ? <Chip tone="accent" title={b.worktree}>in {b.worktree.split("/").pop()}</Chip>
          : b.local ? <Chip tone="good">you have it</Chip> : null}
      </>
    ),
    facts: [b.date, b.hash, b.subject, b.author],
  }));
}

export function remoteRows(remotes: GitRemote[], run: (id: string, r: GitRemote) => void): ListRow[] {
  return remotes.map((r) => ({
    key: r.name, kind: "remote", name: r.name, state: {}, rail: "neutral",
    run: (id) => run(id, r),
    facts: [r.fetchUrl],
  }));
}

export function submoduleRows(subs: GitSubmodule[], run: (id: string, s: GitSubmodule) => void): ListRow[] {
  const tone = (status: string): Tone =>
    status === "clean" ? "good" : status === "uninitialized" ? "warn" : "bad";
  return subs.map((s) => ({
    key: s.path, kind: "submodule", name: s.path, state: {}, rail: tone(s.status),
    run: (id) => run(id, s),
    chips: <Chip tone={tone(s.status)}>{s.status}</Chip>,
    facts: [s.sha.slice(0, 7), s.branch || "no branch", s.url],
  }));
}

export function reflogRows(entries: GitReflogEntry[], run: (id: string, e: GitReflogEntry) => void): ListRow[] {
  return entries.map((e, i) => ({
    key: `${e.shortHash}-${i}`, kind: "commit", name: e.shortHash, state: {}, variant: "line" as const,
    run: (id) => run(id, e),
    title: e.subject || e.action,
    chips: <Chip>{e.action}</Chip>,
    facts: [e.date, e.shortHash, e.ref],
  }));
}

/**
 * The log: not a list of things but a list of moments, and the graph is the
 * shape of how they connect.
 *
 * That graph used to be `git log --graph`'s own ASCII, printed as text. On this
 * repository — twenty-seven live branches — that is forty characters of
 * `| | * | \ \ |` before the subject starts, so every message was cut to
 * `fix(pr-revi…` and the tab looked broken on the way down, which is exactly how
 * it was reported. It is drawn now, from the parents, one lane per branch and a
 * dot per commit; see lib/gitGraph.ts for the bookkeeping.
 */
export function commitRows(
  lines: { hash?: string; graph: string; parents?: string[]; subject?: string; refs?: string; author?: string; date?: string }[],
  ctx: {
    picked: ReadonlySet<string>;
    /** The apply-order number of each picked commit, oldest first. */
    numbers?: ReadonlyMap<string, number> | null;
    run: (id: string, hash: string, subject: string) => void;
    /** Lanes laid out over the WHOLE log, by hash: a search leaves gaps in the
     *  list, and lanes laid out over the gaps would draw a different graph. */
    layout?: ReadonlyMap<string, GraphRow>;
    /** The selected commit a search put back at the top although it does not match. */
    pinned?: string | null;
    /** Remote names, to tell `origin/fix/login` from a local `fix/login`. */
    remotes?: readonly string[];
  },
): ListRow[] {
  const commits = lines.filter((l) => !!l.hash);
  const graph = ctx.layout
    ? commits.map((l) => ctx.layout!.get(l.hash!))
    : layoutGraph(commits.map((l) => ({ hash: l.hash!, parents: l.parents ?? [] })));
  return commits.map((l, i) => ({
    key: `${l.hash}-${i}`, kind: "commit", name: l.hash!, state: { inLog: true },
    variant: "line" as const,
    // The pinned row is out of its place in the history: lanes drawn for it would join its neighbours.
    gutter: (cursor: boolean) => <MiniGraph row={l.hash === ctx.pinned ? undefined : graph[i]} selected={cursor} />,
    picked: ctx.picked.has(l.hash!),
    pickMark: ctx.numbers?.get(l.hash!),
    run: (id) => ctx.run(id, l.hash!, l.subject ?? ""),
    title: <span title={l.subject} style={{ fontFamily: "var(--font-sans)" }}>{l.subject}</span>,
    /* The refs come BEFORE the subject, one chip each, in a cluster capped at 45% of the row
       (`.chip-ref`): this is the one place whose text is a list of branch names, and on a busy
       commit it is longer than the subject it sits beside. */
    chips: (l.refs || l.hash === ctx.pinned || (l.parents?.length ?? 0) > 1) ? (
      <>
        {l.hash === ctx.pinned && <Chip tone="warn">selected, not matching</Chip>}
        <RefChips refs={l.refs} merge={(l.parents?.length ?? 0) > 1} remotes={ctx.remotes} />
      </>
    ) : undefined,
    facts: [
      <CommitAvatar key="by" author={l.author} size={ICON.lg} />,
      <span key="t" title={l.date}>{shortAgo(l.date)}</span>,
      <span key="h" style={{ color: "var(--text4)" }}>{l.hash}</span>,
    ],
  }));
}

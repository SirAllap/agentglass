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
import { LANE_W, graphWidth, laneColour, layoutGraph, type GraphRow } from "../../lib/gitGraph.ts";
import type {
  GitBranch, GitTag, GitStash, GitWorktree, GitRemote, GitRemoteBranch,
  GitSubmodule, GitReflogEntry,
} from "../../../../shared/types.ts";
import { Row, Chip, RowAction, GroupHead, Empty, wash, type Tone } from "./ui.tsx";
import { primaryAction, actionsFor, grouped, groupByPrefix, type GitKind, type GitRowState } from "../../lib/gitActions.ts";

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
}

export function List({ rows, cursor, onCursor, onMenu, busy, what, group, disabled }: {
  rows: ListRow[];
  cursor: number;
  onCursor: (i: number) => void;
  onMenu: (row: ListRow, x: number, y: number) => void;
  busy?: boolean;
  what: string;
  group?: boolean;
  disabled?: boolean;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const groups = useMemo(
    () => (group ? groupByPrefix(rows, (r) => r.name) : [{ prefix: "", rows }]),
    [group, rows],
  );

  if (!rows.length) return <Empty what={what} busy={busy} />;

  const active = rows[Math.min(cursor, rows.length - 1)];

  return (
    // Centred as a pair rather than pinned left: on a 2000px window the list
    // plus its detail come to ~1300, and letting the remaining 700 sit on one
    // side is what made the old view feel like a form in the corner of a page.
    <div className="flex-1 min-h-0 flex w-full mx-auto" style={{ maxWidth: 1480 }}>
      {/* The list keeps a reading measure — a card is a name and a sentence,
          and a 1900px sentence is not read, it is scanned past — and the width
          left over goes to the detail pane rather than to blank card. */}
      <div className="agx-scroll flex-1 min-w-0 overflow-y-auto px-3 pb-4" style={{ maxWidth: 860 }}>
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
              <Row key={r.key} rail={r.rail} title={r.title ?? r.name} chips={r.chips} facts={r.facts}
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
      ))}
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
      {active && <Detail row={active} disabled={disabled} />}
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
      style={{ borderLeft: `1px solid ${wash("--text", 8)}`, background: wash("--bg2", 40) }}>
      <div>
        <div className="text-[10px] uppercase tracking-[0.11em] mb-1" style={{ color: "var(--text3)" }}>{row.kind}</div>
        <div className="text-[15px] font-medium break-all"
          style={{ color: "var(--text)", fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
          {row.name}
        </div>
        {!!row.chips && <div className="flex flex-wrap items-center gap-1.5 mt-2">{row.chips}</div>}
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
    // The rail answers "what is up with this one" before you read anything:
    // red is gone, amber is behind, green is ahead, blue is where you are.
    const rail: Tone = t.gone ? "bad" : isCurrent ? "accent" : t.behind > 0 ? "warn" : t.ahead > 0 ? "good" : "neutral";
    return {
      key: b.name, kind: "branch", name: b.name, state, rail, current: isCurrent,
      run: (id) => ctx.run(id, b),
      title: (
        <span className="flex items-center gap-2 min-w-0">
          <span onClick={(e) => { e.stopPropagation(); ctx.onPick(b.name); }}
            className={`shrink-0 cursor-pointer text-[11px] ${ctx.picked.size ? "" : "opacity-0 group-hover:opacity-100"} transition-opacity`}
            style={{ color: ctx.picked.has(b.name) ? "var(--primary)" : "var(--text3)" }}
            title={ctx.picked.has(b.name) ? "Untick" : "Tick for a bulk action"}>
            {ctx.picked.has(b.name) ? "☑" : "☐"}
          </span>
          <span className="truncate">{b.name}</span>
        </span>
      ),
      chips: (
        <>
          {isCurrent && <Chip tone="accent">on this</Chip>}
          {t.gone && <Chip tone="bad" title="its remote branch no longer exists">gone</Chip>}
          {t.ahead > 0 && <Chip tone="good">↑{t.ahead}</Chip>}
          {t.behind > 0 && <Chip tone="warn">↓{t.behind}</Chip>}
          {b.mergedIntoTrunk === true && !t.gone && <Chip>merged</Chip>}
          {elsewhere && <Chip tone="accent" title={wt!.path}>in {wt!.path.split("/").pop()}</Chip>}
        </>
      ),
      facts: [b.date, b.subject, b.upstream ?? "no upstream"],
    };
  });
}

export function tagRows(tags: GitTag[], run: (id: string, t: GitTag) => void): ListRow[] {
  return tags.map((t) => ({
    key: t.name, kind: "tag", name: t.name, state: {}, rail: "neutral",
    run: (id) => run(id, t),
    chips: t.annotated ? <Chip tone="accent">annotated</Chip> : undefined,
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
        <Chip tone="accent" title={w.branch}>⎇ {w.branch}</Chip>
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
    key: `${e.shortHash}-${i}`, kind: "commit", name: e.shortHash, state: {}, rail: "neutral",
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
  ctx: { picked: ReadonlySet<string>; run: (id: string, hash: string, subject: string) => void },
): ListRow[] {
  const commits = lines.filter((l) => !!l.hash);
  const graph = layoutGraph(commits.map((l) => ({ hash: l.hash!, parents: l.parents ?? [] })));
  const width = graphWidth(graph);
  return commits.map((l, i) => ({
    key: `${l.hash}-${i}`, kind: "commit", name: l.hash!, state: {},
    rail: ctx.picked.has(l.hash!) ? "accent" : "neutral",
    run: (id) => ctx.run(id, l.hash!, l.subject ?? ""),
    title: (
      <span className="flex items-center gap-2 min-w-0">
        <GraphCell row={graph[i]} width={width} />
        <span className="truncate" style={{ fontFamily: "var(--font-sans)" }}>{l.subject}</span>
      </span>
    ),
    chips: l.refs ? <Chip tone="good">{l.refs}</Chip> : undefined,
    facts: [l.date, l.hash, l.author],
  }));
}

/**
 * One row of the graph, drawn.
 *
 * A fixed-height SVG per row rather than one tall canvas beside the list: the
 * rows are a virtualised, foldable list whose heights are decided by their own
 * content, and a single drawing beside them would have to be told about every
 * one of those decisions to stay aligned. Per row it cannot drift.
 *
 * The curve is deliberate. A merge drawn as two straight segments meeting at a
 * corner reads as a right-angle pipe — which is what the ASCII was — and the
 * whole point of drawing this is that a branch should look like it leaves and
 * comes back.
 */
const ROW_H = 26;

function GraphCell({ row, width }: { row?: GraphRow; width: number }) {
  if (!row) return <span className="shrink-0" style={{ width }} />;
  const x = (lane: number) => lane * LANE_W + LANE_W / 2;
  const cap = Math.floor(width / LANE_W) - 1;
  return (
    <svg width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} className="shrink-0" aria-hidden
      style={{ overflow: "visible" }}>
      {row.links.map((l, i) => {
        // Lanes past the cap are clipped at the edge on purpose: it says "there
        // is more going on here" without letting forty branches eat the message.
        if (l.from > cap && l.to > cap) return null;
        const x1 = x(Math.min(l.from, cap)), x2 = x(Math.min(l.to, cap));
        const d = x1 === x2
          ? `M${x1} 0 V${ROW_H}`
          : `M${x1} 0 C${x1} ${ROW_H * 0.45} ${x2} ${ROW_H * 0.55} ${x2} ${ROW_H}`;
        return <path key={i} d={d} fill="none" stroke={laneColour(l.lane)} strokeWidth={1.5} strokeLinecap="round" opacity={0.55} />;
      })}
      {row.dot <= cap && (
        // Hollow for a merge: the one commit whose content is not its own.
        <circle cx={x(row.dot)} cy={ROW_H / 2} r={3.2}
          fill={row.merge ? "var(--bg2)" : laneColour(row.dot)}
          stroke={laneColour(row.dot)} strokeWidth={1.6} />
      )}
    </svg>
  );
}

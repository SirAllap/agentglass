// The right pane when the rail says "a list of projects": search, column heads,
// the virtual list, the legend with the highlighted row's full path, and the
// footer with "N ticked of M" and Open N. The footer and the legend are fixed
// below the list, so ticking never moves a button.
import { useMemo, useRef, type ReactNode } from "react";
import type { GitRepoRef } from "../../../../shared/types.ts";
import { VirtualList } from "../finder/machine/VirtualList.tsx";
import { SearchIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { INPUT, Button } from "../workspace/Chrome.tsx";
import { indexOfRoot, queryTerms, toggleGroup, type Group, type Item } from "../../lib/projectsView.ts";
import { Foot, HAIR, Kbd, Status, StateCard, Why } from "./ui.tsx";
import { ColumnHeads, GroupHead, ProjectRow, ROW_H } from "./Rows.tsx";

export interface ListProps {
  loading: boolean; scanned?: boolean;
  items: readonly Item[]; groups: readonly Group[]; total: number;
  query: string; setQuery: (q: string) => void; searchRef: React.Ref<HTMLInputElement>;
  tabs: Readonly<Record<string, number>>;
  hot: string | null; setHot: (r: string | null) => void;
  ticked: readonly string[]; setTicked: (t: string[]) => void; toggleTick: (r: string) => void;
  hidden: readonly string[]; workspaces: readonly string[]; busy: boolean; now: number;
  hiddenCount: number; showHidden: boolean; setShowHidden: (v: boolean) => void;
  tickedN: number; shownN: number; remoteTicked: number; opening: boolean;
  onOpen: (root: string) => void; onOpenTicked: () => void;
  onForget: (r: GitRepoRef) => void; onForgetFolder: (dir: string) => void; onMenu: (r: GitRepoRef, x: number, y: number) => void;
  onCopy: (text: string) => void; onAddAll: (paths: string[]) => void; onReset: () => void;
  emptyHint?: ReactNode;
}

export function ProjectList(p: ListProps) {
  const terms = queryTerms(p.query);
  const hotItem = useMemo(() => p.items.find((i) => i.t === "row" && i.r.root === p.hot), [p.items, p.hot]);
  const n = p.tickedN + p.remoteTicked;
  const keep = indexOfRoot(p.items, p.hot);
  const lastKeep = useRef(-1);
  if (keep >= 0) lastKeep.current = keep;
  const render = (i: number) => {
    const it = p.items[i]!;
    if (it.t === "head") {
      const roots = it.g.items.map((r) => r.root);
      const all = roots.length > 0 && roots.every((r) => p.ticked.includes(r));
      return (
        <div key={`h:${it.g.key}`} style={{ height: ROW_H }}>
          <GroupHead g={it.g} searching={!!terms.length} ticked={all} onToggle={() => p.setTicked(toggleGroup(p.ticked, it.g))}
            onCopy={it.g.full ? () => p.onCopy(it.g.full!) : undefined} onForget={it.g.full ? () => p.onForgetFolder(it.g.full!) : undefined}
            onAddAll={it.g.kind === "elsewhere" && it.g.items.length ? () => p.onAddAll(it.g.items.map((r) => r.root)) : undefined} />
        </div>
      );
    }
    const r = it.r;
    return (
      <div key={`r:${it.g.key}:${r.root}`} style={{ height: ROW_H }}>
        <ProjectRow r={r} tabs={p.tabs[r.root] ?? 0} query={p.query} now={p.now} current={p.workspaces.includes(r.root)} hotRow={p.hot === r.root} ticked={p.ticked.includes(r.root)}
          hidden={p.hidden.includes(r.root) && !p.workspaces.includes(r.root)} busy={p.busy} onTick={() => p.toggleTick(r.root)} onOpen={() => p.onOpen(r.root)} onHot={() => p.hot !== r.root && p.setHot(r.root)}
          onForget={() => p.onForget(r)} onMenu={(x, y) => p.onMenu(r, x, y)} />
      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <label className="relative flex items-center pm-mx mt-2.5 mb-2.5 shrink-0">
        <span className="absolute left-3 flex" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.md} /></span>
        <input ref={p.searchRef} value={p.query} onChange={(e) => p.setQuery(e.target.value)} placeholder={`Search ${p.total} project${p.total === 1 ? "" : "s"} by name, path or branch`}
          aria-label="Search projects" spellCheck={false} autoComplete="off" autoFocus
          className={`w-full ${INPUT}`} style={{ paddingLeft: 38, paddingRight: 34, height: 40, fontSize: 13, borderRadius: 10 }} />
        <span className="absolute right-3 flex"><Kbd>/</Kbd></span>
      </label>
      <ColumnHeads />

      <div className="flex flex-col flex-1 min-h-0" style={{ borderTop: HAIR }}>
        {p.loading ? (
          <StateCard hue="primary" spin icon={<span className="inline-block w-4 h-4 rounded-full" style={{ border: "2px solid currentColor", borderTopColor: "transparent" }} />} title={p.scanned ? "Looking for projects…" : "Reading your folders…"} />
        ) : p.items.length === 0 ? (
          <div className="overflow-y-auto agx-scroll">{p.emptyHint}</div>
        ) : (
          <VirtualList count={p.items.length} rowH={ROW_H} render={render} keepInView={keep >= 0 ? keep : null} label="Projects" className="flex-1" />
        )}
      </div>

      <div className="shrink-0 flex flex-col" style={{ borderTop: HAIR }}>
        <div className="flex items-center gap-3.5 flex-wrap pm-px py-2 text-[11px]" style={{ color: "var(--text3)" }}>
          <b style={{ color: "var(--text2)" }}>Reading a row</b>
          <span className="inline-flex items-center gap-1.5"><Status hue="info">3</Status> tabs open</span>
          <span className="inline-flex items-center gap-1.5"><Status hue="warning">● 2</Status> uncommitted</span>
          <span className="inline-flex items-center gap-1.5"><Status hue="muted">↑2 ↓4</Status> ahead / behind the remote</span>
          <span className="flex-1" />
          {(p.hiddenCount > 0 || p.showHidden) && (
            <button className="bg-transparent border-0 p-0 cursor-pointer font-semibold text-[11px]" style={{ color: "var(--primary)" }} onClick={() => p.setShowHidden(!p.showHidden)}>
              {p.showHidden ? "Hide forgotten again" : `${p.hiddenCount} forgotten · show`}
            </button>
          )}
        </div>
        <div className="pm-px pb-1.5 text-[11px] font-mono flex items-center gap-2 min-w-0" style={{ minHeight: 22, color: "var(--text3)" }} data-fullpath>
          {hotItem && hotItem.t === "row" ? (
            <>
              <span className="min-w-0" style={{ overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }} title={hotItem.r.root}>{hotItem.r.root}</span>
              <button className="shrink-0 font-sans font-semibold text-[11px] bg-transparent border-0 p-0 cursor-pointer" style={{ color: "var(--primary)" }} onClick={() => p.onCopy(hotItem.r.root)}>Copy path</button>
              {hotItem.r.branch && hotItem.r.branch.length > 18 && <span className="shrink-0 font-sans" style={{ color: "var(--text4)" }}>· {hotItem.r.branch}</span>}
            </>
          ) : <span className="font-sans" style={{ color: "var(--text4)" }}>Move over a row to read its full path.</span>}
        </div>
      </div>

      <Foot hint={<><span><Kbd>↑↓</Kbd> move</span><span><Kbd>Space</Kbd> tick</span><span><Kbd>⏎</Kbd> open</span><span><Kbd>/</Kbd> search</span><span><Kbd>Esc</Kbd> close</span><span><Kbd>?</Kbd> keys</span></>}>
        <span className="text-[12px] font-semibold whitespace-nowrap" style={{ color: "var(--text)" }} aria-live="polite">
          {n} ticked <span className="font-normal" style={{ color: "var(--text3)" }}>of {p.shownN}</span>
        </span>
        {n > 0 && <Button size="compact" onClick={p.onReset} disabled={p.busy}>Reset</Button>}
        <Why reason={n === 0 ? "Tick a project, or press Enter on a highlighted one" : undefined}>
          <Button tone="primary" pending={p.opening} disabled={n === 0 || p.busy} onClick={p.onOpenTicked} className="px-4" style={{ minWidth: 132, justifyContent: "center" }}>
            {n === 0 ? "Open" : `Open ${n}`}
          </Button>
        </Why>
      </Foot>
    </div>
  );
}

export function NoMatch({ query, children }: { query: string; children?: ReactNode }) {
  return <StateCard hue="muted" icon={<WarningIcon size={ICON.lg} />} title={`No project matches “${query.trim()}”`} actions={children}>Search looks at the name, the full path and the branch.</StateCard>;
}

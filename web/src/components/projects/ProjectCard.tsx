// Choosing a project: the shared PickerCard under the top bar's project button.
// The modal (ProjectsModal) stays for what needs a form: add a folder, clone, new.
import { useEffect, useMemo, useState } from "react";
import { PickerCard, type PickerItem } from "../PickerCard.tsx";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { LAYER } from "../../lib/layers.ts";
import { ICON } from "../../lib/iconSize.ts";
import { BranchIcon, DoneIcon, EyeIcon, EyeOffIcon, FolderIcon, ArrowIcon } from "../../lib/glyphIcons.tsx";
import { useProjectsModal } from "./useProjectsModal.ts";
import { cardRows, folderHue, folderKey, groupHead, groupOrder, GROUP_HIDDEN, multiMode, pickAction, RECENT_DAYS, shelfIds, tabScope, tileSub } from "../../lib/projectCard.ts";
import { parentOf } from "../../lib/projectsPaths.ts";

export type ModalPane = "folder" | "clone" | "new";

/** The folder icon in a small rounded square, tinted per project. */
function FolderTile({ root, size = 28 }: { root: string; size?: number }) {
  const hue = `var(${folderHue(root)})`;
  return <span className="grid place-items-center rounded-lg shrink-0" style={{ width: size, height: size, background: `color-mix(in srgb, ${hue} 14%, transparent)`, border: EDGE, color: hue }}><FolderIcon size={ICON.sm} /></span>;
}

/** A small action inside a row (a row is a button, so this is a span). */
function RowAct({ label, tip, onAct, children }: { label: string; tip: string; onAct: () => void; children: React.ReactNode }) {
  return <span role="button" tabIndex={-1} aria-label={label} data-tip={tip} onClick={(e) => { e.stopPropagation(); onAct(); }}
    className="grid place-items-center rounded" style={{ width: 20, height: 20, color: "var(--text2)" }}>{children}</span>;
}

/** Where the button is: the card hangs under its left edge. */
function anchor(): { left: number; top: number } {
  const b = document.querySelector<HTMLElement>("[data-project-button]")?.getBoundingClientRect();
  return b ? { left: Math.max(8, b.left), top: b.bottom + 4 } : { left: 56, top: 34 };
}

export function ProjectCard({ workspaces, known, onClose, onModal }: { workspaces: readonly string[]; known: boolean; onClose: () => void; onModal: (p: ModalPane) => void }) {
  const m = useProjectsModal({ open: true, workspaces, known, onClose });
  const [now] = useState(() => Date.now());
  const pos = useMemo(anchor, []);
  const hiddenSet = useMemo(() => new Set(m.hidden), [m.hidden]);
  const repos = m.repos ?? [];
  const rows = useMemo(() => cardRows(repos, hiddenSet), [repos, hiddenSet]);
  const byRoot = useMemo(() => new Map(repos.map((r) => [r.root, r])), [repos]);
  const current = useMemo(() => new Set(workspaces), [workspaces]);
  const recent = useMemo(() => shelfIds(repos, hiddenSet, now), [repos, hiddenSet, now]);
  const [ticks, setTicks] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setTicks(new Set()); }, [m.repos]);

  const tick = (id: string) => setTicks((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const multi = multiMode(rows.length, ticks.size);
  /** Open beside the projects already open (⇧↵, or the arrow on a row). */
  const newTab = async (id: string) => { const next = tabScope(id, workspaces); if (next) await m.openScope(next); else m.close(); };

  const items: PickerItem[] = useMemo(() => rows.map((r) => {
    const on = ticks.has(r.id);
    return {
      id: r.id, label: r.label, sub: r.sub, group: r.group, at: r.at, title: r.title, on, markOn: false,
      leading: <FolderTile root={r.id} />,
      trailing: <>
        {r.dirty > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--warning-ink)" }} data-tip={`${r.dirty} uncommitted`}>●{r.dirty}</span>}
        {r.branch && <span className="inline-flex items-center gap-1 rounded px-1 text-[10px] font-mono truncate" style={{ maxWidth: 110, border: EDGE, color: "var(--text2)" }}><BranchIcon size={ICON.xs} />{r.branch}</span>}
        <span className="inline-flex gap-0.5 opacity-0 group-hover:opacity-100 group-data-[cursor=true]:opacity-100 group-focus-within:opacity-100">
          {!current.has(r.id) && <RowAct label={`Open ${r.label} in a new tab`} tip="Open in a new tab · ⇧↵" onAct={() => void newTab(r.id)}><ArrowIcon size={ICON.xs} /></RowAct>}
          <RowAct label={r.group === GROUP_HIDDEN ? `Show ${r.label} again` : `Hide ${r.label}`} tip={r.group === GROUP_HIDDEN ? "Show again" : "Hide from this list"} onAct={() => m.toggleHidden(r.id, r.label)}>
            {r.group === GROUP_HIDDEN ? <EyeIcon size={ICON.xs} /> : <EyeOffIcon size={ICON.xs} />}</RowAct>
        </span>
        {/* Square tick: several open together. Only in multi-select. */}
        {multi && <span role="checkbox" aria-checked={on} aria-label={`Tick ${r.label}`} tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); tick(r.id); }}
          className="shrink-0 grid place-items-center rounded" style={{ width: 14, height: 14, border: EDGE, background: on ? "var(--primary)" : "transparent", color: "#fff" }}>{on && <DoneIcon size={ICON.xs} />}</span>}
      </>,
    };
  }), [rows, ticks, multi, current]);

  const heads = useMemo(() => {
    const by = new Map<string, { label: string }[]>();
    for (const r of rows) (by.get(r.group) ?? by.set(r.group, []).get(r.group)!).push({ label: r.label });
    return by;
  }, [rows]);
  const curKey = workspaces[0] ? folderKey(parentOf(workspaces[0])) : null;
  // The card lists groups in the order the rows arrive: hand them in group order.
  const ordered = useMemo(() => {
    const keys = groupOrder([...heads.keys()], curKey, (k) => heads.get(k)?.length ?? 0);
    return keys.flatMap((k) => items.filter((i) => i.group === k));
  }, [items, heads, curKey]);

  const pickAlt = (id: string) => void newTab(id);
  const pick = (id: string) => {
    const a = pickAction(ticks, id);
    if (a === "toggle") tick(id);
    else if (a === "scope") void m.openScope([...ticks]);
    else m.choose(id);
  };

  const tile = (it: PickerItem, cur: boolean) => {
    const r = rows.find((x) => x.id === it.id);
    return <>
      <span className="flex items-center gap-1.5 min-w-0">
        <FolderTile root={it.id} size={22} />
        <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] font-bold">{it.label}</span>
          <span className="block truncate text-[10px]" style={{ color: "var(--text3)" }}>{r ? tileSub(r.at, r.branch, now) : ""}</span></span>
      </span>
      {cur && <span className="absolute grid place-items-center rounded-full" aria-label="Open now" style={{ top: 4, right: 4, width: 14, height: 14, background: "var(--success)", color: "#fff" }}><DoneIcon size={ICON.xs} /></span>}
    </>;
  };

  return (
    <>
    <div className="fixed inset-0" style={{ zIndex: LAYER.menu - 1 }} onClick={m.close} aria-hidden />
    <PickerCard
      items={ordered} current={current} recent={recent} onPickAlt={pickAlt} shelfNote={`last ${RECENT_DAYS} days`} shelfTile={tile} loading={m.repos === null} onPick={pick} onClose={m.close}
      groupLabels={(k) => {
        const h = groupHead(k, heads.get(k) ?? []);
        return <span className="flex items-baseline gap-2 min-w-0"><span className="truncate">{h.title}</span>{h.preview && <span className="truncate text-[10px]" style={{ color: "var(--text3)" }}>{h.preview}</span>}</span>;
      }}
      defaultOpen={curKey ? [curKey] : []} picked={ticks.size} multi={multi} width={380} room={460} search
      placeholder="Find a project, folder or branch" noun="project" label="Open project"
      emptyText="No git repositories yet. Add a folder or clone one."
      style={{ left: pos.left, top: pos.top }}
      footer={<>
        <Button size="compact" onClick={() => onModal("folder")}>+ Add a folder</Button>
        <Button size="compact" onClick={() => onModal("clone")}>Clone…</Button>
        <Button size="compact" onClick={() => onModal("new")}>New project</Button>
        {ticks.size > 0 && <Button size="compact" onClick={() => void m.openScope([...ticks])}>Open {ticks.size}</Button>}
      </>}
      footerNote="↵ open · ⇧↵ new tab" />
    </>
  );
}

/*
 * The row of buttons under the Log and the Reflog: one place, every state.
 *
 * What it offers for what is picked is decided in lib/gitDock.ts; this only
 * draws it. A button that cannot run now stays where it is and says why on
 * hover, so the row never rearranges itself under the pointer. The branch a
 * button acts on is a chip inside its label and never shrinks: the name that
 * gives way is the selection chip on the left.
 */
import { Fragment, useState, type ReactNode } from "react";
import { Button } from "./workspace/Chrome.tsx";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import {
  BranchIcon, CopyIcon, EyeIcon, MoreIcon, PlusIcon, SwapIcon, UndoIcon, MinusIcon, ArrowIcon, MergeIcon, FolderIcon, LinkIcon,
  EditIcon, RefreshIcon, LockIcon, ListIcon, CrossIcon, WarningIcon, FileIcon, TagIcon, CommitIcon, SearchIcon,
} from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { useFurnitureClear } from "../lib/useFurnitureClear.ts";
import type { DockAction } from "../lib/gitDock.ts";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function DockIcon({ name, size = ICON.sm }: { name: string; size?: number }) {
  switch (name) {
    case "eye": return <EyeIcon size={size} />;
    case "compare": return <SwapIcon size={size} />;
    case "plus": return <PlusIcon size={size} />;
    case "minus": return <MinusIcon size={size} />;
    case "undo": return <UndoIcon size={size} />;
    case "copy": return <CopyIcon size={size} />;
    case "pick": case "rebase": case "branch": return <BranchIcon size={size} />;
    case "arrow": return <ArrowIcon size={size} />;
    case "merge": return <MergeIcon size={size} />;
    case "folder": return <FolderIcon size={size} />;
    case "ext": return <LinkIcon size={size} />;
    case "edit": return <EditIcon size={size} />;
    case "refresh": return <RefreshIcon size={size} />;
    case "lock": return <LockIcon size={size} />;
    case "list": return <ListIcon size={size} />;
    case "x": return <CrossIcon size={size} />;
    case "alert": return <WarningIcon size={size} />;
    case "file": return <FileIcon size={size} />;
    case "tag": return <TagIcon size={size} />;
    case "commit": return <CommitIcon size={size} />;
    case "search": return <SearchIcon size={size} />;
    case "up": return <svg width={size} height={size} viewBox="0 0 14 14" {...stroke}><path d="M7 11.5v-9M3.5 6L7 2.5 10.5 6" /></svg>;
    case "dn": return <svg width={size} height={size} viewBox="0 0 14 14" {...stroke}><path d="M7 2.5v9M3.5 8L7 11.5 10.5 8" /></svg>;
    case "cloud": return <svg width={size} height={size} viewBox="0 0 14 14" {...stroke}><path d="M4 11a2.5 2.5 0 0 1-.3-5 3.5 3.5 0 0 1 6.6.8A2.1 2.1 0 0 1 10 11z" /></svg>;
    case "trash": return <svg width={size} height={size} viewBox="0 0 14 14" {...stroke}><path d="M2.5 4h9M5.5 4V2.5h3V4M3.8 4l.5 7.5h5.4l.5-7.5" /></svg>;
    default: return <svg width={size} height={size} viewBox="0 0 14 14" {...stroke}><circle cx="7" cy="8" r="3" /><path d="M7 5V3M4 8H2M12 8h-2" /></svg>;
  }
}

/** The label with its target branch drawn as a chip that does not shrink. */
function Label({ a }: { a: DockAction }) {
  const at = a.chip ? a.label.lastIndexOf(a.chip) : -1;
  if (!a.chip || at < 0) return <>{a.label}</>;
  return (
    <>
      {a.label.slice(0, at)}
      <span className="shrink-0 min-w-0 max-w-full truncate px-1 rounded" title={a.chip}
        style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", border: "1px solid color-mix(in srgb, currentColor 35%, transparent)" }}>
        {a.chip}
      </span>
      {a.label.slice(at + a.chip.length)}
    </>
  );
}

/** A rule above the copy at the end of a menu, as the approved More menu draws it. */
const sepBefore = (a: DockAction, i = 1) => i > 0 && a.icon === "copy";

const why = (a: DockAction) => (a.disabled ? a.reason : a.title) ?? a.label;

export function GitDock({ actions, more, onRun, selection, selectionTitle, selectionIcon, cmd, disabled }: {
  actions: DockAction[];
  more: DockAction[];
  onRun: (id: string) => void;
  /** What is picked, named: a short sha, or "2 picked". */
  selection: ReactNode;
  selectionTitle?: string;
  /** The git the first button runs, in grey beside the selection. */
  cmd?: string;
  /** A dock icon drawn in the selection chip (the Log's commit). */
  selectionIcon?: string;
  /** The checkout cannot be written to: every button is shut. */
  disabled?: boolean;
}) {
  // The dock sits at the bottom edge and ContextMenu only clamps, it never flips:
  // opened at the button's top it was pushed up just enough to fit and covered the
  // Revert and Reset beside it. So aim above the button, one row of ~30px per item.
  const [menu, setMenu] = useState<{ x: number; y: number; items: DockAction[] } | null>(null);
  // The bench button floats over the bottom right, where More sits at 1000px.
  const [bar, clear] = useFurnitureClear<HTMLDivElement>([actions.length, more.length]);
  const openMenu = (e: { currentTarget: HTMLElement }, items: DockAction[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.top - items.length * 30 - 12 - (items.some(sepBefore) ? 9 : 0), items });
  };
  const safe = actions.filter((a) => a.kind !== "danger");
  const danger = actions.filter((a) => a.kind === "danger");
  // Compact (22): the mono labels at the regular size left the seven Log buttons 18px
  // wider than a 1236px window, so Reset dropped to a second row under Revert.
  const btn = (a: DockAction) => (
    <Button key={a.id} onClick={(e) => (a.menu ? openMenu(e, a.menu) : onRun(a.id))} disabled={disabled || a.disabled} title={why(a)}
      size="compact" tone={a.kind === "primary" ? "primary" : a.kind === "danger" ? "danger" : "plain"}
      className="shrink-0 max-w-full" data-dock={a.id}>
      <DockIcon name={a.icon} /><Label a={a} />
    </Button>
  );
  // Wraps rather than clips: a 100-character branch chip pushed More, Revert and
  // Reset off the right edge at 1500px and squeezed the selection chip to one letter.
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-1.5 px-3 py-2" ref={bar} data-git-dock
      style={{ paddingRight: 12 + clear, borderTop: "1px solid color-mix(in srgb, var(--text) 8%, transparent)", background: "var(--surface-card)" }}>
      <span className="min-w-[88px] flex-1 basis-0 truncate text-[10.5px] px-2 py-1 rounded-lg inline-flex items-center gap-1.5"
        title={selectionTitle} style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 12%, transparent)", maxWidth: 160 }}>
        {selectionIcon && <span className="shrink-0 inline-flex"><DockIcon name={selectionIcon} size={ICON.xs} /></span>}
        <span className="truncate">{selection}</span>
      </span>
      {cmd && <span className="shrink-0 text-[11px]" title={cmd} style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text3)" }}>{cmd}</span>}
      <div className="flex flex-wrap items-center justify-end gap-1.5 ml-auto min-w-0 max-w-full">
        {safe.map(btn)}
        {!!more.length && (
          <Button onClick={(e) => openMenu(e, more)} size="compact"
            disabled={disabled} className="shrink-0" data-dock="more" aria-haspopup="menu">
            <MoreIcon size={ICON.sm} />More
          </Button>
        )}
        {!!danger.length && <span aria-hidden className="self-stretch w-px" style={{ background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />}
        {danger.map(btn)}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} width={300}>
          {menu.items.map((a, i) => (
            <Fragment key={a.id}>
              {sepBefore(a, i) && <hr className="m-0 mx-0.5 my-1 border-0 border-t" style={{ borderColor: "color-mix(in srgb, var(--text) 8%, transparent)" }} />}
              {a.disabled
                ? <span className="px-2 py-1.5 text-[12.5px] inline-flex items-center gap-2 opacity-50 cursor-not-allowed" title={a.reason}><DockIcon name={a.icon} />{a.label}</span>
                : <MenuItem danger={a.kind === "danger"} onClick={() => { setMenu(null); onRun(a.id); }}>
                    <span className="inline-flex items-center gap-2 text-[12.5px]"><DockIcon name={a.icon} />{a.label}</span>
                  </MenuItem>}
            </Fragment>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}

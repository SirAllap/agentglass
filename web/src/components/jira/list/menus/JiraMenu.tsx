/*
 * A Jira right-click menu, drawn from a JiraMenu (menuModel.ts) in the skin of the pull-request card menu
 * (components/PrCardMenu.tsx): the same shell (ContextMenu `pop`), the same `.agx-pcm-*` rows, so the two cannot
 * drift. What differs: the keys are real while it is open (a letter presses its row), and the list is short enough
 * that it never scrolls, so the PR menu's drawn scroll thumb is not here.
 *
 * Keys: the arrows, Home and End are the shell's (ContextMenu); a letter or ArrowLeft presses its row; Escape closes.
 * The first row that is on takes focus when it opens, so Enter presses it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "../../../ContextMenu.tsx";
import { ICON } from "../../../../lib/iconSize.ts";
import {
  ArrowIcon, BranchIcon, CaretIcon, CommentIcon, CopyIcon, CrossIcon, DoneIcon, EditIcon, ExpandIcon, EyeIcon, EyeOffIcon, FlagIcon,
  LinkIcon, ListIcon, PinIcon, PullRequestIcon, RefreshIcon, SortIcon, SwapIcon, UserIcon,
} from "../../../../lib/glyphIcons.tsx";
import { keyAction, keyLabel, keySpec, walkIds, type JiraMenu, type JiraMenuItem, type MenuGlyph } from "./menuModel.ts";

export const MENU_WIDTH = 268;

const glyph = (g: MenuGlyph): ReactNode => {
  const s = ICON.sm;
  switch (g) {
    case "sidebar": return <ExpandIcon size={s} />;
    case "ext": return <ArrowIcon size={s} />;
    case "move": return <SwapIcon size={s} />;
    case "user": return <UserIcon size={s} />;
    case "comment": return <CommentIcon size={s} />;
    case "copy": return <CopyIcon size={s} />;
    case "link": return <LinkIcon size={s} />;
    case "branch": return <BranchIcon size={s} />;
    case "pr": return <PullRequestIcon size={s} />;
    case "pin": return <PinIcon size={s} />;
    case "refresh": return <RefreshIcon size={s} />;
    case "eyeoff": return <EyeOffIcon size={s} />;
    case "eye": return <EyeIcon size={s} />;
    case "back": return <CaretIcon size={s} className="rotate-90" />;
    case "chev": return <CaretIcon size={s} />;
    case "sort": return <SortIcon size={s} />;
    case "list": return <ListIcon size={s} />;
    case "x": return <CrossIcon size={s} />;
    case "pencil": return <EditIcon size={s} />;
    case "filter": return <FlagIcon size={s} />;
    case "sliders": return <SortIcon size={s} />;
    case "check": return <DoneIcon size={s} />;
  }
};

/** `onPick` may answer "stay" to keep the menu open (the sort choices replace this menu with another). */
export function JiraMenuView({ menu, x, y, onPick, onClose }: {
  menu: JiraMenu; x: number; y: number;
  onPick: (id: string) => void | "stay"; onClose: () => void;
}) {
  const [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  /* The first row that is on takes focus, so Enter and the keys are in the menu the moment it opens. */
  useEffect(() => {
    const first = walkIds(menu, false)[0];
    if (first) root.current?.querySelector<HTMLElement>(`[data-mid="${first}"]`)?.focus();
  }, [menu]);

  /* The menu is clamped to the screen when it opens, so rows folded in under More can land below the fold: bring the last one into view. */
  useEffect(() => {
    if (more) root.current?.querySelector(".agx-pcm-more")?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [more]);

  const press = (id: string) => {
    if (id === "more") { setMore((m) => !m); return; }
    if (onPick(id) !== "stay") onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const id = keyAction(menu, keySpec(e));
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    press(id);
  };

  const row = (it: JiraMenuItem) => (
    <button key={it.id} role="menuitem" data-mid={it.id} tabIndex={-1} aria-disabled={it.why ? true : undefined}
      aria-keyshortcuts={it.key} onClick={() => { if (!it.why) press(it.id); }}
      className="agx-pcm-item" data-strong={it.strong ? "1" : undefined} data-danger={it.danger ? "1" : undefined}>
      <span aria-hidden className="agx-pcm-ico">{glyph(it.icon)}</span>
      <span className="agx-pcm-txt">
        <span className="agx-pcm-lbl">{it.label}</span>
        {(it.why || it.sub) && <span className="agx-pcm-sub">{it.why ?? it.sub}</span>}
      </span>
      {it.key && <span aria-hidden className="agx-pcm-key">{keyLabel(it.key)}</span>}
    </button>
  );

  return (
    <ContextMenu pop x={x} y={y} onClose={onClose} width={MENU_WIDTH} label={menu.head}>
      <div ref={root} onKeyDown={onKey} className="agx-pcm">
        <div className="agx-pcm-head" data-tip={menu.head}>{menu.head}</div>
        <div className="agx-pcm-scroll">
          {menu.rows.map((r, i) =>
            r.kind === "rule" ? <div key={i} role="separator" className="agx-pcm-rule" />
              : r.kind === "heading" ? <div key={i} role="presentation" className="agx-pcm-h">{r.text}</div>
              : row(r))}
          {menu.more.length > 0 && (
            <>
              <button role="menuitem" data-mid="more" tabIndex={-1} aria-expanded={more} onClick={() => press("more")}
                className="agx-pcm-item" data-more="1">
                <span aria-hidden className="agx-pcm-ico"><CaretIcon size={ICON.sm} className={more ? "rotate-90" : "-rotate-90"} /></span>
                <span className="agx-pcm-txt"><span className="agx-pcm-lbl">{more ? "Fewer" : "More"}</span></span>
                {!more && <span aria-hidden className="agx-pcm-key">{menu.more.length} more</span>}
              </button>
              {more && <div className="agx-pcm-more">{menu.more.map(row)}</div>}
            </>
          )}
          {menu.close && (
            <>
              <div role="separator" className="agx-pcm-rule" />
              {row(menu.close)}
            </>
          )}
        </div>
      </div>
    </ContextMenu>
  );
}

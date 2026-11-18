/*
 * The board card's menu, drawn from CardActions (cardActions.ts) in the same shell and rows as the other Jira menus
 * (`ContextMenu pop`, `.agx-pcm-*`). The filter box keeps focus the whole time: typing narrows the rows, the arrows
 * walk them, ArrowRight opens a submenu, ArrowLeft closes it, Enter presses the row. A submenu is a second panel
 * beside the row it came from, walked by the same keys.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "../../../ContextMenu.tsx";
import { Portal } from "../../../Portal.tsx";
import { CaretIcon, DoneIcon } from "../../../../lib/glyphIcons.tsx";
import { ICON } from "../../../../lib/iconSize.ts";
import { LAYER } from "../../../../lib/layers.ts";
import { tipAttr } from "../../../../lib/tip.ts";
import { MENU_WIDTH } from "./JiraMenu.tsx";
import { filterActions, nextOn, type Act, type CardActions } from "./cardActions.ts";

const keyCap = (k: string): string => (k === "Enter" ? "⏎" : k.toUpperCase());

export function JiraCardMenu({ menu, x, y, onPick, onClose }: {
  menu: CardActions; x: number; y: number; onPick: (id: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [subOf, setSubOf] = useState<string | null>(null);
  const [subIdx, setSubIdx] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => filterActions(menu.groups, q), [menu, q]);
  const parent = subOf ? rows.find((r) => r.id === subOf) : undefined;
  const kids = parent?.children ?? [];

  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  /* A new filter starts on its first row that is on; a menu rebuilt under the cursor (the steps arrive) keeps it. */
  useEffect(() => { setSubOf(null); setIdx(Math.max(0, rows.findIndex((r) => !r.why))); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { root.current?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: "nearest" }); }, [idx, subIdx, subOf]);

  const openSub = (r: Act | undefined) => {
    if (!r?.children || r.why) return;
    setSubOf(r.id);
    setSubIdx(Math.max(0, r.children.findIndex((c) => !c.why)));
  };
  const press = (a: Act | undefined) => {
    if (!a || a.why || a.id === "why") return;
    if (a.children) { openSub(a); return; }
    onPick(a.id);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const list = subOf ? kids : rows;
    const cur = subOf ? subIdx : idx;
    const set = subOf ? setSubIdx : setIdx;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); set(nextOn(list, cur, e.key === "ArrowDown" ? 1 : -1)); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); press(list[cur]); }
    else if (e.key === "ArrowRight" && !subOf && rows[idx]?.children) { e.preventDefault(); openSub(rows[idx]); }
    else if (e.key === "ArrowLeft" && subOf) { e.preventDefault(); setSubOf(null); }
  };

  const row = (a: Act, on: boolean, open: boolean, onHover: () => void, onGo: () => void) => (
    <button key={a.id} type="button" role="menuitem" tabIndex={-1} data-on={on ? "1" : undefined} data-mid={a.id}
      aria-disabled={a.why ? true : undefined} aria-haspopup={a.children ? "menu" : undefined} aria-expanded={a.children ? open : undefined} aria-checked={a.chk ? true : undefined}
      className="agx-pcm-item" onMouseEnter={onHover} onClick={onGo}>
      <span aria-hidden className="agx-pcm-ico">{a.chk ? <DoneIcon size={ICON.sm} /> : null}</span>
      <span className="agx-pcm-txt">
        <span className="agx-pcm-lbl">{a.label}</span>
        {(a.why || a.sub) && <span className="agx-pcm-sub">{a.why ?? a.sub}</span>}
      </span>
      {a.children ? <span aria-hidden className="agx-pcm-key"><CaretIcon size={ICON.sm} className="-rotate-90" /></span>
        : a.key ? <span aria-hidden className="agx-pcm-key">{keyCap(a.key)}</span> : null}
    </button>
  );

  let last = "";
  const body = rows.flatMap((r, i) => {
    const g = q.trim() ? "" : menu.groups.find((gr) => gr.items.includes(r))?.label ?? "";
    const head = g && g !== last ? <div key={`h-${g}`} role="presentation" className="agx-pcm-h">{g}</div> : null;
    if (g) last = g;
    return [...(head ? [head] : []), row(r, i === idx && !subOf, subOf === r.id, () => { if (!subOf || subOf === r.id) setIdx(i); else { setSubOf(null); setIdx(i); } }, () => { setIdx(i); press(r); })];
  });
  const why = (subOf ? kids[subIdx]?.why : rows[idx]?.why) ?? null;
  const subRect = subOf ? root.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(subOf)}"]`)?.getBoundingClientRect() : undefined;

  return (
    <ContextMenu pop x={x} y={y} onClose={onClose} width={MENU_WIDTH} label={menu.head}>
      <div ref={root} onKeyDown={onKey} className="agx-pcm">
        <div className="agx-pcm-filter">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter actions…" aria-label="Filter actions" autoComplete="off" spellCheck={false} />
        </div>
        <div className="agx-pcm-head" data-tip={tipAttr(menu.head)}>{menu.head}</div>
        <div className="agx-pcm-scroll">
          {rows.length ? body : <div className="agx-pcm-none">No matching action</div>}
        </div>
        {why && <div className="agx-pcm-why" role="status">{why}</div>}
      </div>
      {/* Above the menu's own portal (LAYER.menu), whose full-window catcher closes the menu on a click outside it:
            at 10000 the submenu sat under that catcher, so it was drawn but every click on it only closed the menu
            (Sprint, Move to, Assign and Copy all did nothing). */}
      {parent && subRect && (
        <Portal z={LAYER.menu + 1}>
          <SubPanel rect={subRect}>
            {kids.map((c, i) => row(c, i === subIdx, false, () => setSubIdx(i), () => { setSubIdx(i); press(c); }))}
          </SubPanel>
        </Portal>
      )}
    </ContextMenu>
  );
}

/** The submenu: beside its row, on the other side when there is no room, and inside the window either way. */
function SubPanel({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = rect.right + 2 + w > window.innerWidth - 8 ? rect.left - w - 2 : rect.right + 2;
    setAt({ left: Math.max(8, left), top: Math.max(8, Math.min(rect.top - 4, window.innerHeight - h - 8)) });
  }, [rect]);
  return (
    <div ref={ref} role="menu" className="agx-pcm agx-pcm-fly"
      style={{ position: "fixed", left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden", width: 220 }}>
      <div className="agx-pcm-scroll">{children}</div>
    </div>
  );
}

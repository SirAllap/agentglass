/*
 * SAVED FILTER SETS, drawn: a chip row beside the Filters button.
 *
 * One click on a chip replaces the live filter with the saved one; the number on
 * it is how many cards that preset would show. The Save slot lives at the right
 * end of the row and never moves — it is disabled until there is something to
 * save, and turns into Update / Save as new / Revert when the filter on screen
 * differs from the preset that is on. Four chips fit; the rest sit behind a
 * More menu that presses and names itself when a hidden preset is the one on.
 *
 * The data rules (what a name may be, what "modified" means, what a delete
 * undoes) are in lib/filterPresets.ts and the storage in useFilterPresets; this
 * file is the keyboard and the pixels. Every action has a key: roving tabindex
 * along the row, Enter or Space applies, F2 renames in place, Del deletes (and
 * the toast undoes it), Alt+Left/Right moves, the menu key or Shift+F10 opens
 * the row's menu, Alt+1..9 applies the nth. The mouse has the same menu on a
 * right click and on the dots that replace a chip's number while it is hovered.
 *
 * Nothing here changes size between states: the dots sit where the number does,
 * and a rename is an input of the chip's own height.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKey, type ReactNode } from "react";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { Portal } from "./Portal.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE, chipTone } from "./workspace/Chrome.tsx";
import { menuUnder } from "../lib/menuPos.ts";
import { MAX_NAME, MAX_PRESETS, canAdd, cleanName, dropGone, freeName, nthPreset, rulesToPreset, summarizeRules, type Gone, type Preset } from "../lib/filterPresets.ts";
import { liveCount, type FieldSpec, type FilterSet } from "./tasks/filters.ts";
import { UNDO_MS, type PresetFailure, type PresetsApi } from "./useFilterPresets.ts";

/** How many chips sit in the row before the rest go behind More. */
export const VISIBLE_CHIPS = 4;
/** The same layer as the Filters panel, which these menus open beside. */
const MENU_Z = 10040;
const MORE = "__more";
const isMenuKey = (e: ReactKey) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
/**
 * Marks every menu this file draws AND the buttons that open them, so a press
 * in one is not an outside press for another. The trigger needs it too: a press
 * on the button that owns an open menu would close it, and the click that
 * follows would open it again.
 */
const MENU_ATTR = "data-agx-presetmenu";
/** One look for every surface this file floats. */
const SURFACE = { background: "var(--surface-card)", border: EDGE } as const;

/** The border of a field that was refused: the same edge, its colour turned. */
const ERR_EDGE = "color-mix(in srgb, var(--error-ink) 55%, transparent)";
const tint = (pct: number) => `color-mix(in srgb, var(--primary) ${pct}%, transparent)`;

export const failureText = (why: PresetFailure, name = ""): string => {
  if (why === "taken") return `“${cleanName(name)}” is taken`;
  if (why === "empty") return "Give it a name";
  if (why === "long") return `${MAX_NAME} characters at most`;
  if (why === "full") return `${MAX_PRESETS} presets is the limit. Delete one first`;
  return "That preset is gone";
};

/* ------------------------------------------------------------------ glyphs */

const PATHS = {
  chev: "m6 9 6 6 6-6", plus: "M12 5v14M5 12h14", pen: "M4 20l1-4L16 5l3 3L8 19z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14", left: "m15 18-6-6 6-6", right: "m9 18 6-6-6-6",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 010 12h-3", check: "m5 12 5 5 9-10", revert: "M3 12a9 9 0 109-9M3 4v5h5",
} as const;
function Glyph({ name, size = ICON.xs }: { name: keyof typeof PATHS | "dots"; size?: number }) {
  if (name === "dots") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * Runs `place` with the element's size once it has one.
 *
 * A Portal's children are not in the document on the first layout pass, so a
 * measurement taken there reads 0 and a menu meant to hang off its anchor's
 * right edge lands at the edge instead, half off screen — which is what the
 * first render of these menus did. Polled a frame at a time until the width is
 * real, then once.
 */
function useSize(ref: { current: HTMLElement | null }, place: (w: number, h: number) => void, deps: unknown[]) {
  useEffect(() => {
    let id = 0;
    const tick = () => {
      const el = ref.current;
      if (el && el.offsetWidth > 0) place(el.offsetWidth, el.offsetHeight); else id = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Under the anchor (above it when there is no room), clamped into the window. */
function placeUnder(anchor: DOMRect, align: "left" | "right", w: number, h: number) {
  return menuUnder({ top: anchor.top, bottom: anchor.bottom, left: align === "right" ? anchor.right - w : anchor.left },
    window.innerWidth, window.innerHeight, { width: w, height: h });
}

/** The amber dot on a chip whose filter differs from what was saved, and the mark on one that names a value the board lost. */
const Dirty = () => <span aria-hidden className="shrink-0 rounded-full" style={{ width: 6, height: 6, background: "var(--warning)" }} />;
const Bang = () => <span aria-hidden className="shrink-0 text-[10px]" style={{ color: "var(--warning-ink)" }}>!</span>;

/* -------------------------------------------------------------- popup menu */

type Item =
  | { kind: "sep" }
  | { kind: "note"; key: string; node: ReactNode }
  | {
    kind: "item"; key: string; label: ReactNode; icon?: ReactNode; kbd?: string; end?: ReactNode;
    danger?: boolean; disabled?: boolean; on?: boolean; custom?: ReactNode; onSelect: () => void;
    /** Stay open after the pick (the default is to close). */
    keepOpen?: boolean;
  };

/**
 * A small menu hung off a rect. Focus goes into it on open and comes back to
 * `restoreTo` on close; arrows, Home/End and Escape work; a click anywhere
 * outside every preset menu closes it. `onItemKey` lets a caller add keys to
 * its own rows (the More list takes F2, Del and Alt+arrows) without this file
 * knowing what they mean.
 */
function PopMenu({ anchor, items, onClose, restoreTo, align = "left", minWidth = 188, onItemKey, onItemContext, label }: {
  anchor: DOMRect; items: Item[]; onClose: (restoreFocus: boolean) => void; restoreTo?: HTMLElement | null;
  align?: "left" | "right"; minWidth?: number; label: string;
  onItemKey?: (e: ReactKey, key: string) => void;
  onItemContext?: (key: string, rect: DOMRect, el: HTMLElement) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useSize(box, (w, h) => setPos(placeUnder(anchor, align, w, h)), [anchor, align]);

  const close = (focus: boolean) => { onClose(focus); if (focus) restoreTo?.focus(); };
  useCloseWithOwner(() => close(false));

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(`[${MENU_ATTR}]`)) return;
      close(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buttons = () => [...(box.current?.querySelectorAll<HTMLElement>("[data-pm-item]:not([disabled])") ?? [])];
  // Into the menu on open: the first row, so Enter does the first thing.
  useEffect(() => { if (pos) (buttons().find((b) => b.dataset.on === "1") ?? buttons()[0])?.focus(); }, [pos !== null]);

  const onKey = (e: ReactKey) => {
    if ((e.target as HTMLElement).tagName === "INPUT") {
      if (e.key === "Escape") { e.stopPropagation(); }
      return;
    }
    const bs = buttons();
    const at = bs.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); e.stopPropagation(); bs[(i + bs.length) % bs.length]?.focus(); };
    const cur = (document.activeElement as HTMLElement | null)?.dataset.pmKey;
    if (cur && onItemKey) { onItemKey(e, cur); if (e.defaultPrevented) return; }
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(bs.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") close(false);
  };

  return (
    <Portal z={MENU_Z}>
      <div ref={box} role="menu" aria-label={label} {...{ [MENU_ATTR]: "" }} onKeyDown={onKey}
        className="fixed p-1 rounded-xl flex flex-col text-[11px]"
        style={{
          top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth, visibility: pos ? "visible" : "hidden",
          ...SURFACE, boxShadow: "0 14px 32px -16px var(--shadow)",
        }}>
        {items.map((it, i) => {
          if (it.kind === "sep") return <div key={`s${i}`} className="my-1 mx-0.5" style={{ height: 1, background: "var(--surface-line)" }} />;
          if (it.kind === "note") return <div key={it.key} className="px-2 py-1 text-[10.5px]" style={{ color: "var(--text3)" }}>{it.node}</div>;
          const body = it.custom ?? (
            <>
              <span className="shrink-0 grid place-items-center" style={{ width: ICON.sm }}>{it.icon}</span>
              <span className="truncate">{it.label}</span>
              {it.kbd && <span className="ml-auto pl-3 text-[10px]" style={{ color: "var(--text4)" }}>{it.kbd}</span>}
              {it.end != null && <span className="ml-auto pl-3 text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{it.end}</span>}
            </>
          );
          const rowStyle = {
            minHeight: 28, opacity: it.disabled ? 0.45 : 1,
            color: it.danger ? "var(--error-ink)" : it.on ? "var(--text)" : "var(--text2)",
            background: it.on ? tint(12) : undefined,
          };
          /* A row being renamed holds an input, and an input inside a button is
             not valid markup (it would not take the caret either), so that row
             is a plain box until the name is settled. */
          if (it.custom) {
            return <div key={it.key} className="flex items-center gap-2 px-2 rounded-lg" style={rowStyle}>{body}</div>;
          }
          return (
            <button key={it.key} role="menuitem" data-pm-item="" data-pm-key={it.key} data-on={it.on ? "1" : undefined}
              disabled={it.disabled} onClick={() => { it.onSelect(); if (!it.keepOpen) onClose(false); restoreTo?.focus(); }}
              onContextMenu={(e) => { if (!onItemContext) return; e.preventDefault(); onItemContext(it.key, e.currentTarget.getBoundingClientRect(), e.currentTarget); }}
              className="flex items-center gap-2 px-2 rounded-lg text-left whitespace-nowrap agx-hover focus-visible:outline-none"
              style={rowStyle}>
              {body}
            </button>
          );
        })}
      </div>
    </Portal>
  );
}

/* ------------------------------------------------------------ name editing */

/**
 * A name typed in place. Enter commits, Escape keeps the old one, and leaving
 * the field commits only if what is there is good — a half-typed duplicate is
 * dropped quietly rather than saved or left stuck on screen. A refusal says why
 * under the field and keeps the focus where it was.
 */
function InlineName({ value, onCommit, onCancel, chip }: {
  value: string; onCommit: (name: string) => PresetFailure | null; onCancel: () => void; chip?: boolean;
}) {
  const [text, setText] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const commit = (): boolean => {
    if (cleanName(text) === value) { done.current = true; onCancel(); return true; }
    const why = onCommit(text);
    if (why) { setErr(failureText(why, text)); return false; }
    done.current = true;
    return true;
  };
  return (
    <span className={chip ? "relative inline-flex" : "relative inline-flex w-full"}>
      <input ref={ref} value={text} maxLength={MAX_NAME} aria-label="Preset name" aria-invalid={!!err}
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); }
        }}
        onBlur={() => { if (done.current) return; if (!commit()) onCancel(); }}
        className="text-[11.5px] px-2 rounded-lg outline-none"
        style={{
          height: chip ? 26 : 22, width: chip ? `${Math.max(8, text.length + 3)}ch` : "100%", minWidth: 0,
          background: "var(--surface-inset)", color: "var(--text)",
          border: EDGE, borderColor: err ? ERR_EDGE : undefined,
        }} />
      {err && (
        <span role="alert" className="absolute left-0 top-full mt-1 px-2.5 py-1 rounded-lg text-[10.5px] whitespace-nowrap z-10"
          style={{ ...SURFACE, color: "var(--error-ink)", boxShadow: "0 14px 32px -16px var(--shadow)" }}>
          {err}. Esc keeps “{value}”.
        </span>
      )}
    </span>
  );
}

/* --------------------------------------------------------------- save popup */

function SavePopover({ anchor, initial, keeps, onSave, onCancel }: {
  anchor: DOMRect; initial: string; keeps: string; onSave: (name: string) => PresetFailure | null; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useSize(box, (w, h) => setAt(placeUnder(anchor, "right", w, h)), [anchor]);
  // Once placed, not at mount: the input is not in the document before that.
  const placed = at !== null;
  useEffect(() => { if (placed) { input.current?.focus(); input.current?.select(); } }, [placed]);
  useCloseWithOwner(onCancel);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || (e.target as Element).closest?.(`[${MENU_ATTR}]`)) return;
      onCancel();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onCancel]);
  const save = () => { const why = onSave(text); if (why) setErr(failureText(why, text)); };
  return (
    <Portal z={MENU_Z}>
      <div ref={box} role="dialog" aria-label="Save filter set" {...{ [MENU_ATTR]: "" }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="fixed rounded-xl p-2.5 flex flex-col gap-1.5"
        style={{
          top: at?.top ?? -9999, left: at?.left ?? -9999, width: 300, visibility: at ? "visible" : "hidden",
          ...SURFACE, boxShadow: "0 22px 48px -20px var(--shadow)",
        }}>
        <span className="flex items-center text-[10px]" style={{ color: "var(--text4)" }}>
          <span className="tracking-[0.04em]">NAME THIS FILTER SET</span>
          <span className="ml-auto tabular-nums">{text.length}/{MAX_NAME}</span>
        </span>
        <input ref={input} value={text} maxLength={MAX_NAME} spellCheck={false} aria-label="Name"
          aria-invalid={!!err}
          onChange={(e) => { setText(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
          className={`${INPUT} w-full`} style={{ ...INPUT_STYLE, borderColor: err ? ERR_EDGE : undefined }} />
        {err
          ? <span role="alert" className="text-[10.5px]" style={{ color: "var(--error-ink)" }}>{err}</span>
          : <span className="text-[10.5px] break-words" style={{ color: "var(--text3)" }}>Keeps: {keeps}</span>}
        <span className="flex items-center justify-end gap-1.5 pt-0.5">
          <button onClick={onCancel} className="text-[11.5px] px-2 py-1 rounded-lg agx-hover" style={{ border: EDGE, color: "var(--text2)" }}>Cancel</button>
          <button onClick={save} className="text-[11.5px] px-2 py-1 rounded-lg flex items-center gap-1.5"
            style={{ border: EDGE, ...chipTone(true) }}>
            Save <span className="text-[9.5px] px-1 rounded" style={{ border: EDGE, color: "var(--text3)" }}>{"↵"}</span>
          </button>
        </span>
      </div>
    </Portal>
  );
}

/* -------------------------------------------------------------- undo toast */

function UndoToast({ name, anchor, onUndo }: { name: string; anchor: HTMLElement | null; onUndo: () => void }) {
  // Where the row starts, read once: a toast that follows the row around would be a second thing to keep still.
  const [left] = useState(() => Math.max(16, Math.round(anchor?.getBoundingClientRect().left ?? 16)));
  const bar = useRef<HTMLSpanElement>(null);
  // The remaining time as a line that runs out. A transition set a frame after
  // mount, not a keyframe: this file brings no stylesheet of its own.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.style.width = "0%"; });
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <Portal z={MENU_Z}>
      <div role="status" className="fixed flex items-center gap-3 px-3 rounded-lg text-[11px] overflow-hidden"
        style={{
          left, bottom: 16, height: 34, background: "var(--text)", color: "var(--bg)",
          boxShadow: "0 12px 28px -12px var(--shadow)",
        }}>
        <span className="truncate" style={{ maxWidth: 260 }}>Deleted {"“"}{name}{"”"}</span>
        <button onClick={onUndo} className="font-semibold underline underline-offset-2">Undo</button>
        <span ref={bar} aria-hidden className="absolute left-0 bottom-0 motion-reduce:hidden"
          style={{ height: 2, width: "100%", background: "color-mix(in srgb, var(--bg) 70%, transparent)", transition: `width ${UNDO_MS}ms linear` }} />
      </div>
    </Portal>
  );
}

/* ------------------------------------------------------------- the row */

export const FilterPresets = memo(function FilterPresets({ api, counts, rules, fields, hotkeys, onEditRule }: {
  api: PresetsApi;
  /** Cards each preset would show, from the board's own filter. */
  counts: Record<string, number>;
  rules: FilterSet;
  fields: FieldSpec[];
  /** Whether Alt+1..9 is live (the panel is on screen). */
  hotkeys: boolean;
  /** Open the rule builder on this preset's rules (it has been applied first). */
  onEditRule: (id: string) => void;
}) {
  const { presets, activeId, active, modified, gone } = api;
  const root = useRef<HTMLDivElement>(null);
  const saveBtn = useRef<HTMLButtonElement>(null);
  const chipEls = useRef<Record<string, HTMLElement | null>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [more, setMore] = useState<{ anchor: DOMRect } | null>(null);
  const [ctx, setCtx] = useState<{ id: string; anchor: DOMRect; restoreTo: HTMLElement | null } | null>(null);
  const [saveMenu, setSaveMenu] = useState<{ anchor: DOMRect } | null>(null);
  const [naming, setNaming] = useState<{ anchor: DOMRect; initial: string } | null>(null);
  // After a move, a rename or a delete the element that had focus may be gone
  // or in a different list; this says where focus goes once the new row has
  // rendered: a preset id (chip, or More when it is hidden), "menu:<id>" for a
  // row inside the open More menu, or "save" when no chip is left to take it.
  const pendingFocus = useRef<string | null>(null);

  const visible = presets.slice(0, VISIBLE_CHIPS);
  const hidden = presets.slice(VISIBLE_CHIPS);
  const activeHidden = hidden.find((p) => p.id === activeId) ?? null;
  const order = [...visible.map((p) => p.id), ...(hidden.length ? [MORE] : [])];
  const tabStop = [focusId, activeId].find((i) => i && order.includes(i)) ?? order[0];
  const live = liveCount(rules);
  const summaries = useMemo(() => new Map(presets.map((p) => [p.id, summarizeRules(p.join, p.rules, fields)])), [presets, fields]);

  const focusEl = (id: string) => chipEls.current[id]?.focus();
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    pendingFocus.current = null;
    if (want === "save") { saveBtn.current?.focus(); return; }
    if (want.startsWith("menu:")) {
      document.querySelector<HTMLElement>(`[${MENU_ATTR}] [data-pm-key="${want.slice(5)}"]`)?.focus();
      return;
    }
    focusEl(order.includes(want) ? want : hidden.some((p) => p.id === want) ? MORE : order[0] ?? "");
  });

  // Alt+1..9: the nth preset, from anywhere on the panel but a text field.
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const p = nthPreset(presets, Number(m[1]));
      if (!p) return;
      e.preventDefault();
      api.apply(p.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hotkeys, presets, api]);

  const nameOf = (id: string) => presets.find((p) => p.id === id)?.name ?? "";
  const full = !canAdd(presets);

  const openCtx = (id: string, el: HTMLElement, restoreTo: HTMLElement | null = el) =>
    setCtx({ id, anchor: el.getBoundingClientRect(), restoreTo });

  const isHidden = (id: string) => hidden.some((p) => p.id === id);
  // A hidden preset is renamed in its row inside More, so More stays open for it.
  const startRename = (id: string) => { if (!isHidden(id)) setMore(null); setRenaming(id); };
  const commitRename = (id: string, name: string) => {
    const why = api.rename(id, name);
    if (!why) { setRenaming(null); pendingFocus.current = isHidden(id) ? `menu:${id}` : id; }
    return why;
  };
  const cancelRename = (id: string) => { setRenaming(null); pendingFocus.current = isHidden(id) ? `menu:${id}` : id; };
  const doDelete = (id: string) => {
    const inMenu = isHidden(id);
    const list = inMenu ? hidden : presets;
    const i = list.findIndex((p) => p.id === id);
    const nb = list[i + 1] ?? list[i - 1];
    pendingFocus.current = nb ? (inMenu ? `menu:${nb.id}` : nb.id) : inMenu ? null : "save";
    api.remove(id);
  };
  const doMove = (id: string, dir: -1 | 1) => { pendingFocus.current = isHidden(id) ? `menu:${id}` : id; api.move(id, dir); };

  /* ---- keys on the row ---- */
  const onRowKey = (e: ReactKey) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-chip]");
    if (!el || !root.current?.contains(el) || (e.target as HTMLElement).tagName === "INPUT") return;
    const id = el.dataset.chip!;
    const at = order.indexOf(id);
    const isPreset = id !== MORE;
    const step = (to: number) => { e.preventDefault(); const t = order[Math.max(0, Math.min(order.length - 1, to))]; setFocusId(t); focusEl(t); };
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && isPreset) {
      e.preventDefault(); doMove(id, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "ArrowLeft" && !e.altKey) step(at - 1);
    else if (e.key === "ArrowRight" && !e.altKey) step(at + 1);
    else if (e.key === "Home") step(0);
    else if (e.key === "End") step(order.length - 1);
    else if (e.key === "F2" && isPreset) { e.preventDefault(); startRename(id); }
    else if (e.key === "Delete" && isPreset) { e.preventDefault(); doDelete(id); }
    else if (isMenuKey(e) && isPreset) { e.preventDefault(); openCtx(id, el); }
  };

  /* ---- ⌘S updates the preset that is on; ⌘Z takes a delete back ---- */
  const onRootKey = (e: ReactKey) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "s" && modified) { e.preventDefault(); e.stopPropagation(); api.update(); }
    else if (k === "z" && api.undo && !(e.target as HTMLElement).closest?.("input,textarea")) { e.preventDefault(); e.stopPropagation(); api.restore(); }
  };

  /* ---- one chip ---- */
  const chip = (p: Preset) => {
    const on = p.id === activeId;
    const g = gone[p.id];
    const n = counts[p.id] ?? 0;
    const dirty = on && modified;
    if (renaming === p.id) {
      return (
        <span key={p.id} data-chip={p.id} className="inline-flex">
          <InlineName chip value={p.name}
            onCommit={(name) => commitRename(p.id, name)}
            onCancel={() => cancelRename(p.id)} />
        </span>
      );
    }
    return (
      <span key={p.id} className="relative inline-flex group shrink-0">
        <button ref={(el) => { chipEls.current[p.id] = el; }} data-chip={p.id}
          tabIndex={tabStop === p.id ? 0 : -1} aria-pressed={on}
          onFocus={() => setFocusId(p.id)}
          onClick={() => api.apply(p.id)}
          onContextMenu={(e) => { e.preventDefault(); openCtx(p.id, e.currentTarget); }}
          title={`${p.name}: ${summaries.get(p.id)}`}
          aria-label={`${p.name}, ${n} ${n === 1 ? "card" : "cards"}${dirty ? ", changed since saved" : ""}${g ? ", a value is missing" : ""}`}
          className="text-[11.5px] pl-2 pr-2 py-1 rounded-lg flex items-center gap-1.5 whitespace-nowrap agx-btn"
          style={{ border: EDGE, ...chipTone(on), color: on ? "var(--text)" : "var(--text2)" }}>
          <span className="truncate" style={{ maxWidth: 140 }}>{p.name}</span>
          {dirty && <Dirty />}
          {g && <Bang />}
          {/* The number, and the dots that take its place under the pointer: one
              slot, so the chip is the same width hovered or not. */}
          <span aria-hidden className="tabular-nums text-[10px] text-right shrink-0 group-hover:opacity-0"
            style={{ minWidth: ICON.xs, color: on ? "var(--primary-ink)" : "var(--text4)" }}>{n}</span>
        </button>
        <button tabIndex={-1} aria-label={`Menu for ${p.name}`} title="Rename, move, delete" {...{ [MENU_ATTR]: "" }}
          onClick={(e) => (ctx?.id === p.id ? setCtx(null) : openCtx(p.id, chipEls.current[p.id] ?? e.currentTarget, e.currentTarget))}
          className="absolute right-1 top-1/2 -translate-y-1/2 grid place-items-center rounded opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
          style={{ width: 18, height: 18, color: "var(--text3)" }}>
          <Glyph name="dots" />
        </button>
      </span>
    );
  };

  /* ---- the menus ---- */
  const chipMenuItems = (id: string): Item[] => {
    const i = presets.findIndex((p) => p.id === id);
    const g = gone[id];
    const items: Item[] = [];
    if (g?.length) {
      items.push({ kind: "note", key: "gone", node: <GoneNote gone={g} /> });
      items.push({ kind: "item", key: "edit", label: "Edit rule", icon: <Glyph name="pen" />, onSelect: () => onEditRule(id) });
      // Every value of the last rule gone: removing them would leave a preset
      // that filters nothing, so it is Edit rule or Delete, not this.
      const emptied = dropGone(presets[i].rules, fields).length === 0;
      items.push({ kind: "item", key: "drop", label: "Remove the missing value", icon: <Glyph name="trash" />, disabled: emptied, end: emptied ? "its only rule" : undefined, onSelect: () => api.removeGone(id) });
      items.push({ kind: "sep" });
    }
    items.push(
      { kind: "item", key: "rename", label: "Rename", icon: <Glyph name="pen" />, kbd: "F2", onSelect: () => startRename(id) },
      { kind: "item", key: "left", label: "Move left", icon: <Glyph name="left" />, kbd: "Alt ←", disabled: i <= 0, onSelect: () => doMove(id, -1) },
      { kind: "item", key: "right", label: "Move right", icon: <Glyph name="right" />, kbd: "Alt →", disabled: i >= presets.length - 1, onSelect: () => doMove(id, 1) },
      { kind: "sep" },
      { kind: "item", key: "delete", label: "Delete", icon: <Glyph name="trash" />, kbd: "Del", danger: true, onSelect: () => doDelete(id) },
    );
    return items;
  };

  const moreItems = (): Item[] => [
    ...hidden.map((p): Item => ({
      kind: "item", key: p.id, on: p.id === activeId,
      icon: p.id === activeId ? <Glyph name="check" /> : null,
      label: (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{p.name}</span>
          {p.id === activeId && modified && <Dirty />}
          {gone[p.id] && <Bang />}
        </span>
      ),
      end: counts[p.id] ?? 0,
      custom: renaming === p.id
        ? <InlineName value={p.name} onCommit={(name) => commitRename(p.id, name)}
            onCancel={() => cancelRename(p.id)} />
        : undefined,
      onSelect: () => api.apply(p.id),
    })),
    { kind: "sep" },
    { kind: "note", key: "hint", node: "Right-click a row, or F2 rename · Del delete · Alt ↑↓ move" },
  ];

  const onMoreKey = (e: ReactKey, key: string) => {
    if (!presets.some((p) => p.id === key)) return;
    if (e.key === "F2") { e.preventDefault(); setRenaming(key); }
    else if (e.key === "Delete") { e.preventDefault(); doDelete(key); }
    else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); doMove(key, e.key === "ArrowUp" ? -1 : 1); }
    else if (isMenuKey(e)) {
      e.preventDefault();
      const el = document.activeElement as HTMLElement;
      openCtx(key, el, el);
    }
  };

  const saveBlockedBy = live === 0 ? "Build a filter first, then save it here"
    : active && !modified ? `Nothing has changed since “${active.name}”`
    : !active && full ? `${MAX_PRESETS} presets is the limit. Delete one to save another`
    : null;

  const clickSave = () => {
    const r = saveBtn.current?.getBoundingClientRect();
    if (!r) return;
    if (saveMenu || naming) { setSaveMenu(null); setNaming(null); return; }
    if (modified) setSaveMenu({ anchor: r });
    else setNaming({ anchor: r, initial: "" });
  };

  return (
    <div ref={root} onKeyDown={onRootKey} role="toolbar" aria-label="Filter presets"
      className="flex items-start gap-1 min-w-0" style={{ flex: "1 1 auto" }}>
      {/* The chips, or one line that says what they will be. */}
      <div role="group" aria-label="Saved filter sets" onKeyDown={onRowKey} className="flex flex-wrap items-center gap-1 min-w-0">
        {presets.length === 0 ? (
          <span className="text-[10.5px] ml-1.5 py-1.5" style={{ color: "var(--text3)" }}>
            Build a filter, then <b style={{ color: "var(--text2)", fontWeight: 600 }}>Save</b>: it becomes a one-click chip here.
          </span>
        ) : visible.map(chip)}
        {hidden.length > 0 && (
          <button ref={(el) => { chipEls.current[MORE] = el; }} data-chip={MORE} {...{ [MENU_ATTR]: "" }}
            tabIndex={tabStop === MORE ? 0 : -1} aria-haspopup="menu" aria-expanded={!!more} aria-pressed={!!activeHidden}
            onFocus={() => setFocusId(MORE)}
            onClick={(e) => setMore(more ? null : { anchor: e.currentTarget.getBoundingClientRect() })}
            title={activeHidden ? `${activeHidden.name} is on` : `${hidden.length} more saved filter sets`}
            className="text-[11.5px] px-2 py-1 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 agx-btn"
            style={{ border: EDGE, ...chipTone(!!activeHidden), color: activeHidden ? "var(--text)" : "var(--text2)" }}>
            <span className="truncate" style={{ maxWidth: 140 }}>{activeHidden ? activeHidden.name : "More"}</span>
            {activeHidden && modified && <Dirty />}
            {!activeHidden && <span aria-hidden className="tabular-nums text-[10px]" style={{ color: "var(--text4)" }}>{hidden.length}</span>}
            <Glyph name="chev" />
          </button>
        )}
      </div>

      <span className="flex-1" />

      {/* Fixed at the right end: the same place whatever else changes. */}
      <button ref={saveBtn} onClick={clickSave} disabled={!!saveBlockedBy} {...{ [MENU_ATTR]: "" }}
        aria-haspopup={modified ? "menu" : "dialog"}
        title={saveBlockedBy ?? (modified ? `Update “${active?.name}”, or save as a new one` : "Save these filters as a one-click chip")}
        className="text-[11.5px] px-2 py-1 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0 agx-btn"
        style={{
          border: EDGE, ...chipTone(!!modified),
          color: modified ? "var(--text)" : "var(--text2)",
          opacity: saveBlockedBy ? 0.45 : 1,
        }}>
        <span>Save</span><Glyph name="chev" />
      </button>

      {/* Only while it has something to list: the last hidden preset going (deleted,
          or moved up into the row) takes the button, and a menu must not outlive it. */}
      {more && hidden.length > 0 && (
        <PopMenu label="More saved filter sets" anchor={more.anchor} items={moreItems()} minWidth={250}
          restoreTo={chipEls.current[MORE]} onClose={() => { setMore(null); setRenaming(null); }}
          onItemKey={onMoreKey}
          onItemContext={(key, _r, el) => openCtx(key, el, el)} />
      )}
      {ctx && (
        <PopMenu label={`${nameOf(ctx.id)} menu`} anchor={ctx.anchor} items={chipMenuItems(ctx.id)} minWidth={ctx.anchor.width > 200 ? ctx.anchor.width : 220}
          restoreTo={ctx.restoreTo} onClose={() => setCtx(null)} />
      )}
      {saveMenu && active && (
        <PopMenu label="Save" anchor={saveMenu.anchor} align="right" minWidth={240} restoreTo={saveBtn.current}
          onClose={() => setSaveMenu(null)}
          items={[
            { kind: "item", key: "update", label: `Update “${active.name}”`, icon: <Glyph name="revert" />, kbd: "⌘S", onSelect: () => api.update() },
            { kind: "item", key: "new", label: "Save as new…", icon: <Glyph name="plus" />, disabled: full,
              end: full ? "limit" : undefined,
              onSelect: () => setNaming({ anchor: saveMenu.anchor, initial: freeName(active.name, presets) }) },
            { kind: "item", key: "revert", label: "Revert to saved", icon: <Glyph name="undo" />, onSelect: () => api.revert() },
          ]} />
      )}
      {naming && (
        <SavePopover anchor={naming.anchor} initial={naming.initial} keeps={summarizeRules(rules.join, rulesToPreset(rules), fields)}
          onSave={(name) => { const why = api.saveNew(name); if (!why) { setNaming(null); saveBtn.current?.focus(); } return why; }}
          onCancel={() => { setNaming(null); saveBtn.current?.focus(); }} />
      )}
      {api.undo && <UndoToast key={api.undo.id} name={api.undo.name} anchor={root.current} onUndo={api.restore} />}
    </div>
  );
});

function GoneNote({ gone }: { gone: Gone[] }) {
  const g = gone[0];
  const more = gone.length - 1;
  return (
    <span className="flex items-start gap-2" style={{ color: "var(--text2)" }}>
      <span style={{ color: "var(--warning-ink)" }}>!</span>
      <span style={{ whiteSpace: "normal", maxWidth: 260 }}>
        {g.fieldLabel} {"“"}{g.value}{"”"} is not on this board any more{more > 0 ? `, and ${more} more` : ""}.
      </span>
    </span>
  );
}

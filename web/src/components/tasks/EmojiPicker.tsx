/*
 * The emoji popover on the card composer's toolbar.
 *
 * Search on top, a "Frequently used" row, then a section per category with the
 * category strip along the bottom — the same shape ClickUp's own box has, so a
 * hand that knows one knows the other. What it inserts is the character, so the
 * comment goes to ClickUp as text and needs nothing on the way out.
 *
 * Focus stays in the search field the whole time it is open and the highlighted
 * cell is announced through aria-activedescendant, which is what lets you type
 * to filter AND walk the grid without a Tab in between. It is drawn through a
 * portal against the viewport (placement in emojiData.ts), because the pane the
 * composer sits in clips whatever is drawn inside it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LAYER } from "../../lib/layers.ts";
import { CATEGORIES, EMOJI, emojiOf, moveInGrid, popoverPlace, searchEmoji, type Anchor } from "../../lib/emojiData.ts";
import { ICON, HIT } from "../../lib/iconSize.ts";
import { Portal } from "../Portal.tsx";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../workspace/Chrome.tsx";

const COLS = 8;
const WIDTH = 252;
const HEIGHT = 330;

interface Section { key: string; label: string; chars: string[] }

export function EmojiPicker({ anchor, recent, onPick, onClose }: {
  /** The button that opened it: the popover is placed against it, and a press
   *  on it is the button's to handle rather than an "outside click". */
  anchor: HTMLElement;
  recent: string[];
  /** `keep` is Shift held: add another instead of closing. */
  onPick: (char: string, keep: boolean) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState({ r: 0, c: 0 });
  const [tab, setTab] = useState("recent");
  const [place, setPlace] = useState<{ left: number; top: number; height: number } | null>(null);

  const sections: Section[] = useMemo(() => {
    if (q.trim()) return [{ key: "found", label: "Search results", chars: searchEmoji(q).map((e) => e.char) }];
    return [
      { key: "recent", label: "Frequently used", chars: recent.filter((c) => emojiOf(c)) },
      ...CATEGORIES.map((c) => ({ key: c.id, label: c.label, chars: EMOJI.filter((e) => e.cat === c.id).map((e) => e.char) })),
    ];
  }, [q, recent]);

  const rows = useMemo(() => sections.flatMap((s) => {
    const out: { key: string; chars: string[] }[] = [];
    for (let i = 0; i < s.chars.length; i += COLS) out.push({ key: `${s.key}-${i}`, chars: s.chars.slice(i, i + COLS) });
    return out;
  }), [sections]);
  const lens = useMemo(() => rows.map((r) => r.chars.length), [rows]);
  const cur = rows[at.r]?.chars[at.c];
  const cellId = (r: number, c: number) => `agx-emoji-${r}-${c}`;

  /* Measured on open and again when the window moves under it. */
  useLayoutEffect(() => {
    const put = () => {
      const r = anchor.getBoundingClientRect();
      const a: Anchor = { left: r.left, top: r.top, bottom: r.bottom, right: r.right };
      setPlace(popoverPlace(a, { width: WIDTH, height: HEIGHT }, { width: window.innerWidth, height: window.innerHeight }));
    };
    put();
    window.addEventListener("resize", put);
    window.addEventListener("scroll", put, true);
    return () => { window.removeEventListener("resize", put); window.removeEventListener("scroll", put, true); };
  }, [anchor]);

  useEffect(() => { root.current?.querySelector("input")?.focus(); }, [place !== null]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (root.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    // Capture: the app binds Escape to close the card behind, and one press
    // must close only the popover.
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);

  useEffect(() => { setAt({ r: 0, c: 0 }); }, [q]);
  useEffect(() => {
    document.getElementById(cellId(at.r, at.c))?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const jump = (key: string) => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`[data-section="${key}"]`);
    if (sc && el) sc.scrollTo({ top: el.offsetTop - sc.offsetTop });
  };
  const spy = () => {
    const sc = scroller.current;
    if (!sc || q.trim()) return;
    let on = sections[0]!.key;
    for (const el of sc.querySelectorAll<HTMLElement>("[data-section]")) if (el.offsetTop - sc.offsetTop <= sc.scrollTop + 4) on = el.dataset.section!;
    setTab(on);
  };

  if (typeof document === "undefined") return null;
  let rIndex = -1;
  return (
    <Portal z={LAYER.menu}>
      <div ref={root} role="dialog" aria-label="Emoji picker" data-emoji-picker
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          position: "fixed", left: place?.left ?? 0, top: place?.top ?? 0, width: WIDTH, height: place?.height ?? HEIGHT,
          visibility: place ? "visible" : "hidden",
          background: "var(--surface-card)", border: EDGE,
        }}>
        <div className="p-2" style={{ borderBottom: LINE }}>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search emoji"
            role="combobox" aria-expanded="true" aria-controls="agx-emoji-grid" aria-haspopup="grid"
            aria-activedescendant={cur ? cellId(at.r, at.c) : undefined}
            autoComplete="off" spellCheck={false}
            onKeyDown={(e) => {
              if (e.key.startsWith("Arrow")) { e.preventDefault(); setAt((p) => moveInGrid(lens, p, e.key)); return; }
              if (e.key === "Enter") { e.preventDefault(); if (cur) onPick(cur, e.shiftKey); }
            }}
            className={`${INPUT} w-full`} style={INPUT_STYLE} />
        </div>

        <div ref={scroller} onScroll={spy} className="flex-1 min-h-0 overflow-y-auto agx-scroll px-2 pb-2"
          role="grid" id="agx-emoji-grid" aria-label={q.trim() ? "Search results" : "Emoji"}>
          {!rows.length && <div className="px-1 py-6 text-center text-[11px]" style={{ color: "var(--text3)" }}>No emoji match that.</div>}
          {sections.map((s) => s.chars.length > 0 && (
            <div key={s.key} data-section={s.key}>
              <div className="pt-2.5 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>{s.label}</div>
              {Array.from({ length: Math.ceil(s.chars.length / COLS) }, (_, k) => {
                const r = ++rIndex;
                return (
                  <div key={k} role="row" className="flex">
                    {s.chars.slice(k * COLS, k * COLS + COLS).map((ch, c) => {
                      const on = r === at.r && c === at.c;
                      return (
                        <button key={ch} id={cellId(r, c)} type="button" role="gridcell" tabIndex={-1} aria-selected={on}
                          title={emojiOf(ch)?.words[0]?.replace(/_/g, " ")}
                          aria-label={emojiOf(ch)?.words[0]?.replace(/_/g, " ")}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setAt({ r, c })}
                          onClick={(e) => onPick(ch, e.shiftKey)}
                          className="grid place-items-center rounded-lg"
                          style={{
                            width: HIT, height: HIT, fontSize: ICON.lg,
                            background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                          }}>
                          {ch}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div role="tablist" aria-label="Categories" className="flex justify-between px-1.5 py-1" style={{ borderTop: LINE }}>
          {[{ id: "recent", label: "Frequently used", icon: "🕘" }, ...CATEGORIES].map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={!q.trim() && tab === c.id} title={c.label} aria-label={c.label}
              disabled={!!q.trim()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setTab(c.id); jump(c.id); }}
              className="agx-btn grid place-items-center rounded-lg"
              style={{
                width: HIT - 1, height: HIT - 4, fontSize: ICON.sm,
                opacity: !q.trim() && tab === c.id ? 1 : 0.55,
                background: !q.trim() && tab === c.id ? "color-mix(in srgb, var(--text) 10%, transparent)" : "transparent",
              }}>
              {c.icon}
            </button>
          ))}
        </div>
      </div>
    </Portal>
  );
}

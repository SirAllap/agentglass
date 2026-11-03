/*
 * THE PLUCK PALETTE — what is on the screen, lettered, one key to take it.
 *
 * Opened with the pluck chord over a pane. Lists the paths, links, hashes,
 * ids and refs on the visible screen, newest first, each with a letter: press
 * the letter and the token is written into the pane as one paste (the agent
 * said a path; you say it back); Shift+letter copies it instead; Escape
 * closes. It floats at the pane's bottom-left, where the eye already is after
 * reading the screen, and Find takes the top-right corner: neither covers the
 * strip above the pane, so every strip button stays reachable.
 */
import { useEffect, useMemo } from "react";
import { LAYER } from "../../lib/layers.ts";
import { pluckTokens, PLUCK_KEYS, type Pluck, type PluckKind } from "../../lib/pluck.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";

const KIND_TONE: Record<PluckKind, string> = {
  path: "var(--primary)", url: "var(--info, var(--primary))", hash: "var(--warning)", uuid: "var(--text3)", ref: "var(--success)", card: "var(--info, var(--primary))",
};
const KIND_WORD: Record<PluckKind, string> = { path: "path", url: "link", hash: "hash", uuid: "id", ref: "ref", card: "card" };

export function PluckPalette({ rows, onPick, onCopy, onClose }: {
  rows: { text: string; wrapped: boolean }[];
  onPick: (token: string) => void;
  onCopy: (token: string) => void;
  onClose: () => void;
}) {
  const items = useMemo(() => pluckTokens(rows), [rows]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const i = PLUCK_KEYS.indexOf(k);
      if (i < 0 || i >= items.length) return;
      e.preventDefault(); e.stopPropagation();
      const t = items[i]!.text;
      if (e.shiftKey) onCopy(t); else onPick(t);
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items, onPick, onCopy, onClose]);

  return (
    <div data-pluck className="absolute flex flex-col rounded-lg agx-menu overflow-hidden"
      style={{ left: 10, bottom: 12, zIndex: LAYER.pane, width: "min(460px, calc(100% - 20px))", maxHeight: "min(70%, 520px)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
      role="listbox" aria-label="Things on the screen you can take">
      <div className="flex items-baseline gap-2 px-3 py-2" style={{ borderBottom: LINE }}>
        <span className="shrink-0 whitespace-nowrap text-[11.5px] font-medium" style={{ color: "var(--text)" }}>On the screen</span>
        <span className="min-w-0 truncate text-[10.5px]" style={{ color: "var(--text4)" }}>letter pastes · Shift+letter copies · Esc</span>
        <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-3 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing on the screen looks like a path, a link, a hash or an id.</div>
      ) : (
        <div className="overflow-y-auto agx-scroll py-1">
          {items.map((it: Pluck, i) => (
            <div key={it.text} role="option" className="agx-mi flex items-center gap-2.5 px-3 py-1 text-[11.5px] cursor-pointer"
              onClick={(e) => { if (e.shiftKey) onCopy(it.text); else onPick(it.text); onClose(); }}
              title={`${it.text}\nrow ${it.row + 1} · click to paste, Shift+click to copy`}>
              <kbd className="shrink-0 grid place-items-center rounded font-mono text-[10.5px]"
                style={{ width: 20, height: 20, color: "var(--text)", background: "color-mix(in srgb, var(--text) 8%, transparent)", border: EDGE }}>{PLUCK_KEYS[i]}</kbd>
              <span className="shrink-0 text-[9px] uppercase tracking-[0.1em] w-8" style={{ color: KIND_TONE[it.kind] }}>{KIND_WORD[it.kind]}</span>
              <span className="min-w-0 truncate font-mono" style={{ color: "var(--text)" }}>{it.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

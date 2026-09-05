/*
 * THE PLUCK PALETTE — what is on the screen, lettered, one key to take it.
 *
 * Opened with the pluck chord over a pane. Lists the paths, links, hashes,
 * ids and refs on the visible screen, newest first, each with a letter: press
 * the letter and the token is written into the pane as one paste (the agent
 * said a path; you say it back); Shift+letter copies it instead; Escape
 * closes. The same surface as the find bar, in the same corner, so the pane
 * has one vocabulary of floating things.
 */
import { useEffect, useMemo } from "react";
import { pluckTokens, PLUCK_KEYS, type Pluck, type PluckKind } from "../../lib/pluck.ts";

const KIND_TONE: Record<PluckKind, string> = {
  path: "var(--primary)", url: "var(--info, var(--primary))", hash: "var(--warning)", uuid: "var(--text3)", ref: "var(--success)",
};
const KIND_WORD: Record<PluckKind, string> = { path: "path", url: "link", hash: "hash", uuid: "id", ref: "ref" };

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
    <div data-pluck className="absolute z-30 flex flex-col rounded-lg agx-menu overflow-hidden"
      style={{ top: 8, right: 12, width: "min(560px, calc(100% - 24px))", maxHeight: "min(70%, 520px)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
      role="listbox" aria-label="Things on the screen you can take">
      <div className="flex items-baseline gap-2 px-3 py-2" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 10%, transparent)" }}>
        <span className="text-[11.5px] font-medium" style={{ color: "var(--text)" }}>On the screen</span>
        <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>letter pastes into the pane · Shift+letter copies · Esc</span>
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
                style={{ width: 20, height: 20, color: "var(--text)", background: "color-mix(in srgb, var(--text) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}>{PLUCK_KEYS[i]}</kbd>
              <span className="shrink-0 text-[9px] uppercase tracking-[0.1em] w-8" style={{ color: KIND_TONE[it.kind] }}>{KIND_WORD[it.kind]}</span>
              <span className="min-w-0 truncate font-mono" style={{ color: "var(--text)" }}>{it.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

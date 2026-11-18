// Draws the "Saved · Undo" toast. Mount once, beside the Settings sheet.
// Reuses the app's Portal and the pill look of ZoomToast; sits above the
// Settings layer, which is where a save happens.
import { useEffect, useSyncExternalStore } from "react";
import { Portal } from "../../Portal.tsx";
import { LAYER } from "../../../lib/layers.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { getSaveToast, subscribeSaveToast, undoSaveToast } from "./saveToasts.ts";

export function SaveToastHost() {
  const t = useSyncExternalStore(subscribeSaveToast, getSaveToast, getSaveToast);
  // Undo is also on Ctrl/Cmd+Z while the toast is up, so a keyboard user need not tab to the far end of the page.
  useEffect(() => {
    if (!t) return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !(el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName)))) { e.preventDefault(); undoSaveToast(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [t]);
  if (!t) return null;
  return (
    <Portal z={LAYER.settings + 10}>
      <div
        role="status"
        aria-live="polite"
        className="fixed left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2 rounded-full"
        style={{
          bottom: "9vh",
          background: "var(--surface-2, var(--bg))",
          border: EDGE,
          boxShadow: "0 18px 40px -18px var(--shadow)",
        }}
      >
        <span className="text-[12px]" style={{ color: "var(--text)" }}>{t.message} ·</span>
        <button
          type="button"
          onClick={undoSaveToast}
          aria-keyshortcuts="Control+Z Meta+Z"
          className="text-[12px] font-medium"
          style={{ color: "var(--primary)" }}
        >
          Undo
        </button>
      </div>
    </Portal>
  );
}

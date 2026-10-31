import { Portal } from "../Portal.tsx";
import { LAYER } from "../../lib/layers.ts";

/** The panel's flash message. `floating` is for when the view is not on screen
 *  and the message has to draw over the one that is. */
export function GitToast({ toast, floating }: { toast: { ok: boolean; msg: string }; floating?: boolean }) {
  const c = toast.ok ? "success" : "error";
  // In the panel it rides above the dock and the key bar (bottom-20): at bottom-4 it sat on the
  // dock's buttons for the seconds after a press, measured by elementFromPoint in the press run.
  const el = (
    <div className={`${floating ? "fixed bottom-4" : "absolute bottom-20"} left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg text-[11px] shadow-xl`}
      style={{ zIndex: floating ? LAYER.palette : 40, background: "var(--bg3)", border: `1px solid color-mix(in srgb, var(--${c}) 50%, transparent)`, color: `var(--${c})` }}>{toast.msg}</div>
  );
  return floating ? <Portal z={LAYER.palette}>{el}</Portal> : el;
}

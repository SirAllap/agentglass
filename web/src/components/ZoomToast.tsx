// What just got bigger, and how big it is now.
//
// The gesture is the same for two targets — Ctrl+/Ctrl− over a terminal sizes
// the terminal, anywhere else it sizes the window — and without this you would
// have to guess which one you had just changed. It says both: what, and the
// number, so you can stop at the size you wanted instead of overshooting and
// coming back.
//
// It is deliberately not a notification: no queue, no history, no dismiss. One
// pill, replaced by the next zoom, gone a moment after you stop.
import { useEffect, useState } from "react";
import { Portal } from "./Portal.tsx";
import type { ZoomResult } from "../lib/zoomTarget.ts";

/** Long enough to read at a glance, short enough that holding the key down
 *  reads as one continuous adjustment rather than a stack of toasts. */
const HOLD_MS = 1100;

export function ZoomToast({ zoom }: { zoom: (ZoomResult & { n: number }) | null }) {
  const [shown, setShown] = useState<(ZoomResult & { n: number }) | null>(null);

  useEffect(() => {
    if (!zoom) return;
    setShown(zoom);
    const id = setTimeout(() => setShown(null), HOLD_MS);
    // Keyed on `n`, which increments per press — so holding Ctrl+ restarts the
    // timer instead of letting the first one expire mid-adjustment.
    return () => clearTimeout(id);
  }, [zoom]);

  if (!shown) return null;
  return (
    <Portal z={10060}>
      <div
        className="fixed left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-2 rounded-full pointer-events-none"
        style={{
          bottom: "9vh",
          background: "color-mix(in srgb, var(--bg) 92%, transparent)",
          border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)",
          boxShadow: "0 18px 40px -18px var(--shadow)",
          animation: "agx-zoom-in .12s ease-out",
        }}
      >
        <span className="text-[11px]" style={{ color: "var(--text3)" }}>
          {shown.what === "terminal" ? "⌗" : "⛶"}
        </span>
        <span className="text-[12px] tabular-nums" style={{ color: "var(--text)" }}>{shown.label}</span>
      </div>
    </Portal>
  );
}

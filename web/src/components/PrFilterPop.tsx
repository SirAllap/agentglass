// The floating surface the PR filter's popovers share: a Portal at the house
// menu layer, hung under an anchor, closed by an outside press or Escape.
// A popover with no typing input in it takes focus on open, moves between its
// buttons with the arrow keys and gives focus back to its opener on close; one
// built with keepFocus leaves focus where it is, so the typing input owns the list.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";
import { usePopoverKeys } from "../lib/focusTrap.ts";
import { LAYER } from "../lib/layers.ts";
import { menuUnder } from "../lib/menuPos.ts";
import { ICON } from "../lib/iconSize.ts";
import { EDGE } from "./workspace/Chrome.tsx";

/** Marks the popover and what opens it, so a press on the opener is not an outside press. */
export const POP_ATTR = "data-pf-pop";

export const POP_STYLE: CSSProperties = {
  background: "var(--bg)", border: EDGE, borderRadius: 12,
  boxShadow: "0 18px 40px -12px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.18)",
};

export function Pop({ anchor, onClose, width, align = "left", label, children, keepFocus = false }: {
  anchor: HTMLElement | null;
  onClose: () => void;
  width: number;
  align?: "left" | "right";
  label: string;
  children: ReactNode;
  /** Presses inside do not move focus (a list under a text input). */
  keepFocus?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = box.current?.offsetHeight ?? 240;
      setPos(menuUnder({ top: r.top, bottom: r.bottom, left: align === "right" ? r.right - width : r.left }, window.innerWidth, window.innerHeight, { width, height: h }));
    };
    place();
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver !== "undefined" && box.current ? new ResizeObserver(place) : null;
    if (ro && box.current) ro.observe(box.current);
    return () => { window.removeEventListener("resize", place); ro?.disconnect(); };
  }, [anchor, align, width]);
  usePopoverKeys(box, onClose, !keepFocus);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(`[${POP_ATTR}]`)) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close.current(); } };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down, true); document.removeEventListener("keydown", key, true); };
  }, []);
  return (
    <Portal z={LAYER.menu}>
      <div ref={box} {...{ [POP_ATTR]: "" }} role="dialog" aria-label={label}
        onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
        style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxWidth: "calc(100vw - 16px)", ...POP_STYLE, opacity: pos ? 1 : 0 }}>
        {children}
      </div>
    </Portal>
  );
}

/** A mono caps heading inside a popover. */
export function PopHead({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text3)" }}>{children}</div>;
}

/* One glyph set for the deck, drawn at the house ladder. */
const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14", x: "M18 6 6 18M6 6l12 12", help: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01",
  text: "M4 7V5h16v2M12 5v14M9 19h6", hash: "M5 9h14M5 15h14M10 4 8 20M16 4l-2 16",
  card: "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7 10h6",
  conflict: "M12 3 2 21h20zM12 10v5M12 18h.01", clock: "M12 7v5l3 2", check: "m5 12 5 5 9-10",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0", tag: "M3 12V3h9l9 9-9 9zM7.5 7.5h.01",
  dots: "M5 12h.01M12 12h.01M19 12h.01", eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeoff: "m3 3 18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.3M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3", chev: "m6 9 6 6 6-6", filter: "M3 5h18l-7 8v6l-4-2v-4z",
};
const CIRCLES = new Set(["help", "clock"]);
export function PfIcon({ name, size = ICON.xs }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {CIRCLES.has(name) && <circle cx="12" cy="12" r="9" />}
      <path d={PATHS[name] ?? PATHS.tag} />
    </svg>
  );
}

/** The glyph a field gets on its chip. */
export function fieldIcon(field: string): string {
  switch (field) {
    case "text": return "text";
    case "number": return "hash";
    case "card": case "cardstatus": case "cardassignee": return "card";
    case "conflict": return "conflict";
    case "updated": return "clock";
    case "checks": return "check";
    case "author": case "assignee": case "review": return "user";
    default: return "tag";
  }
}

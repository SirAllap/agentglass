import { useEffect, useRef, type RefObject } from "react";

/** Tab stays inside the dialog, and what had the focus gets it back
 *  (`returnTo`, when the caller captured the opener before its own autofocus). */
export function useFocusTrap(on: boolean, root: RefObject<HTMLElement | null>, returnTo?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!on) return;
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !root.current) return;
      const f = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      const at = document.activeElement;
      /* A confirm or menu a row opened is a portal outside the root and has its own Tab handling. */
      if (at && !root.current.contains(at) && at.closest("[role='dialog'],[role='menu'],[role='listbox']")) return;
      if (e.shiftKey && (at === first || !root.current.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !root.current.contains(at))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); (returnTo?.current ?? before)?.focus?.(); };
  }, [on, root, returnTo]);
}

/**
 * The dialog contract for a modal that is mounted only while `open`: spread the
 * result on the panel (`<motion.div {...modal}>`). It gives the panel the dialog
 * role, a name, focus on the way in (unless something inside already took it,
 * like an autofocused field), a Tab trap, and focus back to the opener on the
 * way out. Esc and scrim-click stay with the overlay: this changes neither.
 *
 * The opener is read during render of the opening pass, because an autofocused
 * child has stolen the focus by the time any effect runs.
 */
export function useModalDialog(open: boolean, label: string) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const was = useRef(false);
  if (open && !was.current && typeof document !== "undefined") opener.current = document.activeElement as HTMLElement | null;
  was.current = open;
  useFocusTrap(open, ref, opener);
  useEffect(() => {
    const el = ref.current;
    if (open && el && !el.contains(document.activeElement)) el.focus();
  }, [open]);
  return { ref, role: "dialog" as const, "aria-modal": true as const, "aria-label": label, tabIndex: -1 };
}

const BUTTONS = "button:not(:disabled), [role='option']:not([aria-disabled='true'])";
const FIRST = `${BUTTONS}, [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])`;

/**
 * What a floating menu portalled to the end of the body owes a keyboard: focus on its first control
 * when it opens (unless something inside took it, like an autofocused field), the arrow keys
 * between its buttons, Escape to close it, and focus back to its opener when it goes. Without it the
 * menu is only reachable by tabbing the whole page. A text field keeps its own Escape and arrows.
 */
export function usePopoverKeys(root: RefObject<HTMLElement | null>, onClose: () => void, on = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = root.current;
    if (!on || !el) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FIRST);
      first?.focus();
      /* A name to replace, as the mockup draws the save and rename boxes: typing starts over. */
      if (first instanceof HTMLInputElement) first.select();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!el.contains(document.activeElement)) return;
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if (e.key === "Escape" && !field) { e.stopPropagation(); e.preventDefault(); close.current(); return; }
      const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!dir) return;
      const t = e.target as HTMLElement;
      if (field) return;
      const all = [...el.querySelectorAll<HTMLElement>(BUTTONS)];
      if (!all.length) return;
      e.preventDefault();
      all[(all.indexOf(t) + dir + all.length) % all.length]!.focus();
    };
    el.addEventListener("keydown", onKey);
    return () => { el.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus(); };
  }, [root, on]);
}

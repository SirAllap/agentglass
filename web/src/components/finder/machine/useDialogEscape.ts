import { useEffect } from "react";

/** Escape closes a dialog wherever the focus is, and the key stops there: a dialog that opened without taking the focus (the Network list has no field to autofocus) let Escape reach the Finder behind it, which closed too. */
export function useDialogEscape(onClose: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
}

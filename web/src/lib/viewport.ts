// Which layout this device should get.
//
// The cockpit is built for a desk: a six-view workspace, a real terminal, diff
// hunks, a docker table. On a phone that is not a cramped version of the right
// thing, it is the wrong thing — you cannot drive a shell with a thumb, and
// nobody wants to. So a phone gets a different application entirely (see
// mobile/MobileApp.tsx), and this decides who is a phone.
//
// Width, not user agent. A narrow window on a laptop wants the desktop UI back
// when it is widened, and a tablet in landscape is a perfectly good desk. The
// coarse-pointer rule catches the phone held sideways, where the width alone
// would say "small laptop": 900px of touch screen still has no keyboard.

/** localStorage key holding an explicit choice, which always wins. */
export const LAYOUT_KEY = "agentglass_layout";

export type LayoutOverride = "mobile" | "desktop" | null;

/**
 * Should this viewport get the phone application?
 *
 * Pure, so the rule is testable without a browser: every input is passed in.
 */
export function wantsPhoneLayout(
  width: number,
  coarsePointer: boolean,
  override: LayoutOverride = null
): boolean {
  if (override === "mobile") return true;
  if (override === "desktop") return false;
  if (width < 768) return true;
  // A touch device up to 900px is a phone in landscape. Beyond that it is a
  // tablet, which has the room for the real thing.
  return coarsePointer && width <= 900;
}

/** The saved choice, if the user made one. */
export function readOverride(store: Pick<Storage, "getItem"> | null = safeStorage()): LayoutOverride {
  try {
    const v = store?.getItem(LAYOUT_KEY);
    return v === "mobile" || v === "desktop" ? v : null;
  } catch {
    return null;
  }
}

/** Remember a choice (or forget it, with null) and say whether it changed. */
export function writeOverride(next: LayoutOverride): void {
  try {
    const s = safeStorage();
    if (!s) return;
    if (next === null) s.removeItem(LAYOUT_KEY);
    else s.setItem(LAYOUT_KEY, next);
  } catch {
    /* private mode — the choice lasts for this page and no longer */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The live answer for this browser, right now. */
export function phoneLayoutNow(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return wantsPhoneLayout(window.innerWidth, coarse, readOverride());
}

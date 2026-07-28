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
//
// One case is not a measurement at all. A device that reached this page over
// the network — the QR link from Settings > Remote — gets the phone
// application and nothing else, because the cockpit it would otherwise mount
// carries a terminal, git write access and docker control. Width cannot decide
// that: Chrome's "Desktop site" reports 980px from a phone, a saved override
// outlives the reason it was set, and a tablet is wide by definition. The
// server marks the page instead, from the address the request came from, and
// that mark wins over everything below.

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
  override: LayoutOverride = null,
  remote = false
): boolean {
  // Ahead of the override on purpose: the choice a person made about the
  // laptop on their desk is not consent for the cockpit to open on a device
  // that scanned a QR code, and the override is remembered per browser, so it
  // would otherwise be the one input the phone can set for itself.
  if (remote) return true;
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

/**
 * Was this page served to a device off this machine?
 *
 * Planted by the server into index.html, per connection, from the peer address
 * of the socket (server/src/webui.ts). Absent for the desktop shell, which
 * loads the renderer from its own `agentglass://` scheme, and for vite dev and
 * the demo build, which are not served by the server at all.
 */
export function servedToRemoteDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __AGENTGLASS_REMOTE__?: boolean }).__AGENTGLASS_REMOTE__ === true
  );
}

/** The live answer for this browser, right now. */
export function phoneLayoutNow(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return wantsPhoneLayout(window.innerWidth, coarse, readOverride(), servedToRemoteDevice());
}

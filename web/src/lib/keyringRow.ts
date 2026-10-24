/*
 * What the "Keep secrets in the system keyring" row says and allows, from the
 * server's answer (GET /keyring) and whether a move is in flight. Pulled out of
 * the screen so the rules are asserted without a renderer: the switch is off
 * and disabled while nothing is known, a locked keyring is a quiet badge plus a
 * way to ask again (never an alert), and a keyring that cannot exist here
 * disables the row and says why in one line. No secret value is ever in this
 * shape: the server sends a count and a reason, nothing else.
 */
export interface KeyringState {
  enabled: boolean;
  state: "ready" | "locked" | "unavailable";
  why?: string;
  held: number;
}

export interface KeyringRowView {
  on: boolean;
  /** Nothing can be clicked: unknown, unavailable, or a move is running. */
  disabled: boolean;
  hint: string;
  /** A quiet note beside the switch; null when there is nothing to say. */
  badge: string | null;
  /** Offer "Check again": only a locked keyring changes by itself. */
  checkAgain: boolean;
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : "");

/** `moving` is the value being moved to while the toggle request is out, else null. */
export function keyringRow(s: KeyringState | null, moving: boolean | null): KeyringRowView {
  if (moving !== null) {
    return { on: moving, disabled: true, badge: null, checkAgain: false,
      hint: moving ? "Moving your tokens into the keyring…" : "Moving your tokens back into the file…" };
  }
  if (!s) return { on: false, disabled: true, badge: null, checkAgain: false, hint: "Checking the keyring…" };
  if (s.state === "unavailable") {
    return { on: s.enabled, disabled: true, badge: null, checkAgain: false, hint: sentence(s.why || "the system keyring is not available") };
  }
  const locked = s.state === "locked";
  const badge = locked ? "keyring locked" : null;
  if (!s.enabled) {
    return { on: false, disabled: false, badge, checkAgain: locked,
      hint: locked ? "Unlock the keyring to turn this on. Until then secrets stay in a file." : "Secrets stay in a 0600 file, readable only by you." };
  }
  if (locked) {
    return { on: true, disabled: false, badge, checkAgain: true, hint: "Unlock the keyring, then check again." };
  }
  return { on: true, disabled: false, badge, checkAgain: false,
    hint: s.held === 0 ? "On. No secret is stored yet." : `On. ${s.held} secret${s.held === 1 ? "" : "s"} held in the keyring.` };
}

/** What the Credentials row says about where the tokens are, so it never says "file" while they are not. */
export const credentialsWhere = (s: KeyringState | null): string => (s?.enabled ? "system keyring" : "file, owner only");

/** The one line under the row when a move did not happen: the reason, then what that means for the secrets. */
export const moveFailed = (error: string | undefined): string => `${sentence(error || "the server did not answer")} Nothing was moved.`;

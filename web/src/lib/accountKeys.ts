/**
 * What a key does in the usage popover's account chips, decided without a DOM.
 *
 * The popover has two axes: providers (up and down, only when more than one
 * provider has accounts) and the accounts of the one shown (left and right).
 * `a` asks the plugin to switch to the chip in focus, `m` opens the plugin's
 * own page, Esc closes. When an agent has proposed a switch, the first Esc
 * puts the proposal away and the second closes, so a stray Esc never throws
 * away the popover the person was reading.
 *
 * Nothing here moves a selection or calls a route: it names the action and the
 * popover does it. `a` and `m` are refused (null) while the chips are
 * read-only, which is what a manager that owns the switch looks like.
 */

export interface KeyState {
  /** Providers that have an account list and a reading to show. */
  providers: number;
  /** Accounts of the provider shown. */
  accounts: number;
  /** The chip in focus is the one already in use. */
  candidateActive: boolean;
  /** A plugin manages the switching itself; the chips are read-only. */
  managed: boolean;
  /** An agent's proposal is on screen. */
  proposal: boolean;
  /** A press is still being answered. */
  busy: boolean;
}

export type KeyAction =
  | { do: "provider"; step: 1 | -1 }
  | { do: "candidate"; step: 1 | -1 }
  | { do: "switch" }
  | { do: "manage" }
  | { do: "dismiss" }
  | { do: "close" };

export function decideKey(s: KeyState, key: string): KeyAction | null {
  switch (key) {
    case "Escape": return s.proposal ? { do: "dismiss" } : { do: "close" };
    case "ArrowDown": return s.providers > 1 ? { do: "provider", step: 1 } : null;
    case "ArrowUp": return s.providers > 1 ? { do: "provider", step: -1 } : null;
    case "ArrowRight": return s.accounts > 1 ? { do: "candidate", step: 1 } : null;
    case "ArrowLeft": return s.accounts > 1 ? { do: "candidate", step: -1 } : null;
    // While an agent's proposal is on screen the card's own button is the only way
    // to switch: a key typed by someone who did not see the card must not press it.
    case "a": case "A": return !s.managed && !s.candidateActive && !s.busy && !s.proposal ? { do: "switch" } : null;
    case "m": case "M": return !s.managed && !s.busy && !s.proposal ? { do: "manage" } : null;
    default: return null;
  }
}

/** Move `i` by `step` inside `n` items, wrapping at both ends. */
export const stepIndex = (i: number, step: 1 | -1, n: number): number => (n <= 0 ? 0 : (i + step + n) % n);

export interface KeyHint {
  keys: string;
  label: string;
  /** Present on the two hints that are also buttons. */
  act?: "switch" | "manage";
  /** A hint that exists but would do nothing now is drawn dim, not removed: the bar keeps its shape. */
  enabled: boolean;
}

/**
 * The footer key bar. A hint appears only when its keys can ever work on this
 * screen (no arrows for one provider, no `a`/`m` when the manager owns the
 * switch), and is dim, not gone, when it cannot work right now.
 */
export function keyHints(s: KeyState): KeyHint[] {
  const out: KeyHint[] = [];
  if (s.providers > 1) out.push({ keys: "↑↓", label: "provider", enabled: true });
  if (s.accounts > 1) out.push({ keys: "←→", label: "account", enabled: true });
  if (!s.managed) {
    out.push({ keys: "a", label: "switch", act: "switch", enabled: !s.candidateActive && !s.busy && !s.proposal });
    out.push({ keys: "m", label: "manage", act: "manage", enabled: !s.busy && !s.proposal });
  }
  return out;
}

/**
 * Where Tab goes inside the popover, so it never walks out behind the scrim.
 * `at` is the index of the focused control among the popover's own (-1 when
 * focus is on the root, or on nothing because the button that had it was just
 * disabled). Null leaves the move to the browser.
 */
export function tabTarget(at: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (at < 0) return shift ? count - 1 : 0;
  if (!shift && at === count - 1) return 0;
  if (shift && at === 0) return count - 1;
  return null;
}

/**
 * The card's first line. `by` is whatever name the agent gave itself (`--as`),
 * so it is drawn as quoted text under the word "Agent": an agent called
 * "Agentglass" or "Your admin" must not read as the app speaking. Its quote
 * marks are dropped so it cannot close its own quote.
 */
export function proposalLine(by: string, provider: string, account: string): string {
  const name = by.replace(/[«»]/g, "").slice(0, 40);
  return `Agent «${name}» suggests switching ${provider} to ${account}.`;
}

/**
 * A staged proposal is seen once per request. With no plan row to anchor the
 * popover to there is nothing to open, and it is not kept either: opening out
 * of nowhere when a reading lands later is the person's screen changing for an
 * agent's request that is minutes old.
 */
export function onProposal(seen: number, n: number, hasRow: boolean): { seen: number; open: boolean } {
  return n <= seen ? { seen, open: false } : { seen: n, open: hasRow };
}

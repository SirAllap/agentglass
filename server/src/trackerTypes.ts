/*
 * The shapes every tracker client answers with.
 *
 * Moved out of clickup.ts, type for type, so the Jira client can return them
 * without importing a 3,400-line module for two interfaces. clickup.ts
 * re-exports both, so nothing that imports them from there has to change.
 * Types only: there is no behaviour in this file.
 */
import type { ProviderTask } from "../../shared/providers.ts";

export interface CallResult<T> {
  ok: boolean;
  data?: T;
  /** For the person, never a raw body. */
  error?: string;
  /** True when the token was rejected — the one error that means "reconnect"
   *  rather than "try later". */
  unauthorised?: boolean;
  /** True when we were refused for rate, or held back before being refused. */
  throttled?: boolean;
}

export interface WriteOutcome {
  ok: boolean;
  error?: string;
  /** The task as it stands after the write, re-read rather than assumed. */
  task?: ProviderTask;
  /** The status the card left, for the watch to tell its own move from somebody else's. */
  was?: string;
  /** Somebody else changed it between the read and the write. */
  conflict?: boolean;
  /**
   * The token was refused — reconnect, rather than try again.
   *
   * `conflict` has always been a field rather than a sentence, and this is the
   * other failure with a different remedy, so it gets the same treatment. The
   * read path (`CallResult`) has carried it all along and the writes computed
   * it and threw it away: `put` classifies 401/403 and then every caller
   * flattened the result to `{ ok: false, error }`.
   *
   * NOT a general error taxonomy, and deliberately not: this provider answers
   * 401 for a card that does not exist (see findTask), so a code claiming to
   * name the cause would be wrong on exactly the case people hit most. Two
   * flags for the two remedies the app can actually offer — reload, reconnect
   * — and prose for the human, which is the only thing that can be honest
   * about the rest.
   */
  unauthorised?: boolean;
  /** Set when some, not all, of a multi-step write landed: what DID happen,
   *  in a sentence. */
  partial?: string;
}

/*
 * How a list screen (Issues, Tasks, …) presents a load failure.
 *
 * `describeFailure` in api.ts collapses every flavour of "the computer is not
 * there" to one sentence, "Cannot reach the computer" — and every list screen
 * printed that sentence under a heading that blames the SERVICE it asked:
 * "Can't ask GitHub", full stop, no retry. On a phone that walked out of wifi
 * range that is wrong twice over — GitHub was never asked, and the only way
 * back was leaving the tab and returning to it, which re-runs the same load
 * anyway.
 *
 * Pulled out of the screen because the decision — which title, whether to
 * offer a hint and a retry — is exactly what this project's own rule says
 * belongs in src/ rather than a renderer: "there is no renderer in this
 * project, and a rule about source is asserted against source."
 */

/** The one string `describeFailure` returns for every unreachable-machine
 *  case. Matched verbatim rather than re-deriving the network regex here —
 *  this is the single seam between "the computer" and "the service running
 *  on it", and re-testing the raw error would drift from api.ts the first
 *  time either side's wording changed. */
const UNREACHABLE_MESSAGE = "Cannot reach the computer";

export interface ListErrorText {
  /** `null` when this is not the "phone can't reach the computer" case — the
   *  screen keeps its own title (its own service refused, or answered
   *  oddly), because that failure IS about the thing it asked. */
  title: string | null;
  /** A second line naming what to check. Only set alongside `title`. */
  hint: string | null;
  /** Whether a "Try again" button belongs here. A dead network is worth a
   *  retry button; a service's own refusal already has its own copy and its
   *  own reason a retry alone will not fix. */
  canRetry: boolean;
}

const UNREACHABLE: ListErrorText = {
  title: "The computer is not answering",
  hint: "Check you're on the same network and that agentglass is running.",
  canRetry: true,
};

const NOT_UNREACHABLE: ListErrorText = { title: null, hint: null, canRetry: false };

/**
 * Is this load failure "the phone could not reach the computer" — and if so,
 * what to show instead of blaming whatever the screen was asking.
 */
export function listErrorText(error: string | null): ListErrorText {
  if (error === UNREACHABLE_MESSAGE) return UNREACHABLE;
  return NOT_UNREACHABLE;
}

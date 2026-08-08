// Which pull requests are allowed to interrupt you about their checks.
//
// A suite that finishes is news about a pull request, and how much you care
// depends entirely on where that pull request is. On something half-written it
// is a status line you would glance at if you happened to be looking; on
// something approved it is the last thing between you and merging, and a red
// one is a thing to go and do something about.
//
// Asked for as "only when the PR is approved", and kept as a preference rather
// than a rule because the other reading is defensible too — a red check on your
// own work in progress is the earliest you could know. This is the one setting
// where being wrong for somebody costs them either a missed failure or a day of
// pings, so it is theirs to set.
//
// In localStorage, like the rest of this window's preferences: it decides what
// this machine's notch does, and a round trip would put a fetch in front of a
// notification.

const KEY = "agentglass.ci.onlyApproved";

/**
 * On by default, which is what was asked for.
 *
 * The default matters more than usual here: a notification setting nobody
 * touches is the behaviour everybody gets, and the flood is the complaint that
 * brought this about. Someone who wants every verdict turns it off once.
 */
export const CI_ONLY_APPROVED_DEFAULT = true;

export function ciOnlyApproved(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    // The raw string, not `Boolean(...)`: an absent setting and a stored
    // "false" both read as falsy through a cast, so the default would be
    // unreachable the moment anybody turned it off and back on.
    if (raw === null) return CI_ONLY_APPROVED_DEFAULT;
    return raw === "1";
  } catch { return CI_ONLY_APPROVED_DEFAULT; }
}

export function setCiOnlyApproved(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

/**
 * Whether this verdict should reach the notch.
 *
 * `approved` is optional on the way in on purpose: a server one version behind
 * sends a verdict without it, and the honest reading of "I do not know whether
 * it is approved" is to let it through. Silence would be indistinguishable from
 * a suite that never finished.
 */
export function ciShouldNotify(v: { approved?: boolean }, onlyApproved = ciOnlyApproved()): boolean {
  if (!onlyApproved) return true;
  if (v.approved === undefined) return true;
  return v.approved;
}

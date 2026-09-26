/*
 * What each dependency status is called on the phone, and how loud it is.
 *
 * Typed against the server's own `DepStatus` rather than a list written here,
 * because the list written here was one short. `/dependencies` answers
 * `unsupported` for a tool a platform does not use — Docker Desktop on Linux,
 * `apt` on a Mac — and the Troubleshooting screen indexed a three-entry table
 * with it: `LOOK[dep.status]` was `undefined`, `.word` on that threw, and the
 * screen somebody opens to find out why things are broken was itself the thing
 * that was broken. A `Record<DepStatus, …>` cannot be one short; `tsc` says so.
 *
 * The words are the desk's (web/src/components/SettingsModal.tsx): the two
 * surfaces describe one machine, and two vocabularies for one fact is how they
 * drift.
 */
import type { DepStatus } from "../../../shared/deps.ts";

/** Which ink the row takes. Resolved to a colour by the screen, which owns the
 *  palette; this file only knows how serious each status is. */
export type DepTone = "good" | "warn" | "bad" | "mute";

export const DEP_LOOK: Record<DepStatus, { word: string; tone: DepTone }> = {
  ok: { word: "installed", tone: "good" },
  attention: { word: "needs a look", tone: "warn" },
  missing: { word: "missing", tone: "bad" },
  // Not a problem, so not a warning colour: there is nothing to install and
  // nothing to do, and a row that looked broken would send somebody to the
  // computer to fix a tool their platform never uses.
  unsupported: { word: "not used here", tone: "mute" },
};

/**
 * Does this row belong in the "what is wrong" set — expanded from the start,
 * and counted against "everything is installed"?
 *
 * `unsupported` does not: it is neither installed nor absent, and counting it
 * would make the summary line say something is missing on every machine that
 * has a platform.
 */
export const depNeedsAttention = (status: DepStatus): boolean =>
  status === "attention" || status === "missing";

/**
 * The tone a ROW takes, which is not simply `DEP_LOOK[status].tone`.
 *
 * A tool this app never actually needs missing is not the same shade as one
 * it does: every REQUIRED tool present and only optional ones missing still
 * drew a red dot, a red "missing", an amber banner and a "Needs attention"
 * heading — measured on a machine with `gh` and `git` both installed and one
 * optional formatter absent, which is the calm case this app should have
 * about zero to say about. `mute` is reused rather than adding a fifth tone:
 * it is already how "not used here" reads, and an optional gap not installed
 * is the same kind of "nothing to do here" as a tool the platform never uses.
 */
export function depTone(dep: { status: DepStatus; required: boolean }): DepTone {
  if (!dep.required && depNeedsAttention(dep.status)) return "mute";
  return DEP_LOOK[dep.status].tone;
}

/**
 * The heading over the "what needs attention" group.
 *
 * `null` when there is nothing broken at all — the caller does not show the
 * group. Otherwise: red urgency only when something REQUIRED is missing;
 * calm, informational wording when the only gaps are optional tools nobody
 * has to go and install.
 */
export function brokenHeading(broken: { required: boolean }[]): string | null {
  if (!broken.length) return null;
  return broken.some((d) => d.required) ? "Needs attention" : "Optional, not installed";
}

/**
 * The one line at the top of Troubleshooting: how many tools were found, and
 * whether what is missing matters.
 *
 * The screen was a list of twenty rows with a dot each, and the answer to the
 * question somebody arrives with — is anything I need missing — had to be
 * counted off it. A required tool missing is red and said first; an optional
 * one used to be amber and said as a warning, which is the wrong register for
 * "nothing to do here" — a machine with every required tool present has
 * nothing wrong with it, whatever is missing from the optional list. `mute`
 * reads calm rather than alarming, and it is the same tone `depTone` gives
 * the rows themselves.
 */
export function depSummary(deps: { status: DepStatus; required: boolean }[]): {
  tone: "good" | "mute" | "bad";
  title: string;
  sub: string;
} {
  const relevant = deps.filter((d) => d.status !== "unsupported");
  const found = relevant.filter((d) => d.status === "ok").length;
  const required = relevant.filter((d) => d.required && depNeedsAttention(d.status)).length;
  const optional = relevant.filter((d) => !d.required && depNeedsAttention(d.status)).length;
  const title = `${found} of ${relevant.length} tools found`;
  if (required) {
    return { tone: "bad", title, sub: `${required} required ${required === 1 ? "tool is" : "tools are"} missing or need a look.` };
  }
  if (optional) {
    return {
      tone: "mute",
      title,
      sub: `Everything required is there. ${optional === 1 ? "One optional tool is" : `${optional} optional tools are`} not installed.`,
    };
  }
  return { tone: "good", title, sub: "Everything this app shells out to is installed." };
}

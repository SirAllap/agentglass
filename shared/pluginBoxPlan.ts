/*
 * What starting a plugin that declares a `sandbox` will do on this host,
 * decided from four facts and nothing else — so the server's start path and
 * the approval screen read one answer instead of each re-deriving it.
 *
 * It is the screen that had it wrong: `sandboxProbe` reports "missing" on
 * macOS and Windows, because bwrap is a Linux mechanism and is never there,
 * while the server starts the plugin unboxed there without asking. A screen
 * that took the probe at its word said "will not start" or "install
 * bubblewrap" for a plugin that starts, and "runs as you" for one that is
 * refused. The probe says whether a box can be built; this says what that
 * means for a start.
 */

export type BoxPlan =
  /** The host can build the box: the plugin is started inside it. */
  | "box"
  /** Linux, no box, no consent: the start is refused until the person allows
   *  it to run unboxed or fixes the host. */
  | "refuse"
  /** Linux, no box, but consent (per plugin or `AGENTGLASS_PLUGINS_UNBOXED=1`)
   *  was given: it starts, as the user. */
  | "unboxed-consented"
  /** Not Linux: there is no box to build and never was, so it starts as the
   *  user, unconditionally and by design. */
  | "unboxed-platform";

export interface BoxPlanInput {
  /** `process.platform`. */
  platform: string;
  /** `sandboxProbe().ok`. */
  probeOk: boolean;
  /** The plugin's own consent (`allowUnboxed` on its record). */
  allowUnboxed?: boolean;
  /** `AGENTGLASS_PLUGINS_UNBOXED=1`: every plugin, on a host already trusted. */
  envAllowsAll: boolean;
}

export function boxPlan(i: BoxPlanInput): BoxPlan {
  if (i.probeOk) return "box";
  if (i.platform !== "linux") return "unboxed-platform";
  return i.allowUnboxed === true || i.envAllowsAll ? "unboxed-consented" : "refuse";
}

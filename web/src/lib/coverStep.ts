/**
 * When the launch cover comes down — the decision alone, with no DOM and no
 * clock of its own, so every case can be asserted (web/test/cover.test.ts).
 *
 * The cover (web/index.html) stays up while the app mounts and loads under it.
 * What it waits for is not a timer: each panel that is on screen at launch
 * HOLDS it while its first real data is on its way — the terminal until its
 * shell has drawn, Git until the working tree is read, and so on (see
 * `useCoverHold` in cover.ts). The cover comes down when the app has mounted
 * and nothing holds it any more.
 *
 * Three things keep that honest:
 *
 *  - SETTLE. A hold can let go and another take its place in the same breath —
 *    the terminal's checkout is known, and only then does the shell it opens
 *    start holding. So "nothing holds it" has to stay true for a moment before
 *    it counts. The moment is short on purpose: every millisecond of it is a
 *    millisecond the ready app sits hidden.
 *  - CAP. However slow a panel is, the cover never outstays COVER_CAP_MS from
 *    the start of navigation. Past it the app is shown as it is, and whatever
 *    is still loading says so in its own place, as it always did.
 *  - FAILURE. A server that failed to start is said on the cover, at once,
 *    rather than left to run out the cap behind a spinning orbit.
 */

/** The longest the cover stays up, measured from the start of navigation. The
 *  sidecar alone has been measured at up to twelve seconds on a cold machine
 *  (electron/main.js), and the panels load after it. */
export const COVER_CAP_MS = 15_000;

/** How long "nothing holds it" must stay true before it counts. */
export const COVER_SETTLE_MS = 50;

/** Why the app cannot load. `canContinue`: there is an app to go on to — a
 *  server that failed still leaves the interface, and its own banner, up. */
export interface CoverFailure {
  title: string;
  detail: string;
  canContinue: boolean;
}

export interface CoverState {
  /** React has committed the first tree. */
  mounted: boolean;
  /** Who is still loading, by name, with how many holds each has. */
  holds: ReadonlyMap<string, number>;
  /** When `mounted` or `holds` last changed, in the clock `now` is read on. */
  changedAt: number;
  failure: CoverFailure | null;
}

export type CoverStep =
  | { kind: "wait"; recheckIn: number }
  | { kind: "go"; why: "ready" | "cap" }
  | { kind: "fail"; failure: CoverFailure };

/**
 * What to do now. `now` and `changedAt` are milliseconds on the same clock as
 * the cap: performance.now(), whose zero is the start of navigation.
 *
 * At the cap an app that has mounted is shown as it is; one that never did is
 * a failure, not a reveal — taking the cover down would show an empty window.
 */
export function coverStep(s: CoverState, now: number, cap = COVER_CAP_MS, settle = COVER_SETTLE_MS): CoverStep {
  if (s.failure) return { kind: "fail", failure: s.failure };
  if (now >= cap) {
    return s.mounted
      ? { kind: "go", why: "cap" }
      : { kind: "fail", failure: { title: "The interface did not load", detail: `Nothing had drawn after ${Math.round(cap / 1000)} seconds.`, canContinue: false } };
  }
  if (!s.mounted || s.holds.size > 0) return { kind: "wait", recheckIn: cap - now };
  const quiet = now - s.changedAt;
  if (quiet >= settle) return { kind: "go", why: "ready" };
  return { kind: "wait", recheckIn: Math.min(settle - quiet, cap - now) };
}

/** What the status line says while a panel still holds the cover. The first
 *  hold taken is the one named: it is the one that has been waiting longest. */
const LINES: Record<string, string> = {
  server: "starting the server…",
  project: "finding the project…",
  terminal: "opening the terminal…",
  git: "reading the working tree…",
  dashboard: "loading the dashboard…",
  panel: "loading the panel…",
};

/**
 * Whether a shell on screen has said what it is going to say at launch.
 *
 * `settled` is the terminal's own mark: it has drawn, and on the app's own tmux
 * its window strip has arrived. A shell that ended — exited, refused as
 * unauthorized — has said it too, in the terminal itself. An error is the one
 * that depends: a socket refused while the server is starting or just up is
 * not an answer, the terminal retries and connects; `refusalFinal` (cover.ts)
 * says when a refusal is the answer.
 */
export function shellSettled(s: { settled?: boolean; status: string }, refusalFinal: boolean): boolean {
  if (s.settled) return true;
  if (s.status === "idle" || s.status === "connecting" || s.status === "live") return false;
  return s.status !== "error" || refusalFinal;
}

export function coverLine(holds: ReadonlyMap<string, number>): string {
  for (const name of holds.keys()) return LINES[name] ?? "loading…";
  return "loading the interface…";
}

/**
 * A critically damped spring as a CSS `linear()` easing.
 *
 * Damping 1.0 is the no-overshoot spring that moves things into place without
 * a bounce — nothing was thrown, so nothing should wobble. `response` is the
 * spring's period in seconds (lower is snappier), `duration` where the curve
 * is cut: the spring never quite arrives, so the tail is normalised to land
 * exactly on 1 at the end rather than jump there.
 */
export function springEasing(response: number, duration: number, points = 32): string {
  const w = (2 * Math.PI) / response;
  const x = (t: number) => 1 - (1 + w * t) * Math.exp(-w * t);
  const end = x(duration);
  const stops: string[] = [];
  for (let i = 0; i <= points; i++) {
    const p = i / points;
    stops.push(`${+(x(p * duration) / end).toFixed(4)} ${+(p * 100).toFixed(2)}%`);
  }
  return `linear(${stops.join(", ")})`;
}

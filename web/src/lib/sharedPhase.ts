// Aligns every stepped `agx-phone-pulse`/`agx-attention` instance to one
// shared clock.
//
// Each instance used to start its own animation at `animation-delay: 0`,
// meaning render time -- not a shared reference point -- was frame zero. Two
// tabs mounted a beat apart step out of phase with each other and with the
// waiting ring, so a screen with several of them drew a step whenever ANY one
// of them was due rather than in unison: the summed frame rate of every
// instance, not the ~4 frames/s any one of them draws alone (see the CSS
// comment beside `agx-phone-pulse`/`agx-attention`).
//
// `document.timeline.currentTime` is the same monotonic clock every instance
// on the page shares regardless of when it mounted, so a NEGATIVE delay of
// "where in the current cycle that clock already is" lands every instance on
// the same step at the same moment. Recomputed at render time is fine: a
// re-render landing on the same point in the cycle produces the same delay,
// and `animation-delay` on an already-running CSS animation only re-times its
// phase -- it does not restart the animation (standard behaviour, MDN).
export function sharedPhase(ms: number): string {
  const t = typeof document !== "undefined" ? document.timeline?.currentTime : null;
  if (t == null) return "0ms";
  return `-${Number(t) % ms}ms`;
}

// Arm, then confirm: first press arms, a second press within 4 s fires,
// otherwise it disarms by itself.
import { DISARM_MS, realClock, type Clock } from "./clock.ts";

export function createDangerArm(opts: {
  run: () => void;
  onChange?: (armed: boolean) => void;
  clock?: Clock;
}) {
  const clock = opts.clock ?? realClock;
  let armed = false;
  let timer: unknown = null;
  const clearTimer = () => { if (timer != null) clock.clear(timer); timer = null; };
  const set = (a: boolean) => { armed = a; opts.onChange?.(a); };
  return {
    get armed() { return armed; },
    press() {
      if (!armed) {
        set(true);
        timer = clock.set(() => { timer = null; set(false); }, DISARM_MS);
        return;
      }
      clearTimer();
      set(false);
      opts.run();
    },
    /** Escape, blur, or unmount. */
    disarm() { clearTimer(); if (armed) set(false); },
  };
}

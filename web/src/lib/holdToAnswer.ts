/*
 * One answer, held. A click, a tap or a key tap on Approve or Decline must never
 * change a setting, so the pointer (or Space/Enter on the focused button) has to
 * stay down for HOLD_MS. Letting go early cancels, and nothing happens until the
 * timer fires; Enter and Esc on their own are not an answer.
 *
 * The clock is an argument so a test can drive the second without waiting for
 * it: bun's runner has no fake timers.
 */

export const HOLD_MS = 1000;

export interface HoldClock {
  start(fn: () => void, ms: number): number;
  stop(id: number): void;
}

const realClock: HoldClock = {
  start: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  stop: (id) => clearTimeout(id),
};

export interface Hold {
  /** Start holding. Ignored while a hold is already running. */
  press(): void;
  /** Let go: nothing happens. */
  release(): void;
  holding(): boolean;
}

export function createHold(opts: {
  onAnswer: () => void;
  ms?: number;
  clock?: HoldClock;
  onChange?: (holding: boolean) => void;
}): Hold {
  const clock = opts.clock ?? realClock;
  const ms = opts.ms ?? HOLD_MS;
  let timer: number | null = null;
  const set = (holding: boolean): void => opts.onChange?.(holding);
  return {
    press() {
      if (timer !== null) return;
      timer = clock.start(() => {
        timer = null;
        set(false);
        opts.onAnswer();
      }, ms);
      set(true);
    },
    release() {
      if (timer === null) return;
      clock.stop(timer);
      timer = null;
      set(false);
    },
    holding: () => timer !== null,
  };
}

/**
 * What a key does to a hold. Space and Enter start one while the button has
 * focus and stop it on key-up; a repeat is not a new press. Everything else,
 * Escape included, is not an answer.
 */
export function holdKey(key: string, phase: "down" | "up", repeat = false): "press" | "release" | null {
  if (key !== " " && key !== "Enter") return null;
  if (phase === "up") return "release";
  return repeat ? null : "press";
}

/*
 * Tests that are one story told in order, which `bun test --seed N` cannot tell.
 *
 * About fifty files here build their fixture once and then act on it test by
 * test: the second test reads what the first wrote, a restore test asserts on
 * the tmux session an earlier test started, a usage meter is walked through a
 * burst of 429s. Run in file order they are green, and CI shuffles which FILE
 * runs first, never what happens inside one. `--seed` shuffles the tests of a
 * file as well, and bun has no way to say "not this one": measured on 1.3.9,
 * `describe.serial` keeps the order of nothing, and sibling `describe`s are
 * shuffled like the tests inside them. Measured on the server suite: seed 1
 * failed 160 tests in 64 files, 48 of them from this alone, and the same suite
 * with only the files shuffled failed none.
 *
 * `story()` returns a `step` that is registered like `test`, and whichever
 * step bun happens to run first runs every step declared before it, in
 * declared order, once. Each step still reports on its own: a step that threw
 * fails the test that carries its name, not the one that happened to run it.
 *
 * What it cannot do: a step is not isolated from the steps before it, which is
 * the point and the limit. A new test that does not need a story belongs in a
 * plain `test`, and a file whose tests share nothing should not use this at
 * all. Hooks (`beforeEach`/`afterEach`) wrap whichever test bun runs, not the
 * step, so a file that relies on them per step has to set up inside the step.
 * Each step is held to its own timeout (20 s unless it is given one, the same
 * as `make check`), because the test that carries the first run would
 * otherwise be the only clock.
 */
import { test } from "bun:test";

const STEP_MS = 20_000;
/** What bun may spend on the test that runs the whole story. */
const WHOLE_STORY_MS = 15 * 60_000;

type Outcome = { error?: unknown; failed: boolean };

export function story() {
  const steps: Array<{ fn: () => unknown; ms: number }> = [];
  const outcomes: Outcome[] = [];
  let next = 0;
  /** The first failed `setup` and where it was declared: every step after it is told. */
  let setupFailure: { at: number; error: unknown } | undefined;

  async function run(at: number) {
    const { fn, ms } = steps[at];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`step ${at + 1} of ${steps.length} timed out after ${ms} ms`)), ms);
        }),
      ]);
      outcomes[at] = { failed: false };
    } catch (error) {
      outcomes[at] = { failed: true, error };
    } finally {
      clearTimeout(timer);
    }
  }

  function step(name: string, fn: () => unknown, ms: number = STEP_MS) {
    const at = steps.push({ fn, ms }) - 1;
    test(name, async () => {
      while (next <= at) await run(next++);
      const outcome = outcomes[at];
      if (outcome.failed) throw outcome.error;
      if (setupFailure && setupFailure.at < at) throw setupFailure.error;
    }, WHOLE_STORY_MS);
  }

  /** Work the story needs done at this point, which is not a test of its own —
   *  what a `beforeAll` in the middle of the file would be if hooks followed
   *  the story instead of the test bun happens to run. */
  step.setup = (fn: () => unknown, ms: number = STEP_MS) => {
    const at = steps.length;
    steps.push({
      fn: async () => { try { await fn(); } catch (error) { setupFailure ??= { at, error }; throw error; } },
      ms,
    });
  };

  return step;
}

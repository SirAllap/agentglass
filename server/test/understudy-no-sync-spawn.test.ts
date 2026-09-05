/*
 * Nothing the understudy does may block the event loop.
 *
 * Bun runs one. A synchronous spawn holds it for as long as the child takes,
 * and every other request — the terminal, the websocket, `/health` — waits.
 *
 * This is written down because it has now happened twice in this repository.
 * `antigravity.ts` carries the same scar in a comment, and the backtest
 * repeated it: `spawnSync` per repository, thirty-four checkouts in scope, a
 * full `git log --numstat` each. The app froze and `/health` stopped answering
 * altogether. It was not caught by a test because nothing was watching for the
 * shape — only by running it.
 *
 * Scoped to the understudy's own files rather than all of server/src, because
 * there are legitimate sync spawns elsewhere: one-off probes at boot, where
 * there is no request to starve and blocking is what the caller wants. The rule
 * is not "never spawn synchronously", it is "not on a path a view can trigger".
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("the understudy never blocks the server", () => {
  test("no understudy module spawns a process synchronously", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = readdirSync(src).filter((f) => f.startsWith("understudy") && f.endsWith(".ts"));
    // A guard that scans nothing passes beautifully.
    expect(files.length, "there should be understudy modules to check").toBeGreaterThan(3);

    const guilty: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(src, f), "utf8");
      text.split("\n").forEach((line, i) => {
        // Comments are where the reason for this rule is written down, so a
        // mention in prose is not a call. The first version of this test failed
        // on the comment explaining the outage.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        if (/\bspawnSync\s*\(/.test(code)) guilty.push(`${f}:${i + 1}`);
      });
    }
    expect(guilty, `a sync spawn on a path a view can trigger:\n${guilty.join("\n")}`).toEqual([]);
  });

  /*
   * THE POSITIVE HALF USED TO NAME ONE FUNCTION — the backtest, which shelled
   * out to git across every checkout. That module is gone with the rest of the
   * predictor's apparatus, and picking another function to stand for it would
   * be choosing an example again.
   *
   * The negative half above is the stronger statement anyway: it holds for
   * EVERY path a view can reach, not for whichever one somebody remembered to
   * name here, and it keeps holding as functions come and go.
   */
});

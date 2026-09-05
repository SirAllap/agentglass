/*
 * A hook may not ask for more patience than it is given.
 *
 * Twenty `beforeAll`s here spawn a real server and poll `/health` in a retry
 * loop written for ten or fifteen seconds. Bun allows a hook FIVE by default,
 * so those loops could never run to the end: the hook was killed at a third of
 * its own declared wait, and the file reported "a beforeEach/afterEach hook
 * timed out" having run no tests at all.
 *
 * It reads as a flake, which is how it was found — one file red on its own and
 * green in the suite, twice, while the same file passed ten times out of ten an
 * hour later. Nothing about the message says the loop was the thing that was
 * cut, and no test was covering the gap because the gap is between a file's
 * code and its runner's default.
 *
 * SOURCE-LEVEL, and deliberately: the behaviour only appears on a machine under
 * enough load to push a boot past five seconds, which is not a state a test can
 * reproduce without inflicting it on whoever else is using the machine. What
 * CAN be checked, every run and for free, is that the two numbers agree.
 *
 * Breaking it: drop the `, SERVER_BOOT_MS` from any of the nineteen files and
 * this goes red naming that file.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const DIR = new URL(".", import.meta.url).pathname;
const BUN_DEFAULT_HOOK_MS = 5_000;

/** Every async hook in the suite, with what its retry loop waits for and what
 *  its runner will actually allow. */
type Hook = { file: string; kind: string; wantsMs: number; budgetMs: number };

/**
 * The whole `beforeAll(...)` call starting at `from`, found by COUNTING
 * parentheses rather than by matching its closing line.
 *
 * The line-shaped version of this passed while two files were still broken. A
 * hook nested in a `describe` closes as `  }, SERVER_BOOT_MS);` — indented —
 * and a pattern anchored at column zero skipped past it to the `describe`'s own
 * close, reading a hook that HAD a budget as one that did not. Counting cannot
 * be fooled by indentation, a nested arrow function, or a `})` inside a
 * template literal that only looks like a close.
 */
function callAt(src: string, from: number): string {
  const open = src.indexOf("(", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(from, i + 1);
  }
  return "";
}

const hooks: Hook[] = [];
for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".test.ts")) continue;
  const src = await Bun.file(join(DIR, f)).text();
  for (const m of src.matchAll(/before(?:All|Each)\(\s*async/g)) {
    const call = callAt(src, m.index!);
    /* `for (let i = 0; i < N; i++) { ... Bun.sleep(MS) }` — the readiness loop
       every one of these files writes, and the only wait long enough to matter.
       A hook with no such loop is not making a claim about patience. */
    const loop = call.match(/i\s*<\s*(\d+)\s*;[\s\S]{0,400}?Bun\.sleep\((\d+)\)/);
    if (!loop) continue;
    const named = call.match(/,\s*([A-Z_\d]+)\s*\)$/)?.[1];
    const budgetMs = named === "SERVER_BOOT_MS" ? SERVER_BOOT_MS
      : named ? Number(named.replaceAll("_", "")) || BUN_DEFAULT_HOOK_MS
        : BUN_DEFAULT_HOOK_MS;
    hooks.push({ file: f, kind: m[0].startsWith("beforeAll") ? "beforeAll" : "beforeEach",
      wantsMs: Number(loop[1]) * Number(loop[2]), budgetMs });
  }
}

describe("hooks that wait for a server", () => {
  test("the scan finds them, so a silent zero cannot pass this file", () => {
    /* The guard on the guard. A regex that stopped matching would leave every
       assertion below green over an empty list — the exact shape of failure
       this repository keeps paying for. Nineteen files, twenty hooks, at the
       time of writing. */
    expect(hooks.length, "the readiness-loop scan matched nothing").toBeGreaterThanOrEqual(15);
  });

  test("none of them is cut short by its runner", () => {
    const short = hooks
      .filter((h) => h.wantsMs > h.budgetMs)
      .map((h) => `${h.file}: ${h.kind} polls for ${h.wantsMs / 1000}s but is allowed ${h.budgetMs / 1000}s`);
    expect(short, "pass SERVER_BOOT_MS as the hook's second argument — see serverBoot.ts").toEqual([]);
  });

  test("and the shared budget clears the longest loop with room for a loaded machine", () => {
    // Not a round number picked for looking generous: it is above the longest
    // loop any of these files writes, which is what makes the loops meaningful.
    const longest = Math.max(...hooks.map((h) => h.wantsMs));
    expect(SERVER_BOOT_MS).toBeGreaterThan(longest);
  });
});

/*
 * Whether mobile's generated terminal bundle exists in this checkout.
 *
 * `nerdfont.generated.ts` and `engine.generated.ts` are written by mobile's
 * postinstall and are gitignored, so they exist only where `npm ci` has run —
 * which is `make mobile-test` and CI, and not a fresh worktree. terminal-html.ts
 * imports both at the top of the file, so a STATIC import of it (or of anything
 * that imports it) does not fail a test, it fails to LOAD the module: the whole
 * file errors out and `bun test` comes back red in every worktree a task cuts.
 *
 * Every test file that needs terminal-html.ts checks `built` first and reaches
 * it through a dynamic `import()`, so a missing bundle is a skip instead of a
 * load error. `announce()` is what makes that skip say why, since bun's own
 * summary line (`N skip`) does not.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const FILE_NAMES = ["nerdfont.generated.ts", "engine.generated.ts"];

/** Split out of `built` below so the lock test can point it at an empty
 *  directory instead of guessing at the check from source. */
export function allPresent(dir: string): boolean {
  return FILE_NAMES.every((f) => existsSync(join(dir, f)));
}

const TERMINAL_DIR = new URL("../src/terminal", import.meta.url).pathname;

export const built = allPresent(TERMINAL_DIR);

export const why = "needs mobile's generated terminal bundle — run `make mobile-test`, or `cd mobile && npm ci`";

export function announce(file: string, isBuilt: boolean = built): void {
  if (!isBuilt) console.log(`skipping ${file}: ${why}`);
}

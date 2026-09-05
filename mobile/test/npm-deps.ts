/*
 * Whether mobile's npm dependencies are installed in this checkout.
 *
 * `mobile/node_modules` is gitignored and is written by `npm install`, which
 * runs in `make mobile-test` and in CI and not in a fresh worktree. So four
 * test files came back red in every worktree a task cuts — not failing, but
 * failing to LOAD: `src/lib/pairing.ts` imports `@noble/curves`,
 * `@noble/hashes` and `@noble/ciphers` at the top of the file, and a static
 * import of it errors the whole module out before a single test runs.
 *
 *     error: Cannot find module '@noble/curves/nist.js'
 *            from '.../mobile/src/lib/pairing.ts'
 *     502 pass · 4 fail · 4 errors
 *
 * Same shape as `generated-artifacts.ts`, different question, and the
 * difference is the interesting part.
 *
 * WHY NOT `existsSync`, which is how the generated bundle is checked. That one
 * asks about two files this repo writes itself, at a path it chose. A node
 * dependency has no such path: npm may hoist it to a parent `node_modules`,
 * a workspace may put it somewhere else entirely, and pnpm stores the real
 * thing outside the tree and links to it. A path check would answer confidently
 * and be wrong on any of those — the worst kind of check, because it fails
 * CLOSED in the direction that skips tests that would have passed.
 *
 * SO ASK THE RESOLVER, which is the thing that was going to fail anyway.
 * Measured with `node_modules` moved aside:
 *
 *     import.meta.resolve("@noble/curves/nist.js")   THROWS ResolveMessage
 *     await import("@noble/curves/nist.js")          THROWS ResolveMessage
 *
 * Both answer. `import()` is the one used here because it proves the package
 * LOADS and not merely that a path could be computed for it — a half-written
 * install resolves and then throws on read, and that is a red suite either way,
 * so the check may as well be the same operation the tests do. It costs one
 * real import, cached for the rest of the process.
 *
 * `import.meta.resolve` also has a trap worth writing down: it resolves
 * relative to the file that CALLS it, so a bare specifier is safe here and a
 * relative one would silently answer about this directory. Measured — asking
 * for `./src/lib/b64.ts` from a scratch file returned a URL for a path that did
 * not exist, without throwing.
 */

/** Every bare specifier `src/lib/pairing.ts` reaches for. Listed rather than
 *  parsed out of the file: a list that drifts skips a test loudly (it says
 *  which command fixes it), while a parser that drifts fails a suite. */
export const SPECIFIERS = [
  "@noble/curves/nist.js",
  "@noble/hashes/hkdf.js",
  "@noble/hashes/sha2.js",
  "@noble/ciphers/aes.js",
] as const;

/** Split out so the lock can point it at a name nothing will ever provide,
 *  instead of guessing at the check from source. */
export async function allLoadable(specifiers: readonly string[] = SPECIFIERS): Promise<boolean> {
  for (const spec of specifiers) {
    try { await import(spec); } catch { return false; }
  }
  return true;
}

export const installed = await allLoadable();

export const why = "needs mobile's npm dependencies — run `cd mobile && npm install`, or `make mobile-test`";

/** bun's own summary says `N skip` and not which N or why. This says it. */
export function announce(file: string, isInstalled: boolean = installed): void {
  if (!isInstalled) console.log(`skipping ${file}: ${why}`);
}

type Pairing = typeof import("../src/lib/pairing.ts");

/**
 * The module under test, or something shaped enough like it to import.
 *
 * The generated-bundle files write one typed stub per symbol they use. Four
 * files share this one, between them naming eight of its exports, and a
 * hand-written stub list is a list that goes stale silently — the ninth export
 * gets used, the stub does not have it, and the failure is a destructure of
 * `undefined` in a suite that was meant to be skipped.
 *
 * So the stub answers for any name, and every answer throws. Nothing can call
 * one: every describe that touches this is behind `describe.skipIf(!installed)`,
 * and if one ever is not, the error names the reason instead of reading
 * `undefined is not a function`.
 */
export const pairing: Pairing = installed
  ? await import("../src/lib/pairing.ts")
  : (new Proxy({}, {
    get: (_t, name) => () => {
      throw new Error(`${String(name)} was reached with the dependencies missing — ${why}`);
    },
  }) as Pairing);

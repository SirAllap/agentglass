/*
 * The check that decides whether four other files run.
 *
 * `mobile/node_modules` is gitignored, so a fresh worktree has none, and
 * `src/lib/pairing.ts` imports three `@noble` packages at the top of the file.
 * A static import of it does not fail a test, it fails to LOAD the module —
 * measured with node_modules moved aside:
 *
 *     error: Cannot find module '@noble/curves/nist.js'
 *            from '.../mobile/src/lib/pairing.ts'
 *     502 pass · 4 fail · 4 errors
 *
 * After, on the same checkout, both directions measured by moving the
 * directory and putting it back:
 *
 *     without node_modules   502 pass · 36 skip · 0 fail, and four lines
 *                            saying which command would run them
 *     with node_modules      538 pass · 0 fail · 0 skipped for this reason
 *
 * The gate itself is what this file holds. It is worth its own test because it
 * is the piece that can fail SILENTLY: a check stuck on false skips 36 real
 * tests and the suite still says green, which is the failure mode that made
 * this necessary in the first place.
 */
import { describe, expect, test } from "bun:test";
import { allLoadable, announce, installed, pairing, SPECIFIERS, why } from "./npm-deps.ts";

describe("asking whether the dependencies are there", () => {
  test("a package that cannot be loaded answers false", async () => {
    // A name nothing will ever publish under, so this is the same answer a
    // fresh worktree gives — reached through the real resolver, not a stub.
    expect(await allLoadable(["@agentglass/definitely-not-a-real-package"])).toBe(false);
  });

  test("one missing out of several is still false", async () => {
    expect(await allLoadable(["node:path", "@agentglass/definitely-not-a-real-package"])).toBe(false);
  });

  test("and something that loads answers true", async () => {
    expect(await allLoadable(["node:path"])).toBe(true);
  });

  test("an empty list is true, not false", () => {
    // Nothing to be missing. The alternative — a `some`-shaped check that
    // answers false for an empty list — would skip everything the day the
    // list is emptied by a dependency being dropped.
    return allLoadable([]).then((r) => expect(r).toBe(true));
  });
});

describe("the answer it publishes", () => {
  test("is the one asking right now gives", async () => {
    /*
     * The failure this catches is the silent one, and it is the worse of the
     * two. A gate stuck TRUE fails loudly — the four files try to load the
     * module and error out, measured. A gate stuck FALSE skips 36 real tests
     * and the suite still reports green, which is a test deleted by accident
     * and nobody told.
     *
     * So `installed` is compared against a live ask, rather than either value
     * being asserted: this file cannot know which is right, and does not have
     * to. It only has to know they agree.
     */
    expect(installed).toBe(await allLoadable(SPECIFIERS));
  });
});

describe("what it says when it skips", () => {
  test("the reason names a command that fixes it", () => {
    // The whole point of announcing at all: bun's summary says `36 skip` and
    // not which, and a skip nobody can act on is a test quietly deleted.
    expect(why).toContain("npm install");
  });

  test("it says nothing when the dependencies are there", () => {
    const said: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { said.push(a.join(" ")); };
    try {
      announce("some.test.ts", true);
      expect(said).toEqual([]);
      announce("some.test.ts", false);
    } finally { console.log = log; }
    expect(said.length).toBe(1);
    expect(said[0]).toContain("some.test.ts");
    expect(said[0]).toContain(why);
  });
});

describe("the specifiers it asks about", () => {
  test("are the ones the module under test imports", async () => {
    // A list that drifts skips real tests, so it is checked against the file
    // rather than trusted. Read as text: importing it is the very thing that
    // does not work when this list matters.
    const src = await Bun.file(new URL("../src/lib/pairing.ts", import.meta.url)).text();
    const imported = [...src.matchAll(/^import .* from "(@[^"]+)";$/gm)].map((m) => m[1]!);
    // `Set<string>` on both sides: SPECIFIERS is `as const`, so its Set is of
    // the four literal types and `toEqual` refuses the comparison outright.
    // `bun test` was green on this — it strips the types — and `make check`
    // caught it the first time it ran, which is the whole argument for the
    // target this file's branch adds.
    expect(new Set<string>(SPECIFIERS)).toEqual(new Set(imported));
  });
});

describe.skipIf(!installed)("and when they are installed", () => {
  test("the real module is handed over, not the stub", () => {
    // The other half of the gate: `installed` true must mean the tests get the
    // thing, or 36 tests pass against a Proxy that answers anything.
    expect(typeof pairing.makeKeys).toBe("function");
  });
});

describe.skipIf(installed)("and when they are not", () => {
  test("touching the stub says why rather than `undefined is not a function`", () => {
    expect(() => (pairing as unknown as { anything: () => void }).anything())
      .toThrow(/npm install/);
  });
});

/*
 * The server's configuration is its environment and its own settings file, and
 * nothing it finds lying in the directory it happens to run in.
 *
 * A binary made by `bun build --compile` reads `.env` and `bunfig.toml` from
 * its working directory by default, and an installed sidecar's working
 * directory is whatever the app was launched from. Measured with a probe
 * binary: a `.env` there set a variable, and a `bunfig.toml` there ran a
 * preload before the first line of the server. Both are gitignored or look like
 * ordinary project files, so nothing in `git status` shows them. The same holds
 * for `bun run` in a checkout, closed with `--no-env-file`.
 *
 * A flag is invisible once it is in: the binary looks and behaves the same. So
 * the source is asserted here, and the behaviour was measured separately by
 * compiling the real server with and without the flags and starting each in a
 * directory holding a `.env` that named a database and a `bunfig.toml` with a
 * preload (isolated XDG dirs, a private port):
 *
 *   without the flags:  the named database was created, the preload ran
 *   with the flags:     the default database was used, the preload did not run
 *
 * Ceiling: this closes the two files the binary reads on its own. The sidecar
 * still starts in the launch directory, because a few features read it on
 * purpose (the open project's default root, the checkout it reports on), so
 * the working directory is not changed here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
/** Comment lines out, so a flag named in prose does not satisfy the check. */
const code = (rel: string) =>
  read(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join("\n");

const FLAGS = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"];

describe("the server does not read a .env or bunfig.toml from where it runs", () => {
  it("electron/build.mjs compiles the sidecar with both flags", () => {
    const src = code("electron/build.mjs");
    const at = src.indexOf('"--compile"');
    expect(at).not.toBe(-1);
    const call = src.slice(at, src.indexOf("]);", at));
    for (const f of FLAGS) expect(call).toContain(`"${f}"`);
  });

  it("the release workflow compiles the sidecar with both flags", () => {
    const src = code(".github/workflows/desktop-binaries.yml");
    const at = src.indexOf("bun build --compile");
    expect(at).not.toBe(-1);
    // The command continues across lines with a trailing backslash.
    const call = src.slice(at, src.indexOf("--outfile", at));
    for (const f of FLAGS) expect(call).toContain(f);
  });

  it("every compile in the build files carries both flags", () => {
    for (const rel of ["electron/build.mjs", ".github/workflows/desktop-binaries.yml"]) {
      const src = code(rel);
      const compiles = (src.match(/"--compile"|--compile(?=\s)/g) ?? []).length;
      const flagged = (src.match(/--no-compile-autoload-dotenv/g) ?? []).length;
      expect(compiles).toBeGreaterThan(0);
      expect(flagged).toBe(compiles);
    }
  });

  it("the dev server and the desktop dev spawn start bun with --no-env-file", () => {
    const pkg = JSON.parse(read("server/package.json"));
    expect(pkg.scripts.dev).toContain("--no-env-file");
    expect(pkg.scripts.start).toContain("--no-env-file");

    const main = code("electron/main.js");
    const at = main.indexOf('["bun", [');
    expect(at).not.toBe(-1);
    const spawnArgs = main.slice(at, main.indexOf("]];", at) + 1);
    expect(spawnArgs).toContain('"--no-env-file"');
    // `.env` is one file the launch directory can use to configure the server;
    // bunfig.toml (a preload that runs before main) is the other, and bun reads
    // the one in the cwd unless it is told which to read.
    expect(spawnArgs).toContain("--config=${path.join(REPO, \"server\", \"bunfig.toml\")}");
  });
});

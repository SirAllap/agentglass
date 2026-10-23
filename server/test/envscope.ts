/*
 * Every test file gets the AGENTGLASS_* environment it started with, back.
 *
 * `bun test` runs every file in one process, so a file that assigns
 * `process.env.AGENTGLASS_ROOT` and never puts it back hands the next file a
 * project root that may by now be a deleted temp directory. Sixty-odd files did
 * exactly that: each passes alone, and which one fails depends on what ran
 * before it. Fixing it at each call site is the approach that keeps failing —
 * the next file copies the assignment without the restore — so the runner does
 * it: this plugin wraps every `*.test.ts` as it is loaded.
 *
 *   - at the top, the AGENTGLASS_* variables are written down (one statement,
 *     on the file's own first line, so line numbers in a stack do not move);
 *   - at the very end, an `afterAll` puts them back. Registered last on
 *     purpose: Bun runs a file's `afterAll`s in the order they were written,
 *     so the file's own cleanup, which may still need the variable it set
 *     (a `kill-server` that reads the socket name), runs first.
 *
 * Why not one root `afterAll` in a preload: measured on Bun 1.3.9, a hook
 * registered by a preload runs once for the whole run, not once per file.
 *
 * Its ceiling: only AGENTGLASS_* is restored. HOME, PATH and the XDG bases are
 * isolation.ts's; a global that is not an environment variable is the file's.
 */
import { plugin } from "bun";

const SNAP = "__agxEnvSnap";

plugin({
  name: "agx-env-scope",
  setup(build) {
    build.onLoad({ filter: /\.test\.ts$/ }, async (args) => {
      const src = await Bun.file(args.path).text();
      const mod = JSON.stringify(import.meta.dir + "/envscopeRuntime.ts");
      return {
        loader: "ts",
        contents:
          `import { snapshotEnv as __agxSnapshotEnv, restoreEnvAfterAll as __agxRestoreEnvAfterAll } from ${mod}; const ${SNAP} = __agxSnapshotEnv(); ` +
          src + `\n__agxRestoreEnvAfterAll(${SNAP});\n`,
      };
    });
  },
});

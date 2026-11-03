/*
 * A test that boots the real server writes wherever the server writes: the
 * browser audit log, the container ledger, the engine's tmux conf, and now the
 * child ledger a boot reap reads, all under the state directory. Measured on
 * 2026-09-05: twenty-four suites jailed XDG_CONFIG_HOME and the database and
 * left the state directory alone, and the developer's real
 * ~/.local/state/agentglass/browser-audit.log had grown to 1.2 MB of test
 * fixtures ("agent-four", "t-gone").
 *
 * The child ledger makes the omission worse than a stray file: a booted server
 * reaps the children recorded in the directory it reads, so a suite pointing
 * at the real one can stop the live monitors of a running desktop app. The
 * detector is the one tmux-test-isolation.ts uses for the same population —
 * a spawn AND the entry point named the way an argv names it — because
 * `serve-proxy.test.ts` builds its argv into a variable and the earlier
 * literal argv match never saw the two servers it starts, and
 * `spawn("bun", ["run", src])` (node:child_process, seven suites plus the
 * fixture harness) was a third spelling it never saw either. Everything under
 * the test directory is scanned, `fixtures/` included, because that is where
 * the harness those suites boot through lives.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const self = "server-boot-jails-state.test.ts";

/** A file that starts the real server as a child process. Comments are
 *  flattened first: the tmux lint describes this same population in prose and
 *  would otherwise match itself. */
const spawnsTheServer = (source: string): boolean => {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");
  return /(?:Bun\.)?spawn(?:Sync)?\(/.test(src) && /"bun",\s*\[?"run"/.test(src) && src.includes("src/index.ts");
};

/** Every `.ts` file below the test directory, `fixtures/` included, as the
 *  path a person would say plus its source. */
function sources(dir: string, rel = ""): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...sources(dir, path));
    else if (entry.name.endsWith(".ts") && path !== self) {
      out.push({ rel: path, src: readFileSync(join(dir, path), "utf8") });
    }
  }
  return out;
}

const suites = sources(here).filter((f) => spawnsTheServer(f.src));

describe("every file that boots the server", () => {
  test("names a state directory of its own", () => {
    // The colon is the object key handed to the child. A test may also read
    // `process.env.AGENTGLASS_STATE_DIR` to clean up afterwards; that is not
    // an environment the server was given.
    const offenders = suites
      .filter((f) => !/AGENTGLASS_STATE_DIR:|XDG_STATE_HOME:/.test(f.src))
      .map((f) => f.rel);
    expect(offenders, "boots src/index.ts without AGENTGLASS_STATE_DIR in the child's env, so its boot reap reads the developer's real child ledger; give the child a directory of its own (server/test/serve-proxy.test.ts is the shape)").toEqual([]);
  });

  test("the lint is looking at the files it thinks it is", () => {
    // A guard on the guard: a detector that stopped matching would leave this
    // file green while protecting nothing. serve-proxy by name, because it is
    // the shape the earlier literal match missed; the fixture harness, because
    // it is outside the flat listing the previous version scanned.
    const rels = suites.map((f) => f.rel);
    expect(rels).toContain("serve-proxy.test.ts");
    expect(rels).toContain(join("fixtures", "workerHarness.ts"));
    expect(rels.length).toBeGreaterThanOrEqual(15);
  });

  test("the detector sees both ways a suite spells the command", () => {
    // A bun argv built inline, and the node:child_process shape with the argv
    // second. One literal shape at a time is how this guard has failed twice.
    // The command is built rather than written out: the tmux lint scans test
    // sources for this same shape and would read the fixture as a suite that
    // boots a server.
    const run = [JSON.stringify("bun"), JSON.stringify("run")].join(", ");
    expect(spawnsTheServer(`Bun.spawn([${run}, "server/src/index.ts"])`)).toBe(true);
    expect(spawnsTheServer(`const SERVER_SRC = "server/src/index.ts";\nspawn(${run}, [SERVER_SRC])`)).toBe(true);
  });
});

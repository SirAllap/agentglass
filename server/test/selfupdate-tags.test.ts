// A fetch failure and a tagless-but-reachable remote are different answers:
// readRemoteTags returns null for the former, [] for the latter, so updateStatus
// can stop telling an offline user to go publish a tag.
//
// Loaded through a fresh dynamic import, not a static one: selfupdate.ts reads
// AGENTGLASS_UPDATE_SRC into a module-load const, so a static import here would
// initialise the shared module with whatever env happened to be set. Each suite
// that cares about SRC now takes its own instance — release-notes.test.ts no
// longer relies on being the first importer, because being first is not
// something a test file can assert or defend.
import { describe, expect, test } from "bun:test";

const load = async () => await import(`../src/selfupdate.ts?u=${Math.random()}`);

describe("remoteTags", () => {
  test("a fetch failure is null, not an empty list", async () => {
    const { remoteTags } = await load();
    // A local path that is not a git repo makes `git ls-remote` exit non-zero
    // immediately — a stand-in for offline / bad origin, without a network wait.
    expect(await remoteTags("/tmp/agx-definitely-not-a-repo-xyz")).toBeNull();
  });

  test("no origin is an empty list, not a failure", async () => {
    const { remoteTags } = await load();
    expect(await remoteTags("")).toEqual([]);
  });
});

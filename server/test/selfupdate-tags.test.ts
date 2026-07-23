// A fetch failure and a tagless-but-reachable remote are different answers:
// readRemoteTags returns null for the former, [] for the latter, so updateStatus
// can stop telling an offline user to go publish a tag.
//
// Loaded through a fresh dynamic import, not a static one: selfupdate.ts reads
// AGENTGLASS_UPDATE_SRC into a module-load const, and release-notes.test.ts
// depends on being the module's first importer. A static import here would
// initialise the shared module early and break that, order-dependently.
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

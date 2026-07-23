import { afterEach, describe, expect, it } from "bun:test";
import { dockerCapability, dockerBin, __resetDockerCapForTest } from "../src/docker.ts";

/**
 * Whether docker is on this machine, told apart from "the daemon is down".
 *
 * The whole docker panel assumes the CLI exists, and Bun.spawn *throws* on a
 * missing binary rather than returning 127 — so without dockerBin() the caught
 * ENOENT stderr masquerades as the daemon answering "no", and the panel blames a
 * daemon it never contacted. These flip PATH the way git-capability's own test
 * does, which is exactly what an installer user with no docker hits.
 */
const realPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = realPath;
  __resetDockerCapForTest();
});

describe("docker capability", () => {
  it("reports docker as MISSING when it is not on PATH, and does NOT blame the daemon", async () => {
    // The installer-user case: docker simply is not installed. Bun.which returns
    // null against an empty PATH, and the reason must send them to *install*,
    // never to check a daemon that was never there — that conflation is the bug.
    process.env.PATH = "";
    __resetDockerCapForTest();
    const cap = await dockerCapability();
    expect(cap.available).toBe(false);
    expect(cap.version).toBeUndefined();
    expect(cap.reason && cap.reason.length).toBeGreaterThan(0);
    expect(cap.reason?.toLowerCase()).not.toContain("daemon");
    expect(dockerBin()).toBeNull();
  });

  it("always answers with a shape the client can read", async () => {
    __resetDockerCapForTest();
    const cap = await dockerCapability();
    expect(typeof cap.available).toBe("boolean");
    if (!cap.available) expect(typeof cap.reason).toBe("string");
  });

  it("when docker IS installed, available is decided by the binary, not the daemon", async () => {
    // Conditional on this box actually having docker — unlike git, it may not.
    // When it does, `available` is true whether or not the daemon answers: the
    // (b) daemon-down and (c) OK states both mean "installed", and differ only
    // in version/reason.
    __resetDockerCapForTest();
    const bin = dockerBin();
    if (!bin) return; // no docker here — the MISSING test covers that path
    const cap = await dockerCapability();
    expect(cap.available).toBe(true);
    if (cap.version) expect(cap.reason).toBeUndefined();      // (c) OK
    else expect(typeof cap.reason).toBe("string");            // (b) daemon down
  });
});

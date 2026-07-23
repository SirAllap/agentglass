import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerCapability, dockerBin, __resetDockerCapForTest, __expireDockerVersionForTest } from "../src/docker.ts";

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

  it("re-detects a daemon that dies after its version was cached", async () => {
    // The bug: a success was cached for good, so a daemon that stopped
    // mid-session still reported a version — a phantom daemon. A fake docker
    // whose answer we flip lets us cache a version, kill the daemon, and confirm
    // the next probe (past the liveness window) drops the version and reports it
    // down instead of vouching for a server that no longer answers.
    const bin = mkdtempSync(join(tmpdir(), "agx-fakedocker-"));
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nif [ -f "${bin}/down" ]; then\n`
        + `  echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2\n  exit 1\nfi\necho "27.1"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = bin;
    __resetDockerCapForTest();

    // Daemon up → available with a version.
    let cap = await dockerCapability();
    expect(cap.available).toBe(true);
    expect(cap.version).toBe("27.1");

    // Daemon dies; the liveness window elapses.
    writeFileSync(join(bin, "down"), "");
    __expireDockerVersionForTest();

    cap = await dockerCapability();
    expect(cap.available).toBe(true);        // the CLI is still installed
    expect(cap.version).toBeUndefined();     // but no version for a dead daemon
    expect(cap.reason?.toLowerCase()).toContain("daemon");

    rmSync(bin, { recursive: true, force: true });
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

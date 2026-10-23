/*
 * `make ci-docker` runs the CI jobs with core dumps off.
 *
 * A tmux test kills its server on purpose and the container's tmux 3.4 aborts
 * on the way down. Each abort was handed to the host's systemd-coredump, which
 * compressed and stored it: 95 cores in ten days on one machine. With
 * RLIMIT_CORE at zero the crash is still listed there, with no core file.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const RUN = await Bun.file(join(import.meta.dir, "..", "..", "scripts", "ci-docker", "run.sh")).text();

describe("ci-docker", () => {
  test("starts its container with RLIMIT_CORE at zero", () => {
    const lines = RUN.split("\n").filter(l => !l.trim().startsWith("#") && /\bdocker run\b/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/\s--ulimit core=0\s/);
  });
});

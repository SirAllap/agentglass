import { describe, expect, test } from "bun:test";
// electron/ is plain CommonJS with no build step.
const { decideRespawn } = require("../../electron/respawn.js");

const base = { started: true, quitting: false, now: 1_000_000, failures: [] as number[] };

describe("decideRespawn", () => {
  test("a started sidecar that dies comes back after 1 s", () => {
    expect(decideRespawn(base)).toEqual({ respawn: true, delayMs: 1000, failures: [1_000_000] });
  });
  test("backoff grows: 3 s then 10 s", () => {
    expect(decideRespawn({ ...base, failures: [950_000] }).delayMs).toBe(3000);
    expect(decideRespawn({ ...base, failures: [950_000, 980_000] }).delayMs).toBe(10000);
  });
  test("quitting never respawns", () => {
    expect(decideRespawn({ ...base, quitting: true }).respawn).toBe(false);
  });
  test("three earlier failures within 2 minutes gives up", () => {
    const r = decideRespawn({ ...base, failures: [900_000, 950_000, 980_000] });
    expect(r.respawn).toBe(false);
  });
  test("old failures fall out of the window", () => {
    const r = decideRespawn({ ...base, failures: [100_000, 200_000, 300_000] });
    expect(r).toEqual({ respawn: true, delayMs: 1000, failures: [1_000_000] });
  });
  test("never started keeps the port banner", () => {
    expect(decideRespawn({ ...base, started: false }).respawn).toBe(false);
  });
});

// A worker token nobody looks up again used to sit in the map forever:
// mintWorkerToken only ever added, and the map was only ever swept on
// lookup (workerTokenLive / the bearer check), which most minted tokens
// never get. Minting now sweeps expired entries itself.
import { describe, expect, test } from "bun:test";
import { mintWorkerToken, workerTokenCount, revokeWorkerTokens } from "../src/auth.ts";

describe("worker token sweep on mint", () => {
  test("1000 asks with already-expired tokens leave the map bounded", () => {
    // Measured on the m40 run (18 files in one process): the token map is module-global,
    // and live tokens other files minted before this one stay in it, so the absolute
    // `< 10` failed there while the file alone passes. The claim is that the 1000 expired
    // entries are not kept, so it is counted against what was already live.
    const before = workerTokenCount();
    for (let i = 0; i < 1000; i++) {
      mintWorkerToken(`worker-${i}`, -1); // expiresAt in the past the instant it's minted
    }
    // The next mint sweeps every expired entry before adding its own.
    mintWorkerToken("latest", 60_000);
    expect(workerTokenCount()).toBeLessThanOrEqual(before + 1);
    revokeWorkerTokens("latest");
  });
});

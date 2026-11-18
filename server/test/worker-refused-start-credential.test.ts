/*
 * A start, resume or engine switch that is REFUSED takes back the credential it
 * minted and no other. A seat that retried `start` under the name of a running
 * worker used to cut that worker's browser credential (every call 401 after the
 * retry), because the refusal revoked every credential of the name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { revokeWorkerToken, revokeWorkerTokens, workerTokenLive } from "../src/auth.ts";
import { mintBrowserCredential } from "../src/browseraccess.ts";

const SRC = readFileSync(new URL("../src/agents/policystart.ts", import.meta.url), "utf8");

describe("a refused turn start and the credential of a running worker", () => {
  test("a start that mints beside a running worker, then is refused, leaves the worker's token live", () => {
    const name = "orbit-worker";
    const running: Record<string, string> = {};
    mintBrowserCredential(running, name, "opencode", "builder", { replace: false });
    const held = running.AGENTGLASS_TOKEN!;
    const retry: Record<string, string> = {};
    const minted = mintBrowserCredential(retry, name, "opencode", "builder", { replace: false })!;
    expect(minted).not.toBe(held);
    revokeWorkerToken(minted);
    expect(workerTokenLive(held)).toBe(true);
    revokeWorkerTokens(name);
  });

  test("policystart revokes only the token it minted, and never by name, outside a turn's end", () => {
    // `endedTurn` is the one place a name's credentials end together.
    const outside = SRC.replace(/export async function endedTurn[\s\S]*?\n}\n/, "");
    expect(outside).not.toMatch(/revokeWorkerTokens\(/);
    expect(SRC.match(/revokeWorkerToken\(minted\)/g)?.length).toBe(3);
    // The start path must not replace a running worker's credential before it knows the name is free.
    expect(SRC).toMatch(/root: p\.policyRoot, replace: false/);
  });
});

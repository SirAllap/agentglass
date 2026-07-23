// The CSRF fix rides on this contract: passing loopbackOnly=false forces a
// token to exist, and the surface's token gate then requires it. index.ts passes
// `LOOPBACK_ONLY && !TRUST_LAN`, so enabling TRUST_LAN (which widens the origin
// gate to trust private-IP pages) makes this false and a token mandatory — a
// LAN-origin page then can't drive token-less writes through a loopback server.
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToken } from "../src/auth.ts";

beforeEach(() => {
  // A fresh config home per assertion so a persisted token from one doesn't
  // decide the next, and no ambient env token.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-auth-"));
  delete process.env.AGENTGLASS_TOKEN;
});

describe("resolveToken", () => {
  test("loopback-only with no env token skips auth (token null)", () => {
    expect(resolveToken(true).token).toBeNull();
  });

  test("not loopback-only requires a token — this is what TRUST_LAN forces", () => {
    const auth = resolveToken(false);
    expect(auth.token).toBeTruthy();
    expect(auth.token!.length).toBeGreaterThan(16);
  });

  test("an explicit env token always wins, even loopback-only", () => {
    process.env.AGENTGLASS_TOKEN = "sekret-token-value";
    expect(resolveToken(true).token).toBe("sekret-token-value");
  });
});

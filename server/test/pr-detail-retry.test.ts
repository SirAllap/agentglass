/*
 * A pull request read that comes back empty is usually gh or the network
 * blinking, and the same page loads seconds later — an error that fixed itself.
 * The read asks again once before it reports anything, and when it does report,
 * it says which of the two it was.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();
const start = src.indexOf("const ask = () => Promise.all([");
const body = src.slice(start, src.indexOf("const mergePolicy = mergePolicyOf(", start));

describe("the pull request detail read", () => {
  it("asks a second time before it gives up", () => {
    expect(start).toBeGreaterThan(0);
    expect(body.match(/await ask\(\)/g)?.length).toBe(2);
    expect(body).toContain("setTimeout(r, 1500)");
  });

  it("asks the free rate_limit endpoint before it retries, and says when the quota returns", () => {
    expect(body).toContain("graphqlQuotaGone(");
    expect(body.indexOf("graphqlQuotaGone(")).toBeLessThan(body.indexOf("await ask();", body.indexOf("graphqlQuotaGone(")));
    expect(src).toContain('"query={rateLimit{remaining}}"');
    expect(src).toContain("quota for this account is used up");
  });

  it("tells a silent gh from a pull request that is not there", () => {
    expect(body).toContain("GitHub did not answer");
    expect(body).toContain("pull request not found on this repository");
    expect(body).not.toContain("could not reach the host");
  });
});

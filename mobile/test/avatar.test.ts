/*
 * Where a face comes from: one address per person, through the computer, and
 * nothing asked for an automation account or a dead address.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AVATAR, githubFace, hueOf, isBotLogin, isDead, markDead } from "../src/model/avatar.ts";

const host = { origin: "http://192.168.1.20:4713", token: "tok" };

describe("githubFace", () => {
  test("goes through the computer's proxy at size 96, with the phone's credential", () => {
    const f = githubFace(host, "ada");
    expect(f).not.toBeNull();
    const url = new URL(f!.uri);
    expect(url.origin + url.pathname).toBe("http://192.168.1.20:4713/prs/asset");
    expect(url.searchParams.get("url")).toBe("https://avatars.githubusercontent.com/ada?size=96");
    expect(f!.headers.authorization).toBe("Bearer tok");
  });

  test("the same login is the same string, so the image cache asks once", () => {
    expect(githubFace(host, "ada")!.uri).toBe(githubFace(host, "ada")!.uri);
    expect(githubFace(host, "ada")!.uri).not.toBe(githubFace(host, "bob")!.uri);
  });

  test("a login with odd characters is escaped, not spliced into the address", () => {
    const raw = new URL(githubFace(host, "a/b?c")!.uri).searchParams.get("url")!;
    expect(raw).toBe("https://avatars.githubusercontent.com/a%2Fb%3Fc?size=96");
  });

  test("an automation account, nobody, and no computer ask for nothing", () => {
    expect(githubFace(host, "orbit-ci[bot]")).toBeNull();
    expect(githubFace(host, "")).toBeNull();
    expect(githubFace(host, undefined)).toBeNull();
    expect(githubFace(null, "ada")).toBeNull();
  });
});

test("a [bot] suffix is what makes a login automation", () => {
  expect(isBotLogin("orbit-ci[bot]")).toBe(true);
  expect(isBotLogin("orbit-ci")).toBe(false);
});

test("the four sizes are the spec's", () => {
  expect(Object.values(AVATAR)).toEqual([24, 28, 34, 44]);
});

test("a name is always the same hue, and the hue is a real one", () => {
  expect(hueOf("ada")).toBe(hueOf("ADA"));
  for (const n of ["ada", "bob", "cy", "dee", "eli", ""]) {
    expect(hueOf(n)).toBeGreaterThanOrEqual(0);
    expect(hueOf(n)).toBeLessThan(360);
  }
  expect(new Set(["ada", "bob", "cy", "dee", "eli"].map(hueOf)).size).toBeGreaterThan(3);
});

describe("a picture that failed is not asked for again for ten minutes", () => {
  const uri = "http://192.168.1.20:4713/prs/asset?url=dead";
  afterEach(() => markDead(uri, -1e12));
  test("dead until the window closes, then worth another try", () => {
    expect(isDead(uri, 0)).toBe(false);
    markDead(uri, 1_000);
    expect(isDead(uri, 1_000 + 9 * 60_000)).toBe(true);
    expect(isDead(uri, 1_000 + 10 * 60_000)).toBe(false);
  });
});

/*
 * The deputy's runs died with `ENOENT: posix_spawn 'bun'`.
 *
 * `bun test` and `bun install` were spawned as the bare word, which resolves
 * against the PATH of whatever started the app — a shell while developing, a
 * desktop launcher in the packaged build. The run ended in forty seconds, its
 * empty worktree was swept, and the register said the branch was gone.
 *
 * These drive the resolver against a fake filesystem: the bug is entirely
 * about which paths are tried and what happens when none of them is there.
 */
import { describe, expect, test } from "bun:test";
import { bunBin, bunCandidates, NO_BUN } from "../src/bunbin.ts";

const only = (...there: string[]) => (p: string) => there.includes(p);

describe("finding bun from inside the app", () => {
  test("an explicit AGENTGLASS_BUN wins over everything", () => {
    const env = { AGENTGLASS_BUN: "/opt/mine/bun", BUN_INSTALL: "/home/x/.bun" };
    expect(bunBin(env, "/home/x", only("/opt/mine/bun", "/home/x/.bun/bin/bun"))).toBe("/opt/mine/bun");
  });

  test("then BUN_INSTALL, then the home install, then the machine's own", () => {
    expect(bunBin({ BUN_INSTALL: "/home/x/.bun" }, "/home/x", only("/home/x/.bun/bin/bun", "/usr/bin/bun")))
      .toBe("/home/x/.bun/bin/bun");
    expect(bunBin({}, "/home/x", only("/home/x/.bun/bin/bun", "/usr/bin/bun"))).toBe("/home/x/.bun/bin/bun");
    expect(bunBin({}, "/home/x", only("/usr/bin/bun"))).toBe("/usr/bin/bun");
  });

  test("nothing on disk is \"\", not the bare word — the caller has to be able to say so", () => {
    expect(bunBin({}, "/home/x", () => false)).toBe("");
  });

  test("and the sentence for that case names the places it looked", () => {
    const says = NO_BUN({ BUN_INSTALL: "/home/x/.bun" }, "/home/x");
    expect(says).toContain("/home/x/.bun/bin/bun");
    expect(says).toContain("AGENTGLASS_BUN");
  });

  test("the candidate list never repeats a path", () => {
    const c = bunCandidates({ AGENTGLASS_BUN: "/usr/bin/bun" }, "/home/x");
    expect(new Set(c).size).toBe(c.length);
  });

  test("and on THIS machine it finds one, which is why the suite you are reading runs", () => {
    expect(bunBin()).not.toBe("");
  });
});

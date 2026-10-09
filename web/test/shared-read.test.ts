/*
 * Callers of /git/repos share one answer, and a git change ends the sharing.
 *
 * Measured on an isolated server: one git write was 4 reads of /git/repos, all
 * identical, two inside the same second (26 callers, each asking for itself on
 * open and again when the "git changed" frame rang).
 */
import { describe, expect, it } from "bun:test";
import { forgetShared, sharedRead } from "../src/lib/sharedRead.ts";
import { gitChanged } from "../src/lib/gitBus.ts";

const src = (rel: string) => Bun.file(new URL(`../src/${rel}`, import.meta.url)).text();
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("sharedRead", () => {
  it("runs the load once for callers that overlap, and for a while after", async () => {
    forgetShared();
    let runs = 0;
    const load = async () => { runs++; await tick(); return runs; };
    const [a, b, c] = await Promise.all([sharedRead("k", 500, load), sharedRead("k", 500, load), sharedRead("k", 500, load)]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(await sharedRead("k", 500, load)).toBe(1);
    expect(runs).toBe(1);
  });

  it("asks again once the window has passed", async () => {
    forgetShared();
    let runs = 0;
    await sharedRead("w", 5, async () => ++runs);
    await tick(20);
    await sharedRead("w", 5, async () => ++runs);
    expect(runs).toBe(2);
  });

  it("a change ends it, and a read that began before the change is not handed on after it", async () => {
    forgetShared();
    let runs = 0;
    const slow = async () => { runs++; await tick(30); return "before"; };
    const early = sharedRead("g", 5_000, slow);
    forgetShared();
    const late = await sharedRead("g", 5_000, async () => { runs++; return "after"; });
    expect(late).toBe("after");
    expect(await early).toBe("before");
    // …and what the late caller read is what is held, not the early one's.
    expect(await sharedRead("g", 5_000, async () => "never")).toBe("after");
    expect(runs).toBe(2);
  });

  it("a failed read is not remembered", async () => {
    forgetShared();
    await expect(sharedRead("f", 5_000, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(await sharedRead("f", 5_000, async () => "up")).toBe("up");
  });

  it("the server's git-changed frame drops what is held, before its listeners run", async () => {
    forgetShared();
    let runs = 0;
    await sharedRead("bus", 5_000, async () => ++runs);
    gitChanged();
    await sharedRead("bus", 5_000, async () => ++runs);
    expect(runs).toBe(2);
  });
});

describe("the wiring", () => {
  it("gitRepos goes through it and a git POST drops it", async () => {
    const api = await src("lib/api.ts");
    expect(api).toContain('gitRepos: () => sharedRead("git/repos"');
    expect(api).toContain('const git = path.startsWith("/git/");');
    expect(api).toContain("if (git) forgetShared();");
  });
});

// The orphan sweep: the pure decision, the live-checkout reader and the one volume remover.
import { describe, expect, test } from "bun:test";
import { decideOrphans, listOrphans, parseLiveCheckouts, removeOrphanVolume, type OrphanInput } from "../src/dockerorphans.ts";
import type { Runner } from "../src/diskclean.ts";
import { matchTagTemplate, oldCommitRefs, shaMatches } from "../../shared/dockerTag.ts";

const HEAD = "a".repeat(7) + "1".repeat(33);
const OLD = "b".repeat(7) + "2".repeat(33);
const PORCELAIN = `worktree /code/orbit\nHEAD ${HEAD}\nbranch refs/heads/main\n\nworktree /code/orbit-ORBIT-1042-fix\nHEAD ${"c".repeat(40)}\nbranch refs/heads/ORBIT-1042-fix\n`;

const base = (over: Partial<OrphanInput>): OrphanInput => ({
  template: "app:{sha}", volumePatterns: ["app-cache-{slug}"], keep: [], images: [], volumes: [],
  usedImages: new Set(), mountedVolumes: new Set(), live: { heads: [HEAD], slugs: ["orbit-1042", "orbit-1042-fix", "orbit"] }, ...over,
});

describe("decideOrphans", () => {
  test("only the dead slug volume and the dead-commit image are listed, each with its reason", () => {
    const anon = "f".repeat(64);
    const out = decideOrphans(base({
      images: [
        { id: "i1", ref: `app:${HEAD.slice(0, 11)}`, bytes: 10 },      // a live HEAD
        { id: "i2", ref: `app:${OLD.slice(0, 7)}`, bytes: 20 },        // a dead commit
      ],
      volumes: [
        { name: anon, bytes: 1 },                                      // anonymous: holds database data
        { name: "app-cache-orbit-0001", bytes: 5 },                    // dead slug, listed
        { name: "app-cache-orbit-1042", bytes: 5 },                    // live slug
        { name: "app-cache-orbit-0002", bytes: 5 },                    // a stopped container mounts it
        { name: "app-cache-orbit-0003-postgres", bytes: 5 },           // keep-listed
      ],
      mountedVolumes: new Set(["app-cache-orbit-0002"]),
      keep: ["*postgres*"],
    }));
    expect(out.map((o) => [o.kind, o.target])).toEqual([["image", `app:${OLD.slice(0, 7)}`], ["volume", "app-cache-orbit-0001"]]);
    expect(out[0]!.reason).toContain("no checkout is on");
    expect(out[1]!.reason).toBe("no checkout is on orbit-0001");
  });

  test("an image a container uses is never listed, by tag or by id", () => {
    const images = [{ id: "abc123abc123", ref: `app:${OLD.slice(0, 7)}`, bytes: 1 }, { id: "def456def456", ref: `app:${OLD.slice(0, 8)}`, bytes: 1 }];
    expect(decideOrphans(base({ images, usedImages: new Set([`app:${OLD.slice(0, 7)}`, "def456def456"]) }))).toEqual([]);
  });

  test("with no volume patterns no volume is ever listed", () => {
    expect(decideOrphans(base({ volumePatterns: [], volumes: [{ name: "app-cache-orbit-0001", bytes: 1 }] }))).toEqual([]);
  });

  test("a {slug}-only template needs a card-shaped slug: latest and dev are no checkout", () => {
    const images = ["latest", "dev", "orbit-0007", "orbit-1042"].map((t, n) => ({ id: `i${n}`, ref: `app:${t}`, bytes: 1 }));
    expect(decideOrphans(base({ template: "app:{slug}", images })).map((o) => o.target)).toEqual(["app:orbit-0007"]);
  });

  test("{slug}-{sha}: orphaned when either owner is gone", () => {
    const images = [
      { id: "1", ref: `app:orbit-1042-${HEAD.slice(0, 7)}`, bytes: 1 },   // both live
      { id: "2", ref: `app:orbit-1042-${OLD.slice(0, 7)}`, bytes: 1 },    // slug live, commit gone
      { id: "3", ref: `app:orbit-0009-${HEAD.slice(0, 7)}`, bytes: 1 },   // commit live, slug gone
    ];
    expect(decideOrphans(base({ template: "app:{slug}-{sha}", images })).map((o) => o.id)).toEqual(["2", "3"]);
  });
});

describe("parseLiveCheckouts", () => {
  test("full HEADs of the main checkout and every worktree; a checkout about to go is skipped", () => {
    expect(parseLiveCheckouts(PORCELAIN)!.heads).toEqual([HEAD, "c".repeat(40)]);
    const l = parseLiveCheckouts(PORCELAIN, "/code/orbit-ORBIT-1042-fix")!;
    expect(l.heads).toEqual([HEAD]);
    expect(l.slugs).not.toContain("orbit-1042");
  });
});

describe("tag template rule", () => {
  test("7 and 11 characters of a live HEAD are both kept, 7 of an old commit is not", () => {
    expect(shaMatches(HEAD.slice(0, 7), HEAD)).toBe(true);
    expect(shaMatches(HEAD.slice(0, 11), HEAD)).toBe(true);
    expect(shaMatches(OLD.slice(0, 7), HEAD)).toBe(false);
    expect(shaMatches("abc", HEAD)).toBe(false);
  });
  test("the three template shapes capture their parts", () => {
    expect(matchTagTemplate("app:{sha}", `app:${HEAD.slice(0, 7)}`)).toEqual({ sha: HEAD.slice(0, 7) });
    expect(matchTagTemplate("app:{slug}-{sha}", `app:orbit-1042-${HEAD.slice(0, 11)}`)).toEqual({ slug: "orbit-1042", sha: HEAD.slice(0, 11) });
    expect(matchTagTemplate("app:{slug}", "app:orbit-1042")).toEqual({ slug: "orbit-1042" });
    expect(matchTagTemplate("app:{sha}", "other:abcdef1")).toBeNull();
  });
  test("the Images view: of 4 sha tags, one on a live HEAD, 3 are badged", () => {
    const refs = [`app:${HEAD.slice(0, 11)}`, "app:1111111", "app:2222222", "app:3333333"];
    expect(oldCommitRefs("app:{sha}", refs, [HEAD])).toEqual(refs.slice(1));
  });
});

describe("removeOrphanVolume", () => {
  const stub = (mounted: string[]) => {
    const calls: string[] = [];
    const run: Runner = async (_c, args) => {
      calls.push(args.join(" "));
      if (args[0] === "ps") return { code: 0, stdout: mounted.join("\n"), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  };
  const cfg = { volumePatterns: ["app-cache-{slug}"], keep: ["*postgres*"] };

  test("refuses when a container mounts the volume at removal time, and never calls volume rm", async () => {
    const s = stub(["web-1"]);
    const r = await removeOrphanVolume(s.run, "app-cache-orbit-0001", cfg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("web-1");
    expect(s.calls.some((c) => c.startsWith("volume rm"))).toBe(false);
  });
  test("removes without -f when nothing mounts it, after re-reading the mounts", async () => {
    const s = stub([]);
    expect((await removeOrphanVolume(s.run, "app-cache-orbit-0001", cfg)).ok).toBe(true);
    expect(s.calls).toEqual(["ps -a --filter volume=app-cache-orbit-0001 --format {{.Names}}", "volume rm app-cache-orbit-0001"]);
  });
  test("refuses an anonymous volume, a keep-listed one and one no pattern names", async () => {
    const s = stub([]);
    for (const n of ["f".repeat(64), "app-cache-orbit-1-postgres", "node_modules-x"]) expect((await removeOrphanVolume(s.run, n, cfg)).ok).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

describe("listOrphans", () => {
  const usage = { perImage: [], perVolume: [] };
  const cfg = { template: "app:{sha}", volumePatterns: [], keep: [] };
  test("a docker or git that does not answer is a could-not-check state, not an empty list", async () => {
    const down: Runner = async () => ({ code: 1, stdout: "", stderr: "Cannot connect" });
    const r = await listOrphans(down, "/code/orbit", cfg, usage);
    expect(r.orphans).toEqual([]);
    expect(r.error).toStartWith("could not check:");
    const gitOnly: Runner = async (c) => (c === "git" ? { code: 0, stdout: PORCELAIN, stderr: "" } : { code: 1, stdout: "", stderr: "x" });
    expect((await listOrphans(gitOnly, "/code/orbit", cfg, usage)).error).toContain("docker did not list the containers");
    const fine: Runner = async (c) => ({ code: 0, stdout: c === "git" ? PORCELAIN : "", stderr: "" });
    expect((await listOrphans(fine, "/code/orbit", cfg, usage)).error).toBeUndefined();
  });
});

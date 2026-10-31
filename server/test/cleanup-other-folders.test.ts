// "Other folders": a card's leftovers that do not start with its id (a baseline checkout named by the number),
// found by patterns with {card} and {number}. Real git in a temp directory, fake home and fake docker.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { otherFolderRe, otherFolderRefusal, parseCleanupConfig, parseCleanupOtherFolders, planCleanup, runCleanup, runItem, type CleanupPlan } from "../src/cleanup.ts";
import type { Runner } from "../src/diskclean.ts";
import { PR, fakeProcess, makeWorld, put, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());
const others = (p: CleanupPlan) => p.items.filter((i) => i.kind === "other-folder").map((i) => i.target).sort();
/** A baseline checkout of the repository, detached or on its trunk, named by the number only. */
const baseline = (name: string, ...extra: string[]) => { const p = join(w.root, name); w.git(w.main, "worktree", "add", "-q", ...extra, p, ...(extra.length ? ["origin/main"] : [])); return p; };
const pat = () => join(w.root, "orbit-pol-master-{number}*");
/** The fixture home sits inside the temp root, which would make the root "above home"; a real home is elsewhere. */
const cx = (over = {}) => w.ctx({ home: "/nonexistent/me", ...over });

describe("the name rule", () => {
  test("{number} stands between non-digits; {card} is not followed by a digit; * stays in one name", () => {
    const re = otherFolderRe("orbit-pol-master-{number}*", "ORBIT-1042");
    expect(re.test("orbit-pol-master-1042")).toBe(true);
    expect(re.test("orbit-pol-master-1042-baseline")).toBe(true);
    expect(re.test("ORBIT-POL-MASTER-1042")).toBe(true);
    expect(re.test("orbit-pol-master-10420")).toBe(false);
    expect(re.test("orbit-pol-master-21042")).toBe(false);
    expect(otherFolderRe("x-{card}", "ORBIT-1042").test("x-ORBIT-10420")).toBe(false);
    expect(otherFolderRe("x-{card}", "ORBIT-1042").test("x-ORBIT-1042")).toBe(true);
    expect(otherFolderRe("a-{number}", "ORBIT-1042").test("a-1042.bak")).toBe(false);
    expect(otherFolderRe("a-*-{number}", "ORBIT-1042").test("a-b/c-1042")).toBe(false);
  });
});

describe("the setting", () => {
  test("a pattern needs a written-out parent two deep and {card} or {number} in its name", () => {
    expect(parseCleanupOtherFolders(["~/code/orbit-pol-{number}*", "/work/orbit/x-{card}"])).toEqual({ value: ["~/code/orbit-pol-{number}*", "/work/orbit/x-{card}"] });
    for (const bad of ["~/orbit-pol-{number}", "/tmp/x-{number}", "~/code/fixed-name", "~/co*/x-{number}", "~/code/{number}/x-{number}", "rel/x-{number}", "~/code/../x-{number}", "~/code/x-{slug}-{number}", ""]) {
      expect("error" in parseCleanupOtherFolders([bad])).toBe(true);
    }
  });
  test("it is its own setting, not a field of cleanup.config", () => {
    expect("error" in parseCleanupConfig({ otherFolders: ["~/code/x-{number}"] })).toBe(true);
    expect("value" in parseCleanupConfig({ briefsDir: "~/orbit-notes/briefs" })).toBe(true);
  });
});

describe("planCleanup and runCleanup", () => {
  test("a detached baseline worktree and a trunk worktree are found by number, a plain folder with its size, and all are removed", async () => {
    w = makeWorld();
    const a = baseline("orbit-pol-master-1042", "--detach");
    const b = join(w.root, "orbit-pol-master-1042-b"); w.git(w.main, "worktree", "add", "-q", "-b", "trunk-copy", b, "origin/main");
    put(join(w.root, "orbit-pol-master-1042-plain", "big.bin"), "x".repeat(4000));
    put(join(w.root, "orbit-pol-master-10420", "keep.txt")); put(join(w.root, "orbit-pol-master-2000", "keep.txt"));
    const cfg = w.cfg({ otherFolders: [pat()] });
    const plan = await planCleanup(w.main, PR, cfg, cx());
    expect(plan.blocks).toEqual([]);
    expect(others(plan)).toEqual([a, b, join(w.root, "orbit-pol-master-1042-plain")].sort());
    expect(plan.items.find((i) => i.target === join(w.root, "orbit-pol-master-1042-plain"))).toMatchObject({ detail: "plain folder" });
    expect(plan.items.find((i) => i.target === join(w.root, "orbit-pol-master-1042-plain"))!.bytes).toBeGreaterThan(3999);
    expect(plan.items.find((i) => i.target === a)!.detail).toContain("git worktree");
    const r = await runCleanup(w.main, PR, cfg, cx(), { planId: plan.id });
    expect(r.items.filter((i) => i.kind === "other-folder").map((i) => i.status)).toEqual(["done", "done", "done"]);
    expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(false); expect(existsSync(join(w.root, "orbit-pol-master-1042-plain"))).toBe(false);
    expect(w.git(w.main, "worktree", "list", "--porcelain")).not.toContain("orbit-pol-master-1042");
    expect(existsSync(join(w.root, "orbit-pol-master-10420"))).toBe(true);
    expect(existsSync(join(w.root, "orbit-pol-master-2000"))).toBe(true);
    expect(r.remaining?.items.filter((i) => i.kind === "other-folder")).toEqual([]);
  });

  test("the number is delimited: 1042 does not take 10420 or 21042", async () => {
    w = makeWorld();
    put(join(w.root, "orbit-pol-master-10420", "k")); put(join(w.root, "orbit-pol-master-21042", "k"));
    const plan = await planCleanup(w.main, PR, w.cfg({ otherFolders: [pat(), join(w.root, "any-*{number}")] }), cx());
    expect(others(plan)).toEqual([]);
  });

  test("a worktree with uncommitted changes blocks the whole run, and nothing is removed", async () => {
    w = makeWorld();
    const a = baseline("orbit-pol-master-1042", "--detach");
    put(join(a, "scratch.txt"), "work in progress");
    put(join(w.root, "orbit-pol-master-1042-plain", "f"));
    const cfg = w.cfg({ otherFolders: [pat()] });
    const plan = await planCleanup(w.main, PR, cfg, cx());
    expect(plan.blocks.map((b) => b.kind)).toEqual(["dirty"]);
    expect(plan.blocks[0]!.why).toContain(a);
    await expect(runCleanup(w.main, PR, cfg, cx(), { planId: plan.id })).rejects.toThrow(/refused/);
    expect(existsSync(a)).toBe(true); expect(existsSync(join(w.root, "orbit-pol-master-1042-plain"))).toBe(true);
  });

  test("a worktree git cannot read blocks as unreadable", async () => {
    w = makeWorld();
    const a = baseline("orbit-pol-master-1042", "--detach");
    writeFileSync(join(a, ".git"), "gitdir: /nonexistent/nowhere\n");
    const plan = await planCleanup(w.main, PR, w.cfg({ otherFolders: [pat()] }), cx());
    expect(plan.blocks.map((b) => b.kind)).toEqual(["unreadable"]);
  });

  test("a process inside the folder blocks, worktree or plain", async () => {
    w = makeWorld();
    const a = baseline("orbit-pol-master-1042", "--detach");
    const plain = put(join(w.root, "orbit-pol-master-1042-plain", "f"));
    const cfg = w.cfg({ otherFolders: [pat()] });
    fakeProcess(w, 4301, a);
    expect((await planCleanup(w.main, PR, cfg, cx())).blocks.map((b) => b.kind)).toEqual(["live-session"]);
    fakeProcess(w, 4302, join(plain, ".."));
    expect((await planCleanup(w.main, PR, cfg, cx())).blocks.map((b) => b.kind)).toEqual(["live-session", "live-session"]);
  });

  test("a git checkout that is not a worktree of this repository is refused with a note, never an item", async () => {
    w = makeWorld();
    const other = join(w.root, "orbit-pol-other-1042"); mkdirSync(other, { recursive: true }); w.git(other, "init", "-q");
    const cfg = w.cfg({ otherFolders: [join(w.root, "orbit-pol-other-{number}")] });
    const plan = await planCleanup(w.main, PR, cfg, cx());
    expect(others(plan)).toEqual([]);
    expect(plan.notes.join("\n")).toContain("not a worktree of this repository");
    const out = await runItem({ id: `other-folder:${other}`, kind: "other-folder", target: other, detail: "" }, plan, cfg, cx());
    expect(out.status).toBe("failed");
    expect(existsSync(other)).toBe(true);
  });

  test("refusals: main checkout, a holder of it, home and its parent, a folder directly in home", () => {
    const home = "/work/me", main = "/work/me/code/orbit";
    expect(otherFolderRefusal(main, main, home)).not.toBeNull();
    expect(otherFolderRefusal("/work/me/code", main, home)).not.toBeNull();
    expect(otherFolderRefusal(join(main, "sub"), main, home)).not.toBeNull();
    expect(otherFolderRefusal(home, main, home)).not.toBeNull();
    expect(otherFolderRefusal("/work", main, home)).not.toBeNull();
    expect(otherFolderRefusal("/work/me/orbit-pol-1042", main, home)).not.toBeNull();
    expect(otherFolderRefusal("/work/me/code/orbit-pol-master-1042", main, home)).toBeNull();
  });

  test("a pattern whose parent is home is refused with a note", async () => {
    w = makeWorld();
    put(join(w.home, "orbit-pol-1042", "f"));
    const plan = await planCleanup(w.main, PR, w.cfg({ otherFolders: [join(w.home, "orbit-pol-{number}")] }), w.ctx());
    expect(others(plan)).toEqual([]);
    expect(plan.notes.join("\n")).toContain("its parent folder is the home directory");
  });

  test("the run removes only what a pattern of this card names, whatever the plan holds", async () => {
    w = makeWorld();
    const stranger = put(join(w.root, "orbit-pol-master-9999", "f"));
    const plan = await planCleanup(w.main, PR, w.cfg({ otherFolders: [pat()] }), cx());
    const out = await runItem({ id: `other-folder:${stranger}`, kind: "other-folder", target: stranger, detail: "" }, plan, w.cfg({ otherFolders: [pat()] }), cx());
    expect(out).toMatchObject({ status: "failed" });
    expect(existsSync(stranger)).toBe(true);
  });

  test("a plain folder with files the user cannot delete goes through the container fallback", async () => {
    w = makeWorld();
    const locked = join(put(join(w.root, "orbit-pol-master-1042", "locked", "f")), "..");
    chmodSync(locked, 0o000);
    const calls: string[] = [];
    const base = cx().run;
    // the fake container is root: it can read what the user could not
    const run: Runner = async (cmd, args, o) => { if (cmd === "docker" && args[0] === "run") { calls.push("docker run"); chmodSync(locked, 0o755); } return base(cmd, args, o); };
    const cfg = w.cfg({ otherFolders: [pat()] });
    const plan = await planCleanup(w.main, PR, cfg, cx({ run }));
    const r = await runCleanup(w.main, PR, cfg, cx({ run }), { planId: plan.id });
    expect(r.items.find((i) => i.kind === "other-folder")!.status).toBe("done");
    expect(existsSync(join(w.root, "orbit-pol-master-1042"))).toBe(false);
    if (process.getuid?.() !== 0) expect(calls).toEqual(["docker run"]);
  });

  test("a symbolic link that matches is neither followed nor removed", async () => {
    w = makeWorld();
    put(join(w.root, "elsewhere", "f"));
    symlinkSync(join(w.root, "elsewhere"), join(w.root, "orbit-pol-master-1042"));
    const plan = await planCleanup(w.main, PR, w.cfg({ otherFolders: [pat()] }), cx());
    expect(others(plan)).toEqual([]);
  });

  test("the card's own worktree is not listed twice, and the Worktree tick off hides them", async () => {
    w = makeWorld();
    baseline("orbit-pol-master-1042", "--detach");
    const cfg = w.cfg({ otherFolders: [join(w.root, "orbit-*{card}*"), pat()] });
    const plan = await planCleanup(w.main, PR, cfg, cx());
    expect(plan.items.filter((i) => i.target === w.wt).map((i) => i.kind)).toEqual(["worktree"]);
    const off = await planCleanup(w.main, PR, w.cfg({ otherFolders: [pat()], include: ["evidence"] }), cx());
    expect(others(off)).toEqual([]);
  });
});

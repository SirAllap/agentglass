/*
 * Whether an agent could drive the browser, and whether the pane can tell.
 *
 * Written against the failure that produced this pane rather than against the
 * happy path: the skill was shipped and installed nowhere, and the CLI pointed
 * at a directory that had been deleted. Both of those look like success from a
 * distance — a file exists somewhere, a command resolves on PATH — and the
 * whole value here is refusing to report them as one.
 *
 * The two go wrong differently on purpose. A symlink dangles; a copy drifts.
 * Collapsing them gives one wrong instruction for two states.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliState, installSkill, refreshSkill, shippedSkill, skillDest, skillState } from "../src/browseruse.ts";
import { createHash } from "node:crypto";

let dir = "";
const HOME0 = process.env.HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-bu-"));
  process.env.HOME = dir;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
afterAll(() => {
  // `bun test` shares one process: a HOME left pointing at a deleted temp
  // directory is handed to every file that runs after this one.
  if (HOME0 === undefined) delete process.env.HOME; else process.env.HOME = HOME0;
});

describe("the skill, which is a copy and therefore drifts", () => {
  const a = Buffer.from("skill one"), b = Buffer.from("skill two");

  test("the same bytes are up to date; different bytes are stale", () => {
    expect(skillState(a, a)).toBe("current");
    expect(skillState(a, b)).toBe("stale");
  });

  test("not installed is a different answer from not shipped", () => {
    // One of these the person can fix by pressing Install. The other means this
    // build has nothing to install, and telling them to press it is a loop.
    expect(skillState(a, null)).toBe("missing");
    expect(skillState(null, a)).toBe("unshipped");
    expect(skillState(null, null)).toBe("unshipped");
  });
});

describe("the CLI, which is a symlink and therefore dangles", () => {
  test("a link to something real is installed", () => {
    const real = join(dir, "real-cli");
    writeFileSync(real, "#!/usr/bin/env python3\n");
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(cliState(link)).toEqual({ state: "installed", target: real });
  });

  test("a link to something deleted is DANGLING, not missing", () => {
    // The state this pane was written for. existsSync follows the link and
    // answers false, so the obvious implementation calls this "missing" and
    // tells somebody to install what is already installed and pointing at
    // nothing — which is what happened for one afternoon, at a worktree that
    // had since been removed.
    const gone = join(dir, "was-here");
    writeFileSync(gone, "x");
    const link = join(dir, "link");
    symlinkSync(gone, link);
    rmSync(gone);
    const r = cliState(link);
    expect(r.state).toBe("dangling");
    expect(r.target).toBe(gone);
  });

  test("nothing there at all is missing", () => {
    expect(cliState(join(dir, "nope"))).toEqual({ state: "missing", target: null });
  });

  test("a real file somebody put there themselves counts as installed", () => {
    const own = join(dir, "own-cli");
    writeFileSync(own, "#!/bin/sh\n");
    expect(cliState(own).state).toBe("installed");
  });
});

describe("installing the skill", () => {
  test("writes it where agents look, under the HOME the server was given", () => {
    const r = installSkill();
    // Either it installed, or this build genuinely ships no skill — and it says
    // which, rather than failing silently.
    if (!r.ok) {
      expect(r.error).toContain("does not carry");
      return;
    }
    expect(r.path).toBe(skillDest());
    expect(r.path!.startsWith(dir)).toBe(true);
  });

  test("keeps what was there, and only when it actually differs", () => {
    const dest = skillDest();
    mkdirSync(join(dir, ".claude", "skills", "browser-use"), { recursive: true });
    writeFileSync(dest, "something somebody edited on purpose");
    const first = installSkill();
    if (!first.ok) return; // no shipped file in this environment
    // Their version is not thrown away: this writes into a directory that is
    // theirs, not ours.
    expect(first.backup).toBeTruthy();

    const second = installSkill();
    expect(second.ok).toBe(true);
    // Pressing Install twice leaves no trail of identical backups.
    expect(second.backup).toBeUndefined();
  });
});

describe("refreshing the skill when the app ships a newer one", () => {
  const shipped = () => shippedSkill();

  test("a copy this app wrote and nobody edited follows the shipped one", () => {
    if (!shipped()) return;
    const dest = skillDest();
    mkdirSync(join(dir, ".claude", "skills", "browser-use"), { recursive: true });
    // An older shipped version, written the way Install writes it.
    writeFileSync(dest, "an older shipped skill");
    writeFileSync(join(dirname(dest), ".agentglass-installed"), createHash("sha256").update("an older shipped skill").digest("hex").slice(0, 16));
    expect(refreshSkill(shipped())).toBe("updated");
    expect(readFileSync(dest)).toEqual(readFileSync(shipped()!));
    // And it is the shipped bytes now: nothing to do the next time.
    expect(refreshSkill(shipped())).toBe("current");
  });

  test("a hand edit is left alone", () => {
    if (!shipped()) return;
    const dest = skillDest();
    mkdirSync(join(dir, ".claude", "skills", "browser-use"), { recursive: true });
    writeFileSync(dest, "an older shipped skill");
    writeFileSync(join(dirname(dest), ".agentglass-installed"), createHash("sha256").update("an older shipped skill").digest("hex").slice(0, 16));
    writeFileSync(dest, "an older shipped skill, plus a line somebody added");
    expect(refreshSkill(shipped())).toBe("kept");
    expect(readFileSync(dest, "utf8")).toContain("plus a line somebody added");
  });

  test("a copy from before there was a mark is left alone too", () => {
    if (!shipped()) return;
    mkdirSync(join(dir, ".claude", "skills", "browser-use"), { recursive: true });
    writeFileSync(skillDest(), "an older shipped skill");
    expect(refreshSkill(shipped())).toBe("kept");
  });

  test("no installed copy is not this function's business, and Install writes the mark", () => {
    if (!shipped()) return;
    expect(refreshSkill(shipped())).toBe("missing");
    expect(installSkill().ok).toBe(true);
    expect(refreshSkill(shipped())).toBe("current");
    // Only the shipped bytes were written, so a later release may replace them.
    writeFileSync(skillDest(), "x");
    expect(refreshSkill(shipped())).toBe("kept");
  });
});

describe("the refresh reads the app's own copy only", () => {
  test("a skills directory in the launch cwd is not a source", () => {
    const cwd = process.cwd();
    const there = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    mkdirSync(join(there, "skills", "browser-use"), { recursive: true });
    writeFileSync(join(there, "skills", "browser-use", "SKILL.md"), "somebody else's skill");
    mkdirSync(join(dir, ".claude", "skills", "browser-use"), { recursive: true });
    writeFileSync(skillDest(), "an older shipped skill");
    writeFileSync(join(dirname(skillDest()), ".agentglass-installed"), createHash("sha256").update("an older shipped skill").digest("hex").slice(0, 16));
    try {
      process.chdir(there);
      expect(shippedSkill(true)).toBeNull();
      expect(refreshSkill()).toBe("unshipped");
      expect(readFileSync(skillDest(), "utf8")).toBe("an older shipped skill");
    } finally {
      process.chdir(cwd);
      rmSync(there, { recursive: true, force: true });
    }
  });
});

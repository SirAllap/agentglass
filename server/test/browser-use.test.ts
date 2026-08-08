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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliState, installSkill, skillDest, skillState } from "../src/browseruse.ts";

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

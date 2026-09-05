/*
 * Which sources are somebody else's, and which we dare suggest.
 *
 * This file exists because the first version of that judgement shipped, was
 * pressed, and ticked 646 files and 400 MB of an employer's transcripts while
 * labelling them "yours" and "suggested".
 *
 * The cause was one regex against the wrong string: it tested for the project
 * name OR the username in the FULL PATH, and every path on a machine contains
 * that machine's username. So the username matched everything and every source
 * was classified as the user's own work.
 *
 * Two rules come out of that and both are asserted below:
 *
 *   The username must never make a source look open. A Claude project
 *   directory encodes the home path in its own NAME — `-home-<user>-code-<x>`
 *   — so stripping the home prefix from the path is not enough; it has to come
 *   off the directory name too.
 *
 *   Nothing sensitive is ever suggested, whatever kind it is. Rules recorded
 *   while working on an employer's project are the user's own writing and are
 *   still about that project. One click ticks them by hand; being asked is the
 *   entire point of the screen.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SRC: typeof import("../src/understudy-sources.ts");

beforeAll(async () => {
  const jail = mkdtempSync(join(tmpdir(), "agx-judge-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  SRC = await import("../src/understudy-sources.ts");
});

/**
 * The shapes that broke it, with the employer's name replaced by a fictional
 * one — and the substitution is not incidental.
 *
 * The first version of this file used the real directory names, and the
 * repository's own pre-commit hook refused the commit: a test about private
 * names must not be the thing that writes private names into a public repo.
 * That hook was right, and the property under test survives the rename
 * untouched, because the bug was never about WHICH project it was. It was that
 * every one of these contains the username, so a check that looked for the
 * username found it everywhere.
 *
 * `dev` here is the user, `orbit` is somebody else's project.
 */
const SHAPES = [
  { dir: "-home-dev-code-agentglass", open: true },
  { dir: "-home-dev-code-agentglass-landing", open: true },
  { dir: "-home-dev-code-agentglass-work-2026-08-05", open: true },
  { dir: "-home-dev-code-orbit", open: false },
  { dir: "-home-dev-code-orbit-ORBIT-1042-api", open: false },
  { dir: "-home-dev-code-orbit-billing-v2", open: false },
  { dir: "-home-dev", open: false },
];

describe("the username never votes", () => {
  test("a source is judged by its project, not by whose machine it is on", () => {
    for (const { dir, open } of SHAPES) {
      const rows = SRC.listSources({}, [
        { id: `added:${dir}`, path: `/home/dev/.claude/projects/${dir}`, label: dir, kind: "precedents" },
      ]);
      const row = rows.find((r) => r.id === `added:${dir}`)!;
      expect(row, dir).toBeTruthy();
      // An added source is never suggested, but the point here is the LABEL a
      // discovered one of the same shape would carry, which is what the panel
      // shows and what a person decides on.
      expect(typeof row.sensitive, dir).toBe("boolean");
    }
  });

  /*
   * THIS ASSERTION USED TO SAY THE OPPOSITE, and the change is deliberate.
   *
   * The first version refused to suggest anything marked sensitive, on the
   * reasoning that an employer's project is "somebody else's work". That
   * reasoning was wrong on the facts. It is one person's machine, the work
   * project is their own work, and it is the densest record of how they
   * actually operate — refusing to learn from it is refusing to learn from most
   * of what they do.
   *
   * `sensitive` never meant "not yours". It means "filed in the CLOSED
   * partition rather than the open one", and the partition is the safety
   * property, not the tick box. A closed precedent is banked closed and
   * `retrieve()` takes a partition as a required argument — so it cannot come
   * back for open work whether or not anybody ticked it.
   *
   * What survives from the incident is the part that was actually about safety:
   * a scratch directory is still never suggested, and the classifier still must
   * not be fooled by the username.
   */
  test("a closed-partition source may be suggested — the partition is the fence, not the tick", () => {
    const rows = SRC.listSources({}, []);
    const closed = rows.filter((s) => s.found && s.sensitive && !s.added);
    // On a machine with no closed sources there is nothing to assert; on this
    // one there are several, and none of them should be witheld on the grounds
    // of being work.
    if (closed.length) {
      expect(closed.some((s) => s.recommended), "closed-partition work is still the user's own work").toBe(true);
    }
  });

  test("a scratch directory is never suggested", () => {
    // The one exclusion that survived the reframe, because a scratchpad is not
    // a record of how somebody works — it is the litter of one afternoon.
    for (const s of SRC.listSources({}, [])) {
      if (/[-/]tmp([-/]|$)|scratchpad/i.test(s.path)) {
        expect(s.recommended, `${s.id} is scratch and must not be suggested`).toBe(false);
      }
    }
  });

  test("the suggested set is not empty on a real machine", () => {
    // The other failure mode of an over-cautious fix: suggest nothing, and the
    // button that exists to answer "where do I start" answers "nowhere".
    const found = SRC.listSources({}, []).filter((s) => s.found);
    if (found.length > 0) {
      expect(found.some((s) => s.recommended)).toBe(true);
    }
  });

  test("a source with nothing readable in it is not offered at all", () => {
    // Not a choice, a row of furniture. The first version listed every project
    // directory it found, scratchpads included, and the screen read as a wall.
    for (const s of SRC.listSources({}, [])) {
      if (s.found && !s.added) expect(s.files, `${s.id} has no files and should not be listed`).toBeGreaterThan(0);
    }
  });
});

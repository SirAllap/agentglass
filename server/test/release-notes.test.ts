import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Release notes read from the update clone.
 *
 * The annotation IS the release body (release.yml creates the GitHub release
 * from it), so a machine that has updated once can answer offline. This drives
 * that path against a real annotated tag; the GitHub fallback is not exercised
 * here because a unit test that reaches the network is a flake with a schedule.
 */
let clone: string, su: typeof import("../src/selfupdate.ts");

const run = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

const NOTES = "### Terminal\n\n- tmux windows are the panel's own tabs (#154).\n";

beforeAll(async () => {
  // A fixture clone, not the developer's real one under ~/.cache: selfupdate.ts
  // reads AGENTGLASS_UPDATE_SRC, set here before it is imported.
  clone = join(mkdtempSync(join(tmpdir(), "agx-notes-")), "source");
  process.env.AGENTGLASS_UPDATE_SRC = clone;
  mkdirSync(clone, { recursive: true });
  run(clone, "init", "-q", "-b", "main");
  run(clone, "config", "user.email", "t@example.com");
  run(clone, "config", "user.name", "t");
  writeFileSync(join(clone, "a.txt"), "one\n");
  run(clone, "add", "-A");
  run(clone, "commit", "-qm", "first");
  spawnSync("git", ["-C", clone, "tag", "-a", "--cleanup=verbatim", "v9.9.9", "-F", "-"], { input: NOTES, encoding: "utf8" });
  // A lightweight tag, the shape `gh release create` leaves behind: no
  // annotation at all, so `%(contents)` falls through to the commit message.
  run(clone, "tag", "v9.9.8");
  su = await import("../src/selfupdate.ts");
});

afterAll(() => { try { rmSync(clone, { recursive: true, force: true }); } catch { /* fine */ } });

describe("release notes", () => {
  it("refuses a tag that is not a release rather than shelling it out", async () => {
    // The tag reaches `git` as an argument. Anything that is not vN.N.N falls
    // back to this build's own base tag instead of being passed through.
    const r = await su.releaseNotes("; rm -rf /");
    expect(r.tag === "" || /^v\d+\.\d+\.\d+$/.test(r.tag)).toBe(true);
  });

  it("reads the annotation out of the update clone, with no network", async () => {
    const r = await su.releaseNotes("v9.9.9");
    expect(r.ok).toBe(true);
    expect(r.source).toBe("clone");
    expect(r.notes).toContain("tmux windows are the panel's own tabs");
  });

  it("keeps the markdown headings a release body is made of", async () => {
    // `git tag -a -F` strips every line starting with `#` unless it is told
    // not to — which silently deletes every `### Section` from the notes and
    // leaves a flat list. The fixture is cut with --cleanup=verbatim, and this
    // is the assertion that notices if that ever stops being true.
    const r = await su.releaseNotes("v9.9.9");
    expect(r.notes).toContain("### Terminal");
  });

  it("refuses to read a lightweight tag, whose 'annotation' is a commit message", async () => {
    // The bug this replaced: %(contents) on a tag with no annotation answers
    // with the commit message and never comes back empty, so the old emptiness
    // check passed it straight through as release notes. v0.3.0 is lightweight
    // — publishing from the GitHub UI creates the tag that way — and the app
    // showed "Merge pull request #123 from …" as its release notes.
    //
    // Correct behaviour is to decline the clone and fall through to the API,
    // which here has no reachable origin, so the answer is an honest failure
    // rather than a plausible-looking wrong one.
    const r = await su.releaseNotes("v9.9.8");
    expect(r.source).not.toBe("clone");
    expect(r.notes).not.toContain("first");
  });

  it("answers with a shape the client can always read", async () => {
    // Every failure path returns the same fields, so the modal never has to
    // guess whether `notes` exists before trimming it.
    const r = await su.releaseNotes("v0.0.1");
    expect(typeof r.ok).toBe("boolean");
    expect(typeof r.tag).toBe("string");
    expect(typeof r.notes).toBe("string");
    expect(typeof r.source).toBe("string");
    if (!r.ok) expect(typeof r.error).toBe("string");
  });
});

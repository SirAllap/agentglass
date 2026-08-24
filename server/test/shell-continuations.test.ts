/*
 * No comment sits inside a backslash-continued command in the build scripts.
 *
 * This is a silent one, and it cost a working build. `build-tmux-static.sh`
 * configures tmux with a long run of environment assignments, every line ending
 * in a backslash:
 *
 *     CFLAGS="…" \
 *     LIBS="…" \
 *     ./configure … 
 *
 * A comment added among those lines does not document them. The backslash joins
 * it onto the assignment above, the `#` swallows the rest of that line, and
 * `./configure` is left to run on its own — with none of the flags, finding
 * neither libevent nor ncurses. The linux build had been green for months and
 * broke on exactly this, in a change whose only intent was to add one flag.
 *
 * `bash -n` does not see it, and that is the point of testing it here: the file
 * is still valid shell. It simply is not the command anybody wrote, and nothing
 * says so until a build that was passing stops.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** The scripts that build what the app ships. Named rather than globbed: a new
 *  one should be added here deliberately, having been read. */
const SCRIPTS = [
  "scripts/build-tmux-static.sh",
  "scripts/build-task-static.sh",
];

describe("build scripts", () => {
  for (const rel of SCRIPTS) {
    test(`${rel} has no comment inside a continued command`, () => {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      const bad: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const before = lines[i - 1] ?? "";
        // A line continued with a backslash, followed by a comment: the two are
        // one line by the time the shell reads them.
        if (/\\\s*$/.test(before) && /^\s*#/.test(lines[i] ?? "")) {
          bad.push(`${rel}:${i + 1}: ${(lines[i] ?? "").trim().slice(0, 60)}`);
        }
      }
      expect(
        bad,
        "a comment here is joined onto the line above by its backslash and "
        + "comments out the rest of the command. Put it above the whole block.",
      ).toEqual([]);
    });
  }

  test("the tmux configure still carries the flags it needs", () => {
    // The failure above is invisible in the diff but very visible here: if the
    // assignments stop reaching configure, these are what go missing.
    const sh = readFileSync(join(ROOT, "scripts/build-tmux-static.sh"), "utf8");
    const block = /ac_cv_search_forkpty=[\s\S]*?\.\/configure[^\n]*/.exec(sh)?.[0] ?? "";
    expect(block, "the configure invocation was not found").not.toBe("");
    for (const flag of ["CFLAGS=", "CPPFLAGS=", "LDFLAGS=", "LIBS=", "--prefix="]) {
      expect(block, `${flag} no longer reaches configure`).toContain(flag);
    }
    // Darwin's configure stops without an explicit answer on this one.
    expect(block).toContain("--disable-utf8proc");
  });
});

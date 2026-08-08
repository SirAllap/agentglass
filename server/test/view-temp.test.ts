/*
 * The copies this server writes for something to look at, and the registration
 * that has to come with them.
 *
 * This test exists because of a bug with no error in it. A pull request's file
 * is fetched to a temp path so it can be opened in the editor, and `terminal.ts`
 * admitted that path with a string literal — `agentglass-pr-` — written in a
 * different file from the one that creates the directory. A second kind of copy
 * was added, for a branch's version of a file, under `agentglass-ref-`. It was
 * correct, it was tested, and opening one produced a pane with a SHELL in it:
 * the path was not in the workspace and did not match the one prefix the
 * terminal knew, so it fell back exactly as its comment promises — "silently
 * viewing a different file is worse than viewing none".
 *
 * Nothing threw. Nothing was logged. The only symptom was a shell where an
 * editor should have been, which reads as the editor failing to start.
 *
 * So the point of what follows is not that the two current prefixes match. It is
 * that the MAKER and the CHECK cannot disagree, whatever is added later.
 */
import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { makeViewTempDir, isViewTemp, viewTempDirOf } = await import("../src/viewtemp.ts");

/** Every kind the maker knows. Listed here so adding a kind without teaching
 *  this test about it is the thing that fails, rather than the pane. */
const KINDS = ["pr", "ref"] as const;

describe("a read-only copy is openable in the editor", () => {
  it("accepts a path from every kind of copy it can make", () => {
    for (const kind of KINDS) {
      const dir = makeViewTempDir(kind);
      try {
        const file = join(dir, "thing.py");
        writeFileSync(file, "# hi\n");
        // The assertion the bug needed: what the maker produced, the check
        // admits. Not "the string starts with the right prefix" — the two sides
        // of the same question, asked through the two functions.
        expect(isViewTemp(file), `${kind} copies must be viewable`).toBe(true);
        expect(viewTempDirOf(file)).toBe(dir);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("does not admit /tmp in general", () => {
    // The whole reason the check is a prefix and not "is it under tmp": a pane
    // that can open anything in the system temp directory is a file viewer for
    // whatever any other program left there.
    const stranger = mkdtempSync(join(tmpdir(), "not-ours-"));
    try {
      const file = join(stranger, "thing.py");
      writeFileSync(file, "# hi\n");
      expect(isViewTemp(file)).toBe(false);
      expect(viewTempDirOf(file)).toBe(null);
    } finally { rmSync(stranger, { recursive: true, force: true }); }
  });

  it("does not admit a name that merely starts the same way outside tmp", () => {
    // `/home/someone/agentglass-pr-notes/x.py` is not one of ours. The check is
    // anchored at the temp directory, not at the bare prefix.
    expect(isViewTemp("/home/someone/agentglass-pr-notes/x.py")).toBe(false);
    expect(isViewTemp("/home/someone/agentglass-ref-notes/x.py")).toBe(false);
  });

  it("gives each copy its own directory", () => {
    // One file per directory, because the PTY opens the editor with this
    // directory as its view root: a shared one would put every file anybody has
    // looked at into that editor's file list.
    const a = makeViewTempDir("ref");
    const b = makeViewTempDir("ref");
    try { expect(a).not.toBe(b); }
    finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  });
});

describe("nobody re-writes the prefix by hand", () => {
  it("terminal.ts asks viewtemp instead of matching a string", async () => {
    /*
     * The lock for the actual bug, which the tests above cannot reach: they hold
     * that the maker and the check agree, and the defect was that the PTY did
     * not USE the check. It had the prefix written out, in a third file, and so
     * knew about one kind of copy out of two.
     *
     * A source assertion rather than a behavioural one because the behaviour
     * needs a pty, a websocket and an editor on PATH — and because what is being
     * prevented is a literal being written here again, which is exactly the
     * shape a source assertion catches.
     */
    const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
    expect(src).toContain("isViewTemp");
    // The prefixes belong to viewtemp.ts and nowhere else.
    expect(src).not.toContain("agentglass-pr-");
    expect(src).not.toContain("agentglass-ref-");
  });

  it("the makers do not spell their own directories either", async () => {
    for (const f of ["../src/prs.ts", "../src/files.ts"]) {
      const src = await Bun.file(new URL(f, import.meta.url)).text();
      expect(src, f).not.toContain('mkdtempSync(join(tmpdir(), "agentglass');
    }
  });
});

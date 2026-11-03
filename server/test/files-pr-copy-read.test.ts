// A pull request's copy lives under the system temp directory, and for a
// repository that is only on GitHub the root is `gh:owner/name`, not a folder.
// The viewer used to ask for the copy with that root and got "no directory
// given" for a file that was on disk.
import { describe, expect, it } from "bun:test";
import { symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeViewTempDir } from "../src/viewtemp.ts";
import { fileText } from "../src/files.ts";

describe("fileText on a pull request's temp copy", () => {
  it("reads it whatever the root is", () => {
    const file = join(makeViewTempDir("pr"), "abc1234-notes.md");
    writeFileSync(file, "# orbit\n");
    for (const root of ["gh:acme/orbit", "", "/no/such/dir"]) {
      const r = fileText(root, file);
      expect(r.ok, root).toBe(true);
      expect(r.text).toBe("# orbit\n");
    }
  });
  it("does not admit other temp files, or a link out of the copy's directory", () => {
    const plain = join(mkdtempSync(join(tmpdir(), "orbit-plain-")), "x.md");
    writeFileSync(plain, "x");
    expect(fileText("gh:acme/orbit", plain).ok).toBe(false);
    const link = join(makeViewTempDir("pr"), "out.md");
    symlinkSync(plain, link);
    expect(fileText("gh:acme/orbit", link).ok).toBe(false);
  });
});

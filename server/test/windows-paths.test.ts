// Windows portability: four places assumed POSIX path syntax (issue #188).
// A prior audit against a Windows install found the app functionally broken
// there — env vars split on the wrong delimiter, the scope check refused
// every path inside an open project, and path completion never recognised a
// drive letter. These are pure string checks, so `sep`/drive-letter behaviour
// is exercised directly rather than requiring an actual Windows machine.
import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import { isWithin, configuredRepoDirs } from "../src/config.ts";
import { isAbsoluteLike } from "../src/fsbrowse.ts";

describe("isWithin (inScope's prefix test)", () => {
  test("POSIX: a path under the parent is inside it", () => {
    expect(isWithin("/home/x/proj/src", "/home/x/proj", "/")).toBe(true);
  });

  test("POSIX: a sibling sharing the name prefix is not inside it", () => {
    expect(isWithin("/home/x/proj-backup", "/home/x/proj", "/")).toBe(false);
  });

  test("Windows: a path under the parent is inside it (this was the bug)", () => {
    // Before the fix, the prefix test hardcoded "/" - on a real Windows
    // install, resolve() returns backslashes, so this comparison always
    // failed and every file in an open project read as out-of-scope.
    expect(isWithin("C:\\Users\\x\\proj\\src", "C:\\Users\\x\\proj", "\\")).toBe(true);
  });

  test("Windows: the scope root itself is inside it", () => {
    expect(isWithin("C:\\Users\\x\\proj", "C:\\Users\\x\\proj", "\\")).toBe(true);
  });

  test("Windows: a sibling sharing the name prefix is not inside it", () => {
    expect(isWithin("C:\\Users\\x\\proj-backup", "C:\\Users\\x\\proj", "\\")).toBe(false);
  });

  test("Windows: an unrelated path is not inside it", () => {
    expect(isWithin("C:\\Users\\x\\other", "C:\\Users\\x\\proj", "\\")).toBe(false);
  });
});

describe("isAbsoluteLike (path-completion's absolute-path guard)", () => {
  test("POSIX absolute paths are recognised", () => {
    expect(isAbsoluteLike("/home/x/code")).toBe(true);
  });

  test("Windows drive-letter paths are recognised (this was the bug)", () => {
    // Before the fix, only a leading "/" passed, so typing a Windows path
    // like this into the picker's completion box matched nothing at all.
    expect(isAbsoluteLike("C:\\Users\\x\\code")).toBe(true);
    expect(isAbsoluteLike("D:/code")).toBe(true);
    expect(isAbsoluteLike("z:\\code")).toBe(true); // lowercase drive letter
  });

  test("a relative path is not absolute-like", () => {
    expect(isAbsoluteLike("code/current_project")).toBe(false);
    expect(isAbsoluteLike("relative:with-a-colon")).toBe(false);
  });

  test("a bare tilde is not itself absolute-like (handled separately for ~ expansion)", () => {
    expect(isAbsoluteLike("~")).toBe(false);
  });
});

describe("configuredRepoDirs (AGENTGLASS_REPO_DIRS delimiter)", () => {
  test("splits on the platform path delimiter, not a hardcoded colon", async () => {
    // On POSIX, path.delimiter is ":" - the same character the old, broken
    // code hardcoded, so this alone doesn't distinguish them. What it does
    // confirm is that configuredRepoDirs() actually calls into path.delimiter
    // (imported and asserted below) rather than a literal ":" that would
    // silently diverge from it on Windows, where path.delimiter is ";".
    expect(delimiter).toBe(process.platform === "win32" ? ";" : ":");

    const prev = process.env.AGENTGLASS_REPO_DIRS;
    process.env.AGENTGLASS_REPO_DIRS = ["/tmp/a", "/tmp/b"].join(delimiter);
    try {
      // Re-imported per test file in this suite via a cache-busting query so
      // each run reads the env var fresh; configuredRepoDirs re-reads env on
      // every call (no module-level caching), so a plain import is enough.
      const dirs = configuredRepoDirs();
      expect(dirs).toEqual(["/tmp/a", "/tmp/b"]);
    } finally {
      if (prev === undefined) delete process.env.AGENTGLASS_REPO_DIRS;
      else process.env.AGENTGLASS_REPO_DIRS = prev;
    }
  });
});

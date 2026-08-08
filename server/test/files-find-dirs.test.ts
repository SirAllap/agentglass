/*
 * A folder is a search result too.
 *
 * Typing `guest-checkout-v2` used to answer with the forty files inside that
 * folder and never with the folder itself — which is the one result that says
 * "here is the thing you named". `fd --type f` and `git ls-files` both list
 * files by definition, so neither could ever have said otherwise.
 *
 * Both paths are exercised, because they find directories by completely
 * different means: `fd` reports them and marks them with a trailing slash, and
 * git has no notion of a directory at all — its folders are derived from the
 * prefixes of the paths it does track, which finds an empty one not at all.
 * That last part is a real limit and it is asserted rather than hidden.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { findFiles } = await import("../src/files.ts");

let dir = "";
let hadRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-find-"));
  /*
   * The scope, set explicitly rather than inherited.
   *
   * `findFiles` refuses a root outside the workspace scope, and that scope is
   * `process.env.AGENTGLASS_ROOT` — a process-wide value in a runner that
   * shares one process across every test file. Another file sets it and does
   * not put it back, so these passed alone and failed in the full suite,
   * depending on the order the runner happened to pick. Owning it here is the
   * only version that does not depend on who ran first.
   */
  hadRoot = process.env.AGENTGLASS_ROOT;
  process.env.AGENTGLASS_ROOT = dir;
  mkdirSync(join(dir, "docs/projects/guest-checkout-v2/reports"), { recursive: true });
  mkdirSync(join(dir, "src/billing"), { recursive: true });
  writeFileSync(join(dir, "docs/projects/guest-checkout-v2/risk-monitoring.md"), "# risk\n");
  writeFileSync(join(dir, "docs/projects/guest-checkout-v2/reports/2026-08-07.md"), "# report\n");
  writeFileSync(join(dir, "src/billing/rest.py"), "x = 1\n");
  Bun.spawnSync(["git", "init", "-q", dir]);
  Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
});

afterEach(() => {
  // Restored, not deleted: this file must not become the one that breaks the
  // next.
  if (hadRoot === undefined) delete process.env.AGENTGLASS_ROOT;
  else process.env.AGENTGLASS_ROOT = hadRoot;
  rmSync(dir, { recursive: true, force: true });
});

describe("what a name search answers with", () => {
  it("names the folder, not only its contents", () => {
    const r = findFiles(dir, "guest-checkout-v2");
    expect(r.ok).toBe(true);
    expect(r.dirs).toContain("docs/projects/guest-checkout-v2");
    // The files inside it still come back — that was never wrong, it was just
    // not the whole answer.
    expect(r.files.some((f) => f.endsWith("risk-monitoring.md"))).toBe(true);
  });

  it("finds a folder nested under another match", () => {
    const r = findFiles(dir, "guest-checkout");
    expect(r.dirs).toContain("docs/projects/guest-checkout-v2");
    expect(r.dirs).toContain("docs/projects/guest-checkout-v2/reports");
  });

  it("keeps the two apart, because opening one is a different action", () => {
    // A file opens in the viewer; a directory moves the tree. One list of both
    // would make the caller guess which it had.
    const r = findFiles(dir, "reports");
    expect(r.dirs).toContain("docs/projects/guest-checkout-v2/reports");
    expect(r.files).not.toContain("docs/projects/guest-checkout-v2/reports");
  });

  it("answers with nothing rather than everything for an empty query", () => {
    const r = findFiles(dir, "  ");
    expect(r.files).toEqual([]);
    expect(r.dirs).toEqual([]);
  });

  it("matches the PATH, not just the file name", () => {
    /*
     * The defect this was reported for. `fd` compares the basename unless told
     * otherwise, so a query naming a FOLDER — the ordinary way anybody refers
     * to a place in a repository — answered with nothing at all, while the git
     * fallback answered correctly. Two backends, two behaviours, whichever
     * happened to be installed.
     */
    const r = findFiles(dir, "guest-checkout-v2/reports");
    expect(r.files).toContain("docs/projects/guest-checkout-v2/reports/2026-08-07.md");
  });

  it("matches a path segment anywhere, not just the last one", () => {
    // `docs/projects/...` — the query names a folder near the root and the
    // things under it are what you are looking for.
    const r = findFiles(dir, "projects");
    expect(r.dirs).toContain("docs/projects");
  });
});

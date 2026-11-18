import { afterEach, expect, test } from "bun:test";
import { api } from "../src/lib/api.ts";
import { invalidateScannedRepos, REPOS_CHANGED, resetScannedRepos, scannedReposOnce } from "../src/components/settings/scope/useScope.ts";

// The sweep is cached for the session, so a project hidden in Open projects stayed in the scope menu
// until restart. It is dropped when a project is hidden or shown again, and on window focus.
const saved = api.gitReposAll;
afterEach(() => { (api as { gitReposAll: unknown }).gitReposAll = saved; resetScannedRepos(); });

test("invalidating drops the cached sweep and tells mounted controls", async () => {
  let calls = 0;
  (api as { gitReposAll: unknown }).gitReposAll = async () => { calls++; return { repos: [], hidden: [] }; };
  await scannedReposOnce();
  await scannedReposOnce();
  expect(calls).toBe(1);
  let told = 0;
  const on = () => { told++; };
  globalThis.addEventListener?.(REPOS_CHANGED, on);
  invalidateScannedRepos();
  globalThis.removeEventListener?.(REPOS_CHANGED, on);
  await scannedReposOnce();
  expect(calls).toBe(2);
  if (typeof window !== "undefined") expect(told).toBe(1);
});

test("hiding a project and window focus both invalidate; a mount alone does not", async () => {
  const modal = await Bun.file(new URL("../src/components/projects/useProjectsModal.ts", import.meta.url)).text();
  expect(modal).toMatch(/if \(r\.ok\) \{ setHidden\(r\.hidden\); invalidateScannedRepos\(\); \}/);
  const scope = await Bun.file(new URL("../src/components/settings/scope/useScope.ts", import.meta.url)).text();
  expect(scope).toContain('window.addEventListener("focus", invalidateScannedRepos)');
  expect(scope).toContain("window.addEventListener(REPOS_CHANGED, readRepos)");
});

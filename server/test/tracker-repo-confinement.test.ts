/*
 * Two refusals from the merge review. A seat or worker names only its own repo in a
 * Jira or ClickUp call, and only the person names a stored account on
 * GET /providers/workspaces. The server cannot boot in the sandbox, so the rule is
 * a unit test and the wiring is read from the source.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackerRepoRefusal } from "../src/trackerAccounts.ts";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

test("a confined caller is refused another repo, with a sentence naming the rule and where it lives", () => {
  const s = trackerRepoRefusal(true, "acme/orbit", "acme/other");
  expect(s).toContain("own repository");
  expect(s).toContain("server/src/trackerAccounts.ts");
});
test("own repo (any case), no repo, and an unconfined caller pass", () => {
  expect(trackerRepoRefusal(true, "acme/orbit", "Acme/Orbit")).toBeNull();
  expect(trackerRepoRefusal(true, "acme/orbit", null)).toBeNull();
  expect(trackerRepoRefusal(false, null, "acme/other")).toBeNull();
});
test("a confined caller with no resolvable repo is refused, never 'any repo'", () => {
  expect(trackerRepoRefusal(true, null, "acme/orbit")).not.toBeNull();
});
test("the Jira and ClickUp route edges run the check before entering the account", () => {
  const jira = src.indexOf("enterJiraForRepo(jiraRepo)");
  expect(jira).toBeGreaterThan(0);
  expect(src.slice(jira - 300, jira)).toContain("trackerRepoRefused(caller, jiraRepo)");
  const cu = src.indexOf('enterForRepo(url.searchParams.get("repo"))');
  expect(cu).toBeGreaterThan(0);
  expect(src.slice(cu - 300, cu)).toContain("trackerRepoRefused(caller,");
});
test("GET /providers/workspaces refuses accountKey unless mayPublishReview", () => {
  const at = src.indexOf('pathname === "/providers/workspaces"');
  const block = src.slice(at, at + 700);
  expect(block).toMatch(/accountKey && !mayPublishReview\(req, caller\)[^\n]*403/);
  expect(block.indexOf("mayPublishReview")).toBeLessThan(block.indexOf("providerWorkspaces("));
});

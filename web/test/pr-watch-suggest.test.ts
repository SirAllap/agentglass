/*
 * The Notify menu offered names like "startup" and "adversarial-review", all
 * skipped on the pull request it was open on, so nobody could tell where they
 * came from. Suggestions are this PR's own check names, live ones first.
 */
import { describe, expect, it } from "bun:test";
import { suggestCheckNames } from "../src/lib/prWatchSuggest.ts";
import type { PrCheck } from "../../shared/types.ts";

const chk = (name: string, o: Partial<PrCheck> = {}): PrCheck => ({ name, workflow: "CI", state: "success", done: true, ...o });

describe("suggestCheckNames", () => {
  const all = [
    chk("startup", { state: "skipped" }), chk("adversarial-review", { state: "skipped" }),
    chk("lint"), chk("unit", { required: true }), chk("e2e", { state: "pending", done: false }),
    chk("unit", { event: "pull_request_review", state: "skipped" }),
  ];
  it("puts required, then running, then passed, then skipped; one per name", () => {
    expect(suggestCheckNames(all, "")).toEqual(["unit", "e2e", "lint", "adversarial-review", "startup"]);
  });
  it("caps at eight but filters the whole list when typing", () => {
    const many = Array.from({ length: 20 }, (_, i) => chk(`job-${String(i).padStart(2, "0")}`));
    expect(suggestCheckNames(many, "")).toHaveLength(8);
    expect(suggestCheckNames(many, "job-19")).toEqual(["job-19"]);
    expect(suggestCheckNames(many, "JOB-1")).toHaveLength(8);
  });
  it("never invents a name the PR does not have", () => {
    expect(suggestCheckNames(all, "claude")).toEqual([]);
  });
});

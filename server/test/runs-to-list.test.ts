/*
 * Which runs' jobs a pull request's Checks tab lists. The list is capped, and the
 * cap used to fall in the order the checks arrived, which left the one red
 * check's own run off it on a pull request with dozens of runs.
 */
import { describe, expect, test } from "bun:test";
import { runsToList } from "../src/prs.ts";

const c = (run: number, state = "success") => ({ url: `https://github.com/acme/orbit/actions/runs/${run}/job/${run}0`, state });

describe("runsToList", () => {
  test("the runs of failed checks come first, however late they arrive", () => {
    const checks = [...Array.from({ length: 9 }, (_, i) => c(100 + i)), c(999, "failure")];
    expect(runsToList(checks)).toEqual(["999", "100", "101", "102", "103", "104"]);
  });
  test("a run is listed once, and a failed run is not listed again as a passing one", () => {
    expect(runsToList([c(5), c(5, "failure"), c(6)])).toEqual(["5", "6"]);
  });
  test("a check with no run in its link is skipped, and the cap holds", () => {
    expect(runsToList([{ url: "https://github.com/acme/orbit/runs/77", state: "failure" }, ...Array.from({ length: 10 }, (_, i) => c(i + 1))], 3)).toEqual(["1", "2", "3"]);
  });
});

/*
 * The header's two questions, and the one thing it must not do to answer them.
 *
 * The panel used to head itself with the agreement percentage, the countdown to
 * the next rung and a trust rail — three figures ranking thirteen decision
 * classes, twelve of which had never held a sample. What replaced them is what
 * the loop can actually answer: how much of him it has to work from, and how
 * much it has finished.
 *
 * The property worth a test is not the arithmetic. It is that a HEADER does not
 * reach the network. `/understudy/work/next` asks every registered source what
 * it is holding, which means pull requests and a task tracker over HTTP; a
 * figure that redraws whenever the panel does must never be on that path, or
 * opening the tab starts a round of API calls nobody asked for.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

/** The body of a route handler, from its path test to the one after it. */
function routeBlock(path: string): string {
  const from = src.indexOf(`pathname === "${path}"`);
  expect(from, `${path} should be a route`).toBeGreaterThan(-1);
  const next = src.indexOf("if (pathname ===", from + 10);
  return src.slice(from, next === -1 ? from + 2000 : next);
}

describe("what it knows and what it has done", () => {
  const block = routeBlock("/understudy/standing");

  test("it answers with the four counts and nothing else", () => {
    for (const field of ["precedents", "rules", "done", "failed"]) {
      expect(block, `${field} belongs in the standing`).toContain(`${field}:`);
    }
  });

  test("it never asks a source what it is holding", () => {
    /*
     * The whole point. `nextTask` walks every source — a pull request list, a
     * task tracker — and each of those is an HTTP call. This route is read by a
     * header, so anything that reaches outward here turns opening a tab into a
     * round of requests against somebody else's API.
     */
    expect(block).not.toContain("nextTask");
    expect(block).not.toContain("Work.sources()");
    expect(block).not.toContain("openProjectRepos");
  });

  test("it is a GET, so nothing about it can change anything", () => {
    expect(block).toContain('req.method === "GET"');
  });
});

const panel = await Bun.file(
  new URL("../../web/src/components/understudy/UnderstudyPanel.tsx", import.meta.url),
).text();

describe("the tabs that were removed are removed", () => {
  /*
   * Measured in his own database before cutting: `understudy_proposals` and
   * `understudy_acts` had never held a row, no ledger row has ever carried the
   * verdict "disagree", and seven scored decisions across thirteen classes all
   * belonged to one of them. The screens for all three are gone.
   *
   * Asserted as ABSENT COMPONENTS rather than by counting tabs: a tab bar is
   * rearranged all the time, and a test that breaks when somebody reorders it
   * gets deleted rather than read.
   */
  test("no screen imports a component that was deleted", () => {
    for (const gone of ["./Queue.tsx", "./Disagreements.tsx", "./ClassRow.tsx", "./ClassDetail.tsx"]) {
      expect(panel, `${gone} was removed`).not.toContain(gone);
    }
  });

  test("and the figures that ranked the classes went with them", () => {
    // Each of these read a field that only means something once the thirteen
    // classes are being scored, which is the apparatus that was retired.
    expect(panel).not.toContain("frame.agreement");
    expect(panel).not.toContain("frame.toNextRung");
    expect(panel).not.toContain("TrustRail");
  });
});

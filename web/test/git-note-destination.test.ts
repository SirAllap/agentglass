import { describe, expect, it } from "bun:test";
import { gitDestination } from "../src/lib/gitNote.ts";

/*
 * Reading a destination out of somebody else's sentence.
 *
 * These notifications are MIRRORED from the desktop: whoever wrote them had no
 * idea agentglass would be reading, so nothing structured comes along and the
 * repository and branch have to be recovered from the words. That makes being
 * WRONG the risk worth testing — a button that opens the wrong checkout is
 * worse than no button, so the matcher declines far more than it accepts.
 */
describe("the destination inside a git notification", () => {
  it("reads the repository and the branch out of a pull notice", () => {
    const g = gitDestination({
      app: "GIT",
      summary: "orbit-WEB-1042",
      body: "7937 commits to pull on WEB-1042-Account-Status-Update-Via-Text-Message-Not-Working",
    })!;
    expect(g.kind).toBe("git");
    expect(g.repo).toBe("orbit-WEB-1042");
    expect(g.branch).toBe("WEB-1042-Account-Status-Update-Via-Text-Message-Not-Working");
  });

  it("takes the other shapes git tooling writes", () => {
    for (const body of [
      "3 commits to push on main",
      "Your branch is behind by 12 commits",
      "1 commit to pull on feat/rail-layout",
    ]) {
      expect(gitDestination({ summary: "a-repo", body }), body).not.toBe(null);
    }
  });

  it("survives a branch with punctuation stuck to it", () => {
    expect(gitDestination({ summary: "r", body: "2 commits to pull on feat/x-1." })?.branch).toBe("feat/x-1");
  });

  it("offers the repository even with no branch to name", () => {
    const g = gitDestination({ summary: "orbit-WEB-7", body: "Your branch is behind by 3 commits" })!;
    expect(g.repo).toBe("orbit-WEB-7");
    expect(g.branch).toBeUndefined();
  });

  it("declines anything that is not a git job", () => {
    // A Slack message, a build, a calendar reminder. None of these have a
    // checkout to open, and guessing one would send somebody somewhere wrong.
    for (const n of [
      { summary: "Ada", body: "sent you a message about the pull request" },
      { summary: "CI", body: "build finished" },
      { summary: "agentglass", body: "" },
      {},
    ]) {
      expect(gitDestination(n), JSON.stringify(n)).toBe(null);
    }
  });

  it("declines when the title is a sentence rather than a checkout", () => {
    // The repository is the title by convention. A title with spaces in it is
    // somebody else's notification that happens to mention commits.
    expect(gitDestination({
      summary: "Nightly sync report",
      body: "12 commits to pull on main",
    })).toBe(null);
  });
});

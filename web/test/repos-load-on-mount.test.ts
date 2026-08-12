/*
 * The checkout list is the app's, not the terminal's.
 *
 * Reported: reopen the app on the Git view and nothing loads — no changes, no
 * branches — until you step through Terminal once, and from then on everything
 * works. The cause is one gate: `api.gitRepos()` ran only while the terminal
 * view was ON SCREEN, and it is what settles the current checkout that Git, the
 * pull requests and the boards all read.
 *
 * The terminal is always mounted, so the fetch had every chance to run; it was
 * waiting to be looked at.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();

/** The effect that settles the CURRENT CHECKOUT, with a little either side.
 *  Anchored on the line that picks the root rather than on `api.gitRepos()`:
 *  three effects call that, and the first one belongs to the docked console. */
function reposEffect(): string {
  const at = src.indexOf("repos.some((r) => r.root === cur)");
  return src.slice(Math.max(0, at - 600), at + 300);
}

describe("when the checkout list is read", () => {
  it("is not waiting for the terminal to be looked at", () => {
    expect(reposEffect()).not.toContain("if (!open) return;");
  });

  it("still re-reads it when you come back to that view", () => {
    /* `open` stays in the deps: a worktree made in another window shows up when
       you next step into the terminal, which is where you would go looking. */
    expect(reposEffect()).toContain("}, [open]);");
  });

  it("leaves the gates that really are about being on screen", () => {
    /* Two others share the shape and both are correct — a keyboard chord and
       the console's typing guard mean nothing for a view nobody can see. This
       counts them so that "delete the gate" cannot be applied wholesale. */
    expect(src.match(/if \(!open\) return;/g)?.length).toBe(2);
  });

  it("drops a remembered checkout that is no longer in the list", () => {
    // The behaviour the effect existed for in the first place: a stale root
    // from another scope would open shells in a repo outside the project.
    expect(src).toContain("repos.some((r) => r.root === cur) ? cur : repos[0]?.root");
  });
});

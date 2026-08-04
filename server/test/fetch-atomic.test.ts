// The one flag standing between an interrupted fetch and a repository that has
// to be repaired by hand.
//
// Background: this app fetches on a timer to keep the ahead/behind counts
// honest, and used to kill that fetch after twenty seconds. On a repository
// with 852 remote branches a fetch cannot finish in twenty seconds, so it was
// killed EVERY time — and `git fetch` writes remote-tracking refs one at a
// time, so it left zero-byte ref files behind. Git cannot even resolve those to
// delete them ("reference broken"), and the repository then negotiates the next
// fetch claiming objects it does not have, which the server answers with "did
// not send all necessary objects". Every fetch, pull and sync fails until
// somebody finds the empty files by hand. It happened on a repo shared with a
// team.
//
// --atomic makes the ref update one transaction: all of them or none, whatever
// happens to the process. This test exists because it is exactly the kind of
// flag a later tidy-up removes as redundant, on the reasonable-sounding grounds
// that fetches normally finish.
import { test, expect } from "bun:test";
import { FETCH_ARGV } from "../src/gitwork.ts";

test("every fetch this app runs is atomic", () => {
  expect(FETCH_ARGV).toContain("--atomic");
});

test("it is still the fetch it was, and still prunes", () => {
  expect(FETCH_ARGV[0]).toBe("fetch");
  expect(FETCH_ARGV).toContain("--all");
  expect(FETCH_ARGV).toContain("--prune");
});

test("it never writes to the remote", () => {
  // A fetch is read-only against origin by definition; this pins that nobody
  // slips a pushing verb into the shared argv.
  for (const forbidden of ["push", "--force", "-f", "--delete", "--set-upstream", "--tags-only"]) {
    expect(FETCH_ARGV as readonly string[]).not.toContain(forbidden);
  }
});

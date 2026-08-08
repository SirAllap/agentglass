/*
 * The one row in the app that answers "what am I actually running".
 *
 * It rendered `st.info.commit.slice(0, 7)` — seven authoritative hex characters
 * — for builds packaged from a dirty tree, so it confidently reported a commit
 * whose content was not what shipped. A binary stamped 9699619 contained the
 * tailscale-serve auth fix from dd1f558, its child, and "does my installed app
 * have the security fix?" could not be answered from this row at all.
 *
 * The server now sends `stamp`, which is a bare sha only when the packaged tree
 * really was that commit. These are source assertions rather than a render,
 * because this repo has no DOM harness for web/ — the wire underneath them is
 * exercised for real in server/test/update-status-origin.test.ts, and the shape
 * of the stamp itself in server/test/build-stamp.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const pane = src.slice(src.indexOf("function AboutPane"), src.indexOf("function CookieImport"));

describe("what the row shows", () => {
  test("the stamp, not a commit sha trimmed to look like one", () => {
    expect(pane).toContain("st.info.stamp");
    // The old expression, as the primary value, is the bug. It survives only as
    // the fallback for a build installed before the stamp existed, so it may
    // never appear without `st.info.stamp` in front of it.
    const primary = pane.slice(pane.indexOf("const short ="), pane.indexOf("\n", pane.indexOf("const short =")));
    expect(primary.indexOf("st.info.stamp")).toBeLessThan(primary.indexOf("commit.slice(0, 7)"));
  });

  test("a build that is not a commit is marked, not merely spelled differently", () => {
    // `9699619+dirty.a3f1c2e` is already unmistakable read carefully. The row is
    // not read carefully — it is glanced at — so it also changes colour.
    expect(pane).toContain("st.info.dirty");
    expect(pane).toContain("var(--warning)");
  });

  test("and says in words what it means, with the files it carries", () => {
    // "whose uncommitted work is in the app I am running" is the question that
    // had no answer the day an install shipped another session's main.js.
    expect(pane).toMatch(/uncommitted tree/i);
    expect(pane).toContain("st.info.dirtyCount");
    expect(pane).toContain("st.info.dirtyFiles");
  });
});

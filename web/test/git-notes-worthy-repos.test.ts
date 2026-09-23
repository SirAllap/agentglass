import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { notesWorthyRepos } from "../src/lib/gitNote.ts";

/*
 * "Branches behind" scoped to the folders THIS instance holds.
 *
 * `/git/repos` with no project open is a whole-machine sweep — every repo the
 * install has ever seen an agent touch, not the folders this window was
 * pointed at. A note about a checkout nobody here added is a wrong number, not
 * news: the picker already tells the same story with `roots` (the folders the
 * person actually configured), and this is that filter applied to the bell.
 */
const repo = (root: string) => ({ root, name: root.split("/").pop()!, branch: "main", dirty: 0, ahead: 0, behind: 3 });

describe("notesWorthyRepos", () => {
  it("drops a repo outside every configured root", () => {
    const repos = [repo("/home/dev/code/orbit"), repo("/home/dev/other/acme")];
    const kept = notesWorthyRepos(repos, ["/home/dev/code"]);
    expect(kept.map((r) => r.root)).toEqual(["/home/dev/code/orbit"]);
  });

  it("keeps a repo that IS the root, not just under it", () => {
    const repos = [repo("/home/dev/code/orbit")];
    expect(notesWorthyRepos(repos, ["/home/dev/code/orbit"]).map((r) => r.root)).toEqual(["/home/dev/code/orbit"]);
  });

  it("never matches a sibling with the same prefix", () => {
    // /home/dev/code-orbit-2 must not pass for root /home/dev/code.
    const repos = [repo("/home/dev/code-orbit-2")];
    expect(notesWorthyRepos(repos, ["/home/dev/code"])).toEqual([]);
  });

  it("keeps everything when no roots are configured yet", () => {
    // A fresh install, or a window with nothing added: filtering to nothing
    // would just make the feature look broken, not scoped.
    const repos = [repo("/home/dev/code/orbit"), repo("/home/dev/other/acme")];
    expect(notesWorthyRepos(repos, [])).toBe(repos);
  });
});

/*
 * And the bell actually applies it — both to the note and to the "to pull"
 * chip, which the plan takes as its default: a counter that disagreed with
 * the filtered list would be the next bug report. Read between landmarks,
 * since there is no renderer in this project (CLAUDE.md).
 */
const bar = readFileSync(new URL("../src/components/TopBarNotes.tsx", import.meta.url), "utf8");
const between = (from: string, to: string): string => {
  const a = bar.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = bar.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return bar.slice(a, b);
};

describe("the poll applies the filter to both the row and the chip", () => {
  it("calls notesWorthyRepos before counting and before recordNote", () => {
    const poll = between("const poll = async () => {", "const off = subscribeGitChanged");
    expect(poll).toContain("notesWorthyRepos(");
    // Applied before the loop that both sums `total`/`mine` and recordNotes —
    // filtering only the note and leaving the chip's count whole-machine
    // would make the two disagree.
    expect(poll.indexOf("notesWorthyRepos(")).toBeLessThan(poll.indexOf("for (const r of"));
  });
});

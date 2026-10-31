// Toast text and commands the Git panel showed wrongly: "applyed", "droped",
// `git restore` for a file the server deletes, an absolute path clipped to its
// useless end, and git's whole `error: … hint: …` block in a toast.
import { test, expect } from "bun:test";
import { pastTense, discardCommand, repoRelative, plainGitError, actionsFor } from "../src/lib/gitActions.ts";

test("past tense for every verb the panel passes", () => {
  expect(["apply", "drop", "stage", "unstage", "discard", "pop"].map(pastTense))
    .toEqual(["Applied", "Dropped", "Staged", "Unstaged", "Discarded", "Popped"]);
});

test("discard names the command the server runs, tracked or not", () => {
  expect(discardCommand("notes.txt", true)).toBe("git clean -fd -- notes.txt");
  expect(discardCommand("src/a.ts", false)).toBe("git restore --staged --worktree -- src/a.ts");
  const menu = actionsFor("file", "notes.txt", { untracked: true }).find((a) => a.id === "discard");
  expect(menu?.command).toBe("git clean -fd -- notes.txt");
  expect(menu?.irreversible).toBe(true);
});

test("repoRelative cuts the root and leaves a foreign path whole", () => {
  expect(repoRelative("/home/dev/orbit", "/home/dev/orbit/src/a.ts")).toBe("src/a.ts");
  expect(repoRelative("/home/dev/orbit", "/home/dev/orbit-two/a.ts")).toBe("/home/dev/orbit-two/a.ts");
  expect(repoRelative(undefined, "/x/y")).toBe("/x/y");
});

test("a refused branch delete is one sentence plus git's line, without the hint", () => {
  const raw = "error: the branch 'feat' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D feat'\nhint: Disable this message with \"git config advice.forceDeleteBranch false\"";
  const out = plainGitError(raw);
  expect(out).toContain("Not deleted");
  expect(out).toContain("the branch 'feat' is not fully merged");
  expect(out).not.toContain("hint");
});

test("a conflicted merge drops the rerere line", () => {
  const raw = "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nRecorded preimage for 'a.txt'\nAutomatic merge failed; fix conflicts and then commit the result.";
  const out = plainGitError(raw);
  expect(out).toContain("CONFLICT (content): Merge conflict in a.txt");
  expect(out).not.toContain("Recorded preimage");
});

test("a message of our own passes whole", () => {
  expect(plainGitError("3 files here belong to root.\n\nFix it first:\n  sudo chown x")).toContain("sudo chown");
});

// The menu does not confirm: a destructive action's handler asks once, in a
// GitDialog that shows the command and, for the three nothing can bring back,
// says "This cannot be undone". Every red item must reach such a handler.
test("the row menu asks nothing: every danger action is asked once by its handler", async () => {
  const menu = await Bun.file(new URL("../src/components/GitRowMenu.tsx", import.meta.url)).text();
  expect(menu).not.toContain("confirming");
  expect(menu).not.toContain("Yes, run it");
  expect(menu).toContain("onAction(a.id)");
  const kinds = ["file", "stash", "worktree", "tag", "branch"] as const;
  const dangerIds = (pick: (a: { danger?: boolean; irreversible?: boolean }) => boolean) =>
    kinds.flatMap((k) => actionsFor(k, "x", {}).filter(pick).map((a) => k + ":" + a.id));
  const irreversible = dangerIds((a) => !!a.danger && !!a.irreversible);
  expect(irreversible.sort()).toEqual(["file:discard", "stash:drop", "worktree:remove"]);
  expect(dangerIds((a) => !!a.danger)).toContain("stash:overwrite");
  for (const id of irreversible) {
    const [k, a] = id.split(":");
    expect(actionsFor(k as (typeof kinds)[number], "x", {}).find((x) => x.id === a)?.command).toBeTruthy();
  }
});

test("a rebase or pick that stops on a conflict is a sentence, not git's progress line", () => {
  const out = plainGitError("Rebasing (1/4)\nerror: could not apply b4dd456... main: edit line3");
  expect(out).toContain("Stopped on a conflict");
  expect(out).not.toContain("Rebasing (");
});

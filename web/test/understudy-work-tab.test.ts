/*
 * The work loop is reachable from the application, and it offers nothing it is
 * not allowed to do.
 *
 * WHY THIS TEST EXISTS. The loop shipped as routes and a database and nothing
 * else: every part of it — the queue he fills by hand, which project is open,
 * the runs it had done, the button that starts one — was reachable with curl
 * and invisible in the app. So the only person who could work the feature was
 * the one holding the route table in their head, and asked directly whether the
 * panel had been adapted to this version of the clone, the honest answer was no.
 *
 * A capability nobody can see is a capability nobody uses, and that is a
 * regression a type checker cannot have an opinion about.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src", "components", "understudy");
const work = readFileSync(join(SRC, "Work.tsx"), "utf8");
/*
 * The file with its reasoning removed.
 *
 * The comments in this codebase explain WHY, and explaining why the loop does
 * not open a pull request means writing the words "pull request" — which a
 * naive scan then reports as the very thing the comment says is absent. Same
 * lesson the private-name guard learned: a guard that reads prose instead of
 * decisions punishes the file for being documented.
 */
const code = work
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");
const panel = readFileSync(join(SRC, "UnderstudyPanel.tsx"), "utf8");

describe("the work loop is on screen", () => {
  test("the panel registers the tab, renders it, and opens on it", () => {
    // All three, because any one alone is a tab that half exists: a label with
    // no body draws an empty panel, and a body with no label is unreachable.
    expect(panel).toContain('import { Work } from "./Work.tsx"');
    /* The id is the contract; the LABEL is not. It reads "Its work" now —
       "Work", "Ask" and "Teach" named the machinery rather than anything a
       person came here to do, and they read left to right in the reverse of
       the order they are used in. */
    expect(panel).toMatch(/id:\s*"work" as const,\s*label:\s*"Its work"/);
    expect(panel).toContain('tab === "work"');
    /*
     * And it is the LANDING tab. The scorecard measures whether it decides like
     * him, which was the previous version's whole question; this one is the
     * thing he asked for. Opening on the instrument rather than the work would
     * be the panel still answering the old question.
     */
    expect(panel).toMatch(/useState<[^>]*>\("work"\)/);
  });

  test("it shows where each run left its worktree", () => {
    /*
     * NOTHING IS PUSHED, so the only way to see what a run did is to go to the
     * directory it made. A failed run keeps its worktree deliberately — it is
     * the evidence — and a path nobody can read is a directory nobody will ever
     * open or clean up.
     */
    expect(work).toContain("r.worktree");
    expect(work).toContain("r.branch");
  });

  test("it prints what the tests said, and does not offer to push", () => {
    // The tests decide, not the agent's own report — the two are drawn as
    // different things because his rule is that compiling is not evidence.
    expect(work).toContain("r.outcome");
    /*
     * No push, and enumerated rather than trusted: this repository has a great
     * deal of local work that has never gone to a remote, and the loop has no
     * verb for it. A button appearing here should fail a test rather than be
     * noticed after it has run.
     */
    /*
     * The ROUTES it calls, not the words on the page. A first attempt banned
     * the string and failed on the sentence that promises nothing is pushed —
     * the guard punishing the screen for saying the thing the guard wants true.
     *
     * A boolean and a short message rather than the file: an assertion that
     * prints four hundred lines on failure is a test nobody reads the output of.
     */
    const reaches = [/\b(post|fetch)\([^)]*push/i, /\b(post|fetch)\([^)]*\/pulls?\b/i, /\b(post|fetch)\([^)]*\/prs?\b/i];
    const guilty = reaches.find((re) => re.test(code));
    expect(guilty ? String(guilty) : "", "the work tab must not reach a route that publishes").toBe("");
  });

  test("nothing asks through a dialog Electron does not have", () => {
    /*
     * `window.prompt` is not implemented in Electron's renderer — it returns
     * nothing and logs that it never will. A control built on it does nothing
     * at all in the only place this application actually runs, and does it
     * silently, which is worse than a control that errors.
     */
    expect(code).not.toMatch(/(^|[^.\w])prompt\s*\(/m);
    expect(code).not.toMatch(/\balert\s*\(/);
    expect(code).not.toMatch(/\bconfirm\s*\(/);
  });

  test("every hook is above the early return", () => {
    /*
     * The app has shipped a black window for exactly this: a `useState` below a
     * `return null` changes the hook count between renders and React throws out
     * of the whole tree. The `if (!active) return null` in this file is what
     * makes it worth checking here as well as in the sweep.
     */
    const cut = work.indexOf("if (!active) return null");
    expect(cut).toBeGreaterThan(0);
    expect(work.slice(cut)).not.toMatch(/\buse(State|Effect|Callback|Memo|Ref|SyncExternalStore)\s*\(/);
  });
});

/*
 * THE SCOPE CONTROL MOVED, and its test moved with it.
 *
 * What stood here read the source for `<Chip … resting>`. The control is a
 * component of its own now, and understudy-tracker-fence.test.ts RENDERS it:
 * the border it actually draws when closed, the words in each state, and
 * `aria-pressed`.
 *
 * A stronger test of the same property — what a person sees — and keeping both
 * would mean one failing every time the markup is rearranged for a reason
 * nobody minds.
 */

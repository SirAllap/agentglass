/*
 * No private name, and no project name, in the logic of a public repository.
 *
 * TWO SEPARATE RULES, and they failed for different reasons.
 *
 * The first is the repository's own, older than this feature: a public codebase
 * must not carry the name of an employer, a private project or a real ticket.
 * There is a pre-commit hook for the terms somebody has already thought of, and
 * the hook only knows the names it was told — so the one that catches the FIRST
 * occurrence has to be a person or a test.
 *
 * The second is subtler and I wrote it in myself. The loop's fence was
 * `/(^|[/-])agentglass([/-]|$)/` hard-coded in four files: the name of one
 * person's public project baked into logic, with everything else defined as
 * "not that". Both halves are facts about one machine rather than about the
 * software, and a fence that has to be edited to point somewhere else is a
 * fence nobody else can use.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function understudyFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const [dir, prefix] of [[join(here, "..", "src"), "understudy"], [here, "understudy"]] as const) {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith(".ts")) continue;
      if (statSync(join(dir, f)).isFile()) out.push({ path: f, text: readFileSync(join(dir, f), "utf8") });
    }
  }
  return out;
}

describe("nothing private is written down", () => {
  test("no employer or ticket identifier appears anywhere in the feature", () => {
    /*
     * Shapes rather than a name list, because a list only catches what somebody
     * already thought of. A ticket identifier and a workspace host have a
     * FORM — that is what makes them findable before anybody knows the value.
     */
    /*
     * `ORBIT-` is the agreed FICTIONAL prefix, and exempting it by name is the
     * point rather than a weakness: the house rule is "measure against the real
     * thing, write the invented one", so the fixtures deliberately carry a
     * ticket-shaped identifier that belongs to nobody. A guard that refused it
     * would push somebody toward writing a real one to make the test pass.
     */
    const shapes: [string, RegExp][] = [
      ["a ticket identifier", /\b(?!ORBIT-)[A-Z]{2,}-\d{3,}\b/],
      ["a tracker workspace URL", /app\.clickup\.com\/\d/i],
      ["a real card id", /\bclickup:\d{6,}/i],
    ];
    const bad: string[] = [];
    for (const { path, text } of understudyFiles()) {
      for (const [what, re] of shapes) {
        const m = re.exec(text);
        if (m) bad.push(`${path}: ${what} — ${m[0]}`);
      }
    }
    expect(bad, `private identifiers in a public repository:\n${bad.join("\n")}`).toEqual([]);
  });

  test("the open project is a setting, not a name in the source", async () => {
    /*
     * It was hard-coded in four files. The default is derived from the checkout
     * the server runs from, which is right on every install and asks nobody to
     * configure anything — but the VALUE lives in a store, so pointing the loop
     * at a different project is a decision somebody makes rather than a diff.
     */
    /*
     * EVERY understudy source, not a list of four names.
     *
     * The list named two files that have since been deleted, so the guard
     * failed for having fewer files to check rather than for finding anything
     * — and the fix somebody reaches for at that point is lowering the number.
     * A guard that covers whatever is there keeps working as files come and go,
     * and covers the file somebody adds tomorrow without being edited.
     */
    /*
     * Every understudy SOURCE, and only the sources.
     *
     * A test may name the project — a fixture has to say something, and the
     * house rule is to measure against the real thing and write the invented
     * one, which is about what leaves the machine rather than about what a
     * fixture is called. Shipped code deciding on a literal name is the thing
     * this catches.
     */
    const logic = understudyFiles().filter(({ path }) => !path.endsWith(".test.ts"));
    expect(logic.length, "there should be understudy sources to check").toBeGreaterThan(4);
    for (const { path, text } of logic) {
      // Strip comments: the reasoning may name the project, the logic may not.
      const code = text
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      /*
       * DECISIONS, not prose. The application's own name may appear in a
       * sentence the agent reads — "agentglass is running at …" is a fact about
       * this software, not about anybody's private work. What must not appear
       * is the name inside a TEST: a regex, a comparison, an `includes`. That
       * is the difference between mentioning the project and deciding with it.
       */
      const decisions = [
        /\/[^/\n]*agentglass[^/\n]*\/[gimsuy]*\.test\(/i,
        /[=!]==\s*["'`][^"'`]*agentglass/i,
        /\.includes\(\s*["'`][^"'`]*agentglass/i,
      ];
      const guilty = decisions.find((re) => re.test(code));
      expect(
        guilty ? `${path} matched ${guilty}` : "",
        `${path} still decides using a project name instead of the setting`,
      ).toBe("");
    }
  });

  test("the matcher is a segment test, not a substring one", async () => {
    const U = await import("../src/understudy.ts");
    U.setOpenProject("thing");
    // The project, and its worktrees, which are the project's name plus a suffix.
    expect(U.isOpenProjectPath("/home/dev/code/thing")).toBe(true);
    expect(U.isOpenProjectPath("/home/dev/code/thing-feature")).toBe(true);
    expect(U.isOpenProjectPath("/home/dev/code/thing/server")).toBe(true);
    // And NOT something that merely contains the letters. This is the whole
    // reason it is a segment test: `thingamabob-private` is somebody else's.
    expect(U.isOpenProjectPath("/home/dev/code/thingamabob-private")).toBe(false);
    expect(U.isOpenProjectPath("/home/dev/code/something")).toBe(false);
    U.setOpenProject("");
  });

  test("with no setting it derives from where the server runs", async () => {
    const U = await import("../src/understudy.ts");
    U.setOpenProject("");
    // Never empty on a real install, and never a guess: it is the checkout this
    // server runs from, with any worktree suffix removed.
    expect(U.openProjectName().length).toBeGreaterThan(0);
  });

  test("the derived name is the checkout, not the directory it was started in", async () => {
    /*
     * The bug this pins: the name was the last segment of `process.cwd()`, and
     * the documented way to start the server is `cd server && bun run start`.
     * So the open project became `server` — a fence that opens on any
     * repository with a `server` directory in it, while the loop's own checkout
     * stopped matching the filter that decides where it may work, and it
     * declined every task it was offered.
     *
     * `bun test` runs from `server/` too, so this suite starts in exactly the
     * directory that used to give the wrong answer.
     */
    const U = await import("../src/understudy.ts");
    const { repoRootOf } = await import("../src/git.ts");
    U.setOpenProject("");
    const started = process.cwd();
    const root = repoRootOf(started);
    expect(root, "this suite runs inside a checkout").toBeTruthy();
    try {
      const answers = new Set([started, root!, join(here, "..", "src")].map((dir) => {
        process.chdir(dir);
        return U.openProjectName();
      }));
      expect([...answers], "one checkout, one name, wherever it is asked from").toHaveLength(1);
      // And the name is the checkout's own, which is what the loop's filter
      // asks: a repository it cannot recognise is a repository it declines.
      expect(U.isOpenProjectPath(root!)).toBe(true);
    } finally {
      process.chdir(started);
    }
  });
});

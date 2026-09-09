/*
 * Which work item a pull request is about, on a machine that may track work in
 * anything or in nothing at all.
 *
 * The failure this guards against is not a missing chip. It is a chip that is
 * confidently wrong: a Jira shop shown a ClickUp mark, a Renovate branch given
 * an id it does not have, or a link to a page that does not exist. So most of
 * what is pinned here is what the reader REFUSES to say.
 */
import { describe, expect, test } from "bun:test";
import { chipFor, matchesQuery, readTaskRef, taskRefTitle } from "../../shared/taskref.ts";

const PR = "https://github.com/acme/widget/pull/91";

describe("an address in the body is certain", () => {
  test("a ticket, named by the tracker whose address it is", () => {
    const ref = readTaskRef({
      body: "Rewrites the retry loop.\n\nhttps://acme.atlassian.net/browse/WEB-1042",
      url: PR,
    });
    expect(ref).toMatchObject({ label: "WEB-1042", query: "WEB-1042", tracker: "jira", from: "url" });
    expect(ref!.url).toBe("https://acme.atlassian.net/browse/WEB-1042");
  });

  test("each shape reads, and none of them is guessed from an id", () => {
    const of = (line: string) => readTaskRef({ body: `Body.\n\n${line}`, url: PR });
    expect(of("https://linear.app/acme/issue/ENG-88/retry-loop")!.tracker).toBe("linear");
    expect(of("https://app.shortcut.com/acme/story/4471")!.tracker).toBe("shortcut");
    expect(of("https://trello.com/c/aB9xQ2Zk")!.tracker).toBe("trello");
    expect(of("https://app.asana.com/0/1200/1209")!.tracker).toBe("asana");
    expect(of("https://dev.azure.com/acme/Widget/_workitems/edit/771")!.tracker).toBe("azure");
    expect(of("https://gitlab.com/acme/widget/-/issues/12")!.tracker).toBe("gitlab");
  });

  test("a workspace segment is not the item", () => {
    // `/t/<team>/<id>` — the last one is the task. The first is the workspace,
    // and handing that to a lookup asks for an item whose id is a team number.
    expect(readTaskRef({ body: "https://app.clickup.com/t/900100/ORBIT-1042" })!.query).toBe("ORBIT-1042");
    expect(readTaskRef({ body: "https://clickup.com/t/8ab12cd34" })!.query).toBe("8ab12cd34");
  });

  test("a link to the tracker's front page is not a ticket", () => {
    // Anchored on a path segment that means "an item", not on the host. A link
    // to somebody's board is not the thing this pull request is about.
    expect(readTaskRef({ body: "See https://acme.atlassian.net/jira/software/projects/WEB" })).toBeNull();
    expect(readTaskRef({ body: "Board: https://app.clickup.com/9001/v/li/900200" })).toBeNull();
  });

  test("the branch's id is preferred as the LABEL, the address as the query", () => {
    // People say "ORBIT-1042" out loud; a lookup wants the id that cannot be
    // ambiguous.
    const ref = readTaskRef({
      headRefName: "feat/ORBIT-1042-retry",
      body: "https://clickup.com/t/8ab12cd34",
    });
    expect(ref).toMatchObject({ label: "ORBIT-1042", query: "8ab12cd34" });
  });
});

describe("a template's own links are not this pull request's item", () => {
  const TEMPLATE = [
    "## Checklist",
    "- [x] I have read the [contributing guide](https://acme.atlassian.net/browse/WEB-1).",
    "- [ ] Trial only — see [WEB-3306](https://acme.atlassian.net/browse/WEB-3306).",
    "",
    "## Reference",
    "",
    "https://acme.atlassian.net/browse/WEB-1042",
  ].join("\n");

  test("only the one written on a line of its own survives", () => {
    expect(readTaskRef({ body: TEMPLATE })!.query).toBe("WEB-1042");
  });

  test("a quoted address is somebody else's too", () => {
    expect(readTaskRef({ body: "> https://acme.atlassian.net/browse/WEB-9\n\nAgreed." })).toBeNull();
  });

  test("two different items means it cannot tell, so it says nothing", () => {
    const two = "https://acme.atlassian.net/browse/WEB-1042\n\nhttps://trello.com/c/aB9xQ2Zk";
    expect(readTaskRef({ body: two })).toBeNull();
  });

  test("the same item twice is still one item", () => {
    const twice = "https://acme.atlassian.net/browse/WEB-1042\n\nAgain: https://acme.atlassian.net/browse/WEB-1042";
    expect(readTaskRef({ body: twice })!.query).toBe("WEB-1042");
  });
});

describe("the issue a pull request says it closes", () => {
  test("the host's own syntax, which needs no tracker connected", () => {
    const ref = readTaskRef({ body: "Fixes #12", url: PR });
    expect(ref).toMatchObject({ label: "#12", from: "url", tracker: "github" });
    expect(ref!.url).toBe("https://github.com/acme/widget/issues/12");
  });

  test("another repository's issue keeps that repository", () => {
    expect(readTaskRef({ body: "Closes acme/other#7", url: PR })!.url)
      .toBe("https://github.com/acme/other/issues/7");
  });

  test("a merge request resolves against its own host", () => {
    expect(readTaskRef({ body: "Resolves #5", url: "https://gitlab.com/acme/widget/-/merge_requests/3" })!.url)
      .toBe("https://gitlab.com/acme/widget/-/issues/5");
  });

  test("a bare number is not a reference", () => {
    // Bodies are full of `#12`, and as often as not it is another pull request.
    expect(readTaskRef({ body: "Same as #12, but for the phone.", url: PR })).toBeNull();
  });

  test("a linked ticket beats a closing keyword", () => {
    // Somebody who did both means the ticket; the issue is housekeeping.
    const ref = readTaskRef({ body: "https://linear.app/acme/issue/ENG-88\n\nFixes #12", url: PR });
    expect(ref!.query).toBe("ENG-88");
  });

  test("with no pull request address there is nowhere to send it", () => {
    expect(readTaskRef({ body: "Fixes #12" })).toBeNull();
  });
});

describe("an id by convention", () => {
  test("is read from the branch, and named by nobody", () => {
    const ref = readTaskRef({ headRefName: "feat/ORBIT-1042-retry" });
    expect(ref).toMatchObject({ label: "ORBIT-1042", from: "branch", tracker: null });
    expect(ref!.url).toBeUndefined();
  });

  test("falls back to the title, which people type by hand", () => {
    expect(readTaskRef({ title: "[WEB-1042] retry the loop" })).toMatchObject({ from: "title" });
  });

  test("the branch names every release tool cuts are not ids", () => {
    for (const branch of [
      "fix/UTF-8-decode",
      "release/v2-1409",
      "dependabot/npm_and_yarn/types/node-22-10-1",
      "claude/phone-threads-on-the-line",
      "agent-v2",
    ]) {
      expect(readTaskRef({ headRefName: branch }), branch).toBeNull();
    }
  });
});

describe("what the chip may do with it", () => {
  const byUrl = readTaskRef({ body: "https://trello.com/c/aB9xQ2Zk" })!;
  const byBranch = readTaskRef({ headRefName: "feat/ORBIT-1042-retry" })!;

  test("a URL opens, whether or not anything is connected here", () => {
    expect(chipFor(byUrl, false)).toEqual({ open: "https://trello.com/c/aB9xQ2Zk" });
    expect(chipFor(byUrl, null)).toEqual({ open: "https://trello.com/c/aB9xQ2Zk" });
  });

  test("a bare id is handed to whatever IS connected", () => {
    expect(chipFor(byBranch, true)).toEqual({ find: "ORBIT-1042" });
  });

  test("and shown to nobody when nothing can resolve it", () => {
    // The rule that keeps this feature honest on a machine that tracks work
    // nowhere: it is not a chip that fails on tap, it is no chip.
    expect(chipFor(byBranch, false)).toBeNull();
    expect(chipFor(null, true)).toBeNull();
  });

  test("nor while the answer has not arrived", () => {
    // Null is "not yet", and a chip that appears a second late is better than
    // one that appears and vanishes.
    expect(chipFor(byBranch, null)).toBeNull();
  });

  test("the long form says which evidence it rests on", () => {
    expect(taskRefTitle(byUrl)).toContain("linked from the description");
    expect(taskRefTitle(byBranch)).toContain("convention rather than a link");
  });
});

/*
 * Handing that id to the Cards tab.
 *
 * The tab filters the rows it already has rather than asking the tracker, which
 * is what makes it work for everybody: the rows are whatever the connected
 * provider returned, and this question can be asked of a card, a Taskwarrior
 * task, or whatever comes next. Nothing here knows which one it is looking at,
 * and that is the property under test.
 */
describe("finding that item among rows of any shape", () => {
  test("a card answers on its custom id, its internal id or its title", () => {
    const card = ["Retry the loop", "ORBIT-1042", "8ab12cd34", "In review"];
    expect(matchesQuery(card, "ORBIT-1042")).toBe(true);
    expect(matchesQuery(card, "8ab12cd34")).toBe(true);
    expect(matchesQuery(card, "retry")).toBe(true);
    expect(matchesQuery(card, "WEB-9")).toBe(false);
  });

  test("a local task answers on the fields a local task has", () => {
    // No ids, no lists — a description, a project and tags. The matcher is
    // shape-free precisely so this row needs no special case.
    const task = ["Retry the loop on 429", "widget", "phone", "review"];
    expect(matchesQuery(task, "retry loop")).toBe(true);
    expect(matchesQuery(task, "widget")).toBe(true);
    expect(matchesQuery(task, "ORBIT-1042")).toBe(false);
  });

  test("every word has to appear, in any of the fields", () => {
    expect(matchesQuery(["Retry the loop", "widget"], "retry widget")).toBe(true);
    expect(matchesQuery(["Retry the loop", "widget"], "retry gadget")).toBe(false);
  });

  test("case does not matter, and neither do missing fields", () => {
    expect(matchesQuery(["Retry", null, undefined, "ORBIT-1042"], "orbit-1042")).toBe(true);
  });

  test("an empty query matches nothing, so a caller cannot filter by accident", () => {
    // The screen reads it from a route parameter. Empty there means "show what
    // you were showing", and that decision belongs to the screen — not to a
    // matcher that would otherwise quietly return everything or nothing.
    expect(matchesQuery(["anything"], "")).toBe(false);
    expect(matchesQuery(["anything"], "   ")).toBe(false);
  });
});

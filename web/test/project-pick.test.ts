/*
 * The decisions behind the project picker, taken out of the screen.
 *
 * The picker ticks several projects and opens them together, lists only what is
 * under the folders the person added, and remembers anything opened from
 * outside those folders so it is still on the list next time. Each of those is
 * a small rule that is easy to get subtly wrong in a component — a set compared
 * by order, a sibling folder matched by its prefix — and this repo has no DOM
 * harness, so they live in lib/projectPick.ts and are asserted here.
 */
import { describe, expect, test } from "bun:test";
import { allOpen, autoPick, initialTicks, inOpenProjects, nextScope, rootsToAdd, scopeLabel, scopeTitle } from "../src/lib/projectPick.ts";

// Comment lines out, so a sentence about the gate cannot stand in for the gate.
const APP = (await Bun.file(new URL("../src/App.tsx", import.meta.url)).text())
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const CHAT = await Bun.file(new URL("../src/components/ChatPanel.tsx", import.meta.url)).text();

const ORBIT = "/home/dev/code/orbit";
const LANDER = "/home/dev/code/lander";
const DOCS = "/srv/docs/handbook";

describe("the project button's label", () => {
  test("no project open has no label of its own — the caller says 'all repos'", () => {
    expect(scopeLabel([])).toBeNull();
  });
  test("one project is its folder's name", () => {
    expect(scopeLabel([ORBIT])).toBe("orbit");
  });
  test("several are the first one and how many more", () => {
    expect(scopeLabel([ORBIT, LANDER, DOCS])).toBe("orbit +2");
  });
  test("the tooltip names every one of them", () => {
    expect(scopeTitle([ORBIT, LANDER])).toBe(`${ORBIT}\n${LANDER}`);
  });
});

describe("what the Open button sends", () => {
  test("the ticked projects, in the order they were ticked", () => {
    expect(nextScope([LANDER, ORBIT], [])).toEqual([LANDER, ORBIT]);
  });
  test("nothing when it would change nothing, whatever the order", () => {
    expect(nextScope([LANDER, ORBIT], [ORBIT, LANDER])).toBeNull();
  });
  test("nothing ticked sends nothing — unticking everything is not 'the whole machine'", () => {
    expect(nextScope([], [ORBIT])).toBeNull();
  });
});

describe("'All projects'", () => {
  test("is open when the scope is exactly the added folders", () => {
    expect(allOpen(["/home/dev/code"], ["/home/dev/code"])).toBe(true);
  });
  test("is not open for a subset of them, or with no folders at all", () => {
    expect(allOpen([ORBIT], ["/home/dev/code"])).toBe(false);
    expect(allOpen([], [])).toBe(false);
  });
});

describe("remembering what was opened", () => {
  test("a project under an added folder needs nothing added", () => {
    expect(rootsToAdd([ORBIT], ["/home/dev/code"])).toEqual([]);
  });
  test("one outside every folder is added as a folder of its own", () => {
    expect(rootsToAdd([ORBIT, DOCS], ["/home/dev/code"])).toEqual([DOCS]);
  });
  test("a sibling that merely shares the prefix is outside", () => {
    expect(rootsToAdd(["/home/dev/code-old/thing"], ["/home/dev/code"])).toEqual(["/home/dev/code-old/thing"]);
  });
  test("the folder itself is inside itself", () => {
    expect(rootsToAdd(["/home/dev/code"], ["/home/dev/code/"])).toEqual([]);
  });
});

describe("what belongs to the open projects", () => {
  test("a directory in the second project is as much in scope as one in the first", () => {
    expect(inOpenProjects(`${LANDER}/src`, [ORBIT, LANDER])).toBe(true);
    expect(inOpenProjects(DOCS, [ORBIT, LANDER])).toBe(false);
  });
  test("nothing open keeps everything", () => {
    expect(inOpenProjects(DOCS, [])).toBe(true);
  });
  test("the chat list filters by every open project, not the first", () => {
    expect(CHAT).toContain("allChats.filter((c) => inOpenProjects(c.cwd, workspaces))");
  });
});

describe("what starts ticked, and what opens by itself", () => {
  test("the open projects the list can show start ticked", () => {
    expect(initialTicks([ORBIT, DOCS], [{ root: ORBIT }, { root: LANDER }])).toEqual([ORBIT]);
  });
  test("a folder with exactly one project in it opens that project, when nothing is open", () => {
    expect(autoPick([{ root: ORBIT }], [])).toBe(ORBIT);
  });
  test("but never over a project already open, and never a guess among several", () => {
    expect(autoPick([{ root: ORBIT }], [LANDER])).toBeNull();
    expect(autoPick([{ root: ORBIT }, { root: LANDER }], [])).toBeNull();
  });
});

describe("the first run waits for an answer", () => {
  // A fresh install opens the picker over the app. The views behind it used to
  // fill themselves from the whole machine meanwhile — the sweep the first run
  // exists to avoid — so they are not mounted until the picker is answered.
  test("the workspace is not mounted while the first question is open", () => {
    expect(APP).toContain("{!awaitingPick && <Workspace");
  });
  test("it waits from the very first render, not from when the server answers", () => {
    // Starting at false let the views mount, fetch the whole machine, and
    // unmount again once /projects came back unscoped.
    expect(APP).toMatch(/useState\(\(\) => \{\s*try \{ return localStorage\.getItem\(PICKER_ANSWERED_KEY\) !== "1"; \}/);
  });
  test("only an unscoped, never-answered instance keeps waiting", () => {
    expect(APP).toMatch(/if \(!p\.workspace && !answered\) \{ setProjectOpen\(true\); setAwaitingPick\(true\); \}\s*else setAwaitingPick\(false\);/);
  });
  test("a server that does not answer lets the views in rather than leave them out", () => {
    expect(APP).toMatch(/\.catch\(\(\) => \{\s*if \(!live\) return;\s*setAwaitingPick\(false\);/);
  });
  test("closing the picker, either way, lets the views in", () => {
    expect(APP).toMatch(/<ProjectPicker [^>]*onClose=\{\(\) => \{ setProjectOpen\(false\); setAwaitingPick\(false\); \}\}/);
  });
});

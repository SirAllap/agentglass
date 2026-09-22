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
import { allOpen, autoPick, clickScope, firstRun, initialTicks, openFolders, inOpenProjects, nextScope, rootsToAdd, scopeLabel, scopeTitle } from "../src/lib/projectPick.ts";

// Comment lines out, so a sentence about the gate cannot stand in for the gate.
const APP = (await Bun.file(new URL("../src/App.tsx", import.meta.url)).text())
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const CHAT = await Bun.file(new URL("../src/components/ChatPanel.tsx", import.meta.url)).text();
const PICKER = (await Bun.file(new URL("../src/components/ProjectPicker.tsx", import.meta.url)).text())
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

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

describe("what a click on one row opens", () => {
  test("a project that is not open opens on its own", () => {
    expect(clickScope(LANDER, [ORBIT])).toEqual([LANDER]);
    expect(clickScope(ORBIT, [])).toEqual([ORBIT]);
  });
  test("one that is already open changes nothing, even with others open beside it", () => {
    // With two open, a click on one of them reloaded the app on that one alone
    // — easy to do by accident, reaching for its tick box.
    expect(clickScope(ORBIT, [ORBIT, LANDER])).toBeNull();
    expect(clickScope(ORBIT, [ORBIT])).toBeNull();
  });
  test("the row asks the rule", () => {
    expect(PICKER).toContain("const choose = (root: string) => { const next = clickScope(root, workspaces); if (next) void openScope(next); else close(); };");
  });
});

describe("an open folder that is not one project", () => {
  // A scope of ~/code from before there were folders: its projects are listed,
  // none of them is what is open, and with other folders beside it "All
  // projects" is not what is open either — so nothing on the list said what was.
  const CODE = "/home/dev/code";
  test("is every open path the list has no project row for", () => {
    expect(openFolders([CODE, DOCS], [{ root: ORBIT }, { root: DOCS }])).toEqual([CODE]);
    expect(openFolders([ORBIT], [{ root: ORBIT }])).toEqual([]);
    expect(openFolders([], [{ root: ORBIT }])).toEqual([]);
  });
  test("gets a row of its own, marked open, unless 'All projects' already says it", () => {
    expect(PICKER).toMatch(/!allOpen\(workspaces, roots\) && openFolders\(workspaces, repos\)\.map\(\(w\) => \(\s*<Row key=\{w\} current icon=\{<FolderIcon/);
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

describe("the first run's screen", () => {
  const listed = [{ root: ORBIT }];
  test("no folder, nothing open and not looking is the first run", () => {
    expect(firstRun([], [], false, [])).toBe(true);
  });
  test("never over an open project, folders or not", () => {
    // An upgrade with a project open and no folders yet was told to add the
    // folder its projects live in, above the row of the project it had open.
    expect(firstRun(listed, [], false, [ORBIT])).toBe(false);
  });
  test("not with a folder added, while looking, or before the list is read", () => {
    expect(firstRun(listed, ["/home/dev/code"], false, [])).toBe(false);
    expect(firstRun([], [], true, [])).toBe(false);
    expect(firstRun(null, [], false, [])).toBe(false);
  });
  test("the screen asks the rule rather than keeping its own copy", () => {
    expect(PICKER).toContain("const isFirstRun = firstRun(repos, roots, scanned, workspaces);");
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
    expect(APP).toMatch(/if \(!p\.workspace && !answered\) \{ setProjectOpen\(true\); if \(!gaveUp\) setAwaitingPick\(true\); \}\s*else setAwaitingPick\(false\);/);
  });
  test("a server that answers slowly lets the views in, and a late answer does not take them away", () => {
    // Only a rejected request released the views, so one that hung left the
    // app blank — a scoped desktop instance included, whose answer would have
    // been "a project is open, go ahead".
    expect(APP).toMatch(/const release = setTimeout\(\(\) => \{ if \(!live\) return; gaveUp = true; setAwaitingPick\(false\); \}, PICK_WAIT_MS\);/);
    expect(APP).toMatch(/api\.projects\(\)\.then\(\(p\) => \{\s*if \(!live\) return;\s*clearTimeout\(release\);/);
    expect(APP).toContain("return () => { live = false; clearTimeout(release); if (timer) clearTimeout(timer); };");
  });
  test("a server that does not answer lets the views in rather than leave them out", () => {
    expect(APP).toMatch(/\.catch\(\(\) => \{\s*if \(!live\) return;\s*gaveUp = true;\s*setAwaitingPick\(false\);/);
  });
  test("closing the picker, either way, lets the views in", () => {
    expect(APP).toMatch(/<ProjectPicker [^>]*onClose=\{\(\) => \{ setProjectOpen\(false\); setAwaitingPick\(false\); \}\}/);
  });
});

describe("the whole machine", () => {
  // Leaving a scope for the unscoped view was a choice some people had made on
  // purpose, and once they opened anything the picker had no way back to it
  // but a hand edit of config.json.
  test("is a row of its own, open when nothing is", () => {
    expect(PICKER).toMatch(/<Row current=\{!workspaces\.length\} icon=\{<MonitorIcon size=\{ICON\.sm\} \/>\} title="Every project on this machine"/);
  });
  test("choosing it sends no projects at all", () => {
    expect(PICKER).toContain('title="Every project on this machine"');
    expect(PICKER).toMatch(/title="Every project on this machine"[^>]*onClick=\{\(\) => void openScope\(\[\]\)\}/);
  });
  test("an empty choice is not dropped as 'nothing changed' on its way", () => {
    // nextScope answers null for an empty list, so that unticking the last box
    // is not a request for the machine; the row has to get past that check.
    expect(PICKER).toContain("if (list.length ? !nextScope(list, workspaces) : !workspaces.length) { onClose(); return; }");
  });
});

describe("the picker's plumbing", () => {
  test("a long list of folders scrolls on its own instead of pushing the projects out", () => {
    // An upgrade seeds one folder per project the app knew, which on a busy
    // machine is dozens, and the list sits in the picker's fixed footer.
    expect(PICKER).toMatch(/<div className="agx-scroll flex flex-col mb-2 overflow-y-auto" style=\{\{ maxHeight: FOLDERS_MAX_PX \}\}>\s*\{roots\.map/);
  });
  test("a folder that opens its one project is not added a second time, as that project", () => {
    // openScope checked what to add against this render's folders, which did
    // not have the new one yet; the project inside it went in as a folder too.
    expect(PICKER).toContain("if (only) void openScope([only], r.roots);");
  });
  test("only the newest read of the list draws it", () => {
    expect(PICKER).toMatch(/const n = \+\+loadSeq\.current;/);
    expect(PICKER).toMatch(/if \(n === loadSeq\.current\) \{ setRepos\(repos\);/);
  });
  test("a folder saved while the environment overrides the list says so, both ways", () => {
    expect(PICKER.match(/if \(r\.note\) setError\(r\.note\);/g)?.length).toBe(2);
  });
});

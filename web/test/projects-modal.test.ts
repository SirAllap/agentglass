/*
 * The Open projects modal, one guard per defect found in the study of the old
 * picker (D1..D19). The decisions are pure helpers asserted by value; what only
 * the JSX can say is asserted against source, with comment lines stripped so a
 * sentence cannot stand in for the code. There is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import type { GitRepoRef } from "../../shared/types";
import {
  clock, cloneTargetName, cloneUrlError, folderToJoin, folderVerdict, middleSplit, nameError, nameSplit, railLabel, targetPreview, tildify,
} from "../src/lib/projectsPaths";
import { NOT_LISTED, SOURCE_ALL, buildGroups, flatten, groupCount, navRoots, railCounts, toggleGroup, tabsByRoot, sessionsByRoot, type ViewInput } from "../src/lib/projectsView";
import { initialTicks, withOpenFolders } from "../src/lib/projectPick";
import { enterTargets, keyCommand, moveHot, type KeyCtx, type KeyEvent } from "../src/lib/projectsKeys";
import { addReason, addRemote, type LookupAnswer } from "../src/lib/remoteRepos";
import { closeMatches } from "../src/components/RemoteRepoPage";
import { explainOpen, scopeAria } from "../src/lib/projectPick";
import { ADD_ROWS, folderRoute } from "../src/lib/addRows";
import { freshFinds } from "../src/components/projects/AgentsPane";

const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const src = async (f: string) => strip(await Bun.file(new URL("../src/components/projects/" + f, import.meta.url)).text());
const MODAL = await src("ProjectsModal.tsx");
const STATE = await src("useProjectsModal.ts");
const ROWS = await src("Rows.tsx");
const LIST = await src("ProjectList.tsx");
const CREATE = await src("CreatePane.tsx");
const SIDE = await src("SidePanes.tsx");
const FIELD = await src("FolderField.tsx");

const repo = (root: string, extra: Partial<GitRepoRef> = {}): GitRepoRef =>
  ({ root, name: root.split("/").pop()!, branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt: 0, ...extra });
const view = (over: Partial<ViewInput> = {}): ViewInput => ({
  repos: [repo("/w/code/orbit", { touchedAt: 5 }), repo("/w/code/lander"), repo("/w/docs/handbook")],
  folders: ["/w/code", "/w/docs"], workspaces: [], hidden: [], showHidden: false, query: "", source: SOURCE_ALL, ...over,
});
const key = (k: string, o: Partial<KeyEvent> = {}): KeyEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
const ctx = (o: Partial<KeyCtx> = {}): KeyCtx => ({ inField: false, inSearch: false, query: "", pane: "list", legendOpen: false, menuOpen: false, canUndo: false, busy: false, ...o });

describe("D1 the folder route is always offered", () => {
  test("a tab without a chooser gets the typed path, not a missing row", () => {
    expect(folderRoute(false)).toBe("typed");
    expect(ADD_ROWS[0]!.key).toBe("folder");
  });
  test("the first run draws the main route first", () => {
    expect(SIDE).toContain("onChooser");
  });
});

describe("D2 the filter reaches every group, and All/Every are not list rows", () => {
  test("a search keeps only matches and counts them against the folder total", () => {
    const gs = buildGroups(view({ query: "orb" }));
    expect(gs.flatMap((g) => g.items.map((r) => r.name))).toEqual(["orbit"]);
    const docs = gs.find((g) => g.full === "/w/docs")!;
    expect(docs.items).toEqual([]);
    expect(groupCount(docs, true)).toBe("0 of 1 match");
  });
  test("no row is called All projects", () => {
    const items = flatten(buildGroups(view()));
    expect(items.every((i) => i.t !== "row" || !/^(All|Every) projects?$/i.test(i.r.name))).toBe(true);
  });
});

describe("D3 nothing is cut without a way to read it", () => {
  test("the middle of a long path is kept, the ends are what tells folders apart", () => {
    const p = "/home/dev/code/clients/acme/orbit-platform/services/api";
    const { head, tail } = middleSplit(p);
    expect(head + tail).toBe(p);
    expect(tail).toContain("api");
  });
  test("name, branch and path all carry a title", () => {
    expect(ROWS).toContain("title={r.name}");
    expect(ROWS).toContain("title={r.branch}");
    expect(ROWS).toContain("title={r.root}");
    expect(ROWS).toContain("title={g.full ? `${g.full}` : undefined}");
  });
  test("a rail label shortens in the middle", () => {
    expect(railLabel("/home/dev/code/clients/acme/orbit-platform/services/api", 20)).toContain("…");
  });
});

describe("D4 the footer never moves", () => {
  test("Open N lives in the footer, which is outside the scrolling list", () => {
    expect(LIST).toContain("<Foot");
    expect(LIST.indexOf("<VirtualList")).toBeLessThan(LIST.indexOf("<Foot"));
  });
});

describe("D5 opening says it opened", () => {
  test("several projects show a result pane and hold it before the reload", () => {
    expect(STATE).toContain("OPENED_HOLD_MS");
    expect(STATE).toContain('setPane("result")');
  });
  test("a refusal says which project failed and which are still ready", () => {
    const rows = explainOpen(["/a", "/b"], { "/a": false, "/b": true }, "boom");
    expect(rows).toEqual([
      { path: "/a", state: "fail", why: "/a does not exist. It may be on a drive that is not mounted." },
      { path: "/b", state: "ready" },
    ]);
    expect(explainOpen(["/a"], {}, "boom")[0]!.why).toBe("boom");
  });
});

describe("D6 the agent sweep lists only what the list does not already have", () => {
  test("a repo already on the list is not a find", () => {
    const swept = [repo("/w/code/orbit"), repo("/x/other")];
    expect(freshFinds(swept, ["/w/code/orbit"]).map((r) => r.root)).toEqual(["/x/other"]);
  });
});

describe("D7 + D8 forgetting can be taken back", () => {
  test("forgetting a folder and hiding a project both raise an Undo toast", () => {
    expect(STATE).toContain("const forgetFolder = async");
    expect(STATE).toContain("const toggleHidden = (");
    expect(STATE.match(/undo/gi)?.length).toBeGreaterThanOrEqual(4);
  });
  test("an emptied list says so instead of dropping to the first run", () => {
    expect(STATE).toContain("setForgotFolder({ path: dir, count })");
    expect(SIDE).toContain("export function ForgotFolder");
  });
});

describe("D9 adding a folder says what it brought", () => {
  const pre = (repos: number, exists = true) => ({ exists, repos, path: "/w/new" });
  test("missing, empty, new and already-listed folders each have a verdict", () => {
    expect(folderVerdict("/w/new", pre(0, false), 0, false).state).toBe("missing");
    expect(folderVerdict("/w/new", pre(0), 0, false)).toMatchObject({ state: "zero", canAdd: true, label: "Add anyway" });
    expect(folderVerdict("/w/new", pre(5), 2, false)).toMatchObject({ state: "ok", fresh: 3, label: "Add 3 projects" });
    expect(folderVerdict("/w/new", pre(5), 5, true)).toMatchObject({ state: "already", canAdd: false });
    expect(folderVerdict("", null, 0, false).state).toBe("empty");
    expect(folderVerdict("/w/new", null, 0, false).state).toBe("checking");
  });
});

describe("D10 an error sits at the field and marks it", () => {
  test("the field takes a tone and the message is attached to it", () => {
    expect(FIELD).toContain("data-suggestions");
    expect(FIELD).toMatch(/tone/);
    expect(CREATE).toContain("inputBad");
  });
});

describe("D11 a long list is grouped, counted and virtual", () => {
  const many = Array.from({ length: 130 }, (_, i) => repo(`/w/code/p${String(i).padStart(3, "0")}`, { touchedAt: i + 1 }));
  test("recents come first, each project appears once", () => {
    const gs = buildGroups(view({ repos: many, folders: ["/w/code"] }));
    expect(gs[0]!.kind).toBe("recent");
    expect(gs[0]!.items).toHaveLength(6);
    const all = gs.flatMap((g) => g.items.map((r) => r.root));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(130);
  });
  test("the window draws a few rows, not the list", () => {
    expect(LIST).toContain("<VirtualList");
    expect(LIST).toContain("rowH={ROW_H}");
  });
  test("a group ticks as a whole and a second press unticks it", () => {
    const g = buildGroups(view())[0]!;
    const on = toggleGroup([], g);
    expect(on.sort()).toEqual(g.items.map((r) => r.root).sort());
    expect(toggleGroup(on, g)).toEqual([]);
  });
});

describe("D12 a repo added from GitHub lands first", () => {
  const found = { found: true, repo: "acme/orbit", private: false } as Extract<LookupAnswer, { found: true }>;
  test("newest at the top, where the eye is", () => {
    const list = addRemote([{ repo: "acme/old", addedAt: 1, lastSeen: 1 } as never], found, 9);
    expect(list.map((r) => r.repo)).toEqual(["acme/orbit", "acme/old"]);
  });
});

describe("D13 clone and new join their parent, once", () => {
  test("a project inside a listed folder adds nothing", () => {
    expect(folderToJoin("/w/code/new", "/w/code", ["/w/code"])).toBeNull();
  });
  test("otherwise the parent joins, not the project", () => {
    expect(folderToJoin("/w/clones/new", "/w/clones/", ["/w/code"])).toBe("/w/clones");
    expect(folderToJoin("/w/clones/new", "/w/clones", [], true)).toBe("/w/clones/new");
  });
  test("a sibling that shares a prefix is not inside", () => {
    expect(folderToJoin("/w/code-old/x", "/w/code-old", ["/w/code"])).toBe("/w/code-old");
  });
});

describe("D14 a clone can be walked away from", () => {
  test("elapsed time is shown and the wait can be stopped", () => {
    expect(clock(75)).toBe("1:15");
    expect(CREATE).toContain("Stop waiting");
    expect(CREATE).toMatch(/clock\(/);
  });
});

describe("D15 the target preview never invents a path", () => {
  test("an invalid URL or name draws nothing", () => {
    expect(targetPreview("clone", "sh -c id", "/w/clones")).toBeNull();
    expect(targetPreview("clone", "ext::sh/payload", "/w/clones")).toBeNull();
    expect(targetPreview("new", "bad name!", "/w/clones")).toBeNull();
    expect(targetPreview("clone", "https://github.com/acme/orbit.git", "/w/clones/")).toBe("/w/clones/orbit");
    expect(targetPreview("new", "orbit-2", "/w/clones")).toBe("/w/clones/orbit-2");
  });
});

describe("D16 a failed clone keeps git's real cause", () => {
  test("the page prints what git said, and the parent error points at its field", () => {
    expect(CREATE).toContain("git said:");
    expect(CREATE).toContain("inputBad");
  });
});

describe("D17 names and URLs are checked while typed", () => {
  test("a bad name says why and offers the fix", () => {
    expect(nameError("")).toBeNull();
    expect(nameError("orbit")).toBeNull();
    expect(nameError("my project!")).toMatchObject({ suggestion: "my-project" });
    expect(nameError("..")?.message).toContain("not a name");
  });
  test("a URL is judged before anything is sent", () => {
    expect(cloneUrlError("")).toBe("");
    expect(cloneUrlError("https://github.com/acme/orbit")).toBeNull();
    expect(cloneUrlError("git@github.com:acme/orbit.git")).toBeNull();
    expect(cloneUrlError("ext::sh -c id")).not.toBeNull();
    expect(cloneUrlError("-oProxyCommand=x")).not.toBeNull();
    expect(cloneTargetName("https://github.com/acme/orbit.git")).toBe("orbit");
  });
});

describe("D18 one keyboard model", () => {
  test("Esc peels one layer at a time, then closes", () => {
    expect(keyCommand(key("Escape"), ctx({ legendOpen: true }))).toEqual({ t: "closeLegend" });
    expect(keyCommand(key("Escape"), ctx({ menuOpen: true }))).toEqual({ t: "closeMenu" });
    expect(keyCommand(key("Escape"), ctx({ pane: "form" }))).toEqual({ t: "back" });
    expect(keyCommand(key("Escape"), ctx({ inField: true, inSearch: true, query: "or" }))).toEqual({ t: "clearQuery" });
    expect(keyCommand(key("Escape"), ctx())).toEqual({ t: "close" });
  });
  test("arrows move, Space ticks, Enter opens, Ctrl+Enter opens the ticked", () => {
    expect(keyCommand(key("ArrowDown"), ctx())).toEqual({ t: "move", by: 1 });
    expect(keyCommand(key(" "), ctx())).toEqual({ t: "tick" });
    expect(keyCommand(key("Enter"), ctx())).toEqual({ t: "open" });
    expect(keyCommand(key("Enter", { ctrlKey: true }), ctx())).toEqual({ t: "openTicked" });
  });
  test("Space is a character in a search that has text", () => {
    expect(keyCommand(key(" "), ctx({ inField: true, inSearch: true, query: "or" }))).toBeNull();
    expect(keyCommand(key(" "), ctx({ inField: true, inSearch: true }))).toEqual({ t: "tick" });
  });
  test("/ focuses the search, but not while typing in a field", () => {
    expect(keyCommand(key("/"), ctx())).toEqual({ t: "focusSearch" });
    expect(keyCommand(key("/"), ctx({ inField: true }))).toBeNull();
  });
  test("the highlight stays in range and Enter opens the highlighted row else the ticked", () => {
    const roots = ["/a", "/b", "/c"];
    expect(moveHot(roots, null, 1)).toBe("/a");
    expect(moveHot(roots, "/c", 1)).toBe("/c");
    expect(moveHot(roots, "/b", "last")).toBe("/c");
    expect(moveHot([], null, 1)).toBeNull();
    expect(enterTargets("/a", ["/b"])).toEqual(["/a"]);
    expect(enterTargets(null, ["/b"])).toEqual(["/b"]);
    expect(navRoots(flatten(buildGroups(view())))).toHaveLength(3);
  });
  test("every keydown goes through the one map, at the window", () => {
    expect(MODAL).toContain("keyCommand(");
    expect(MODAL).toMatch(/addEventListener\("keydown", [a-zA-Z]+, true\)/);
  });
});

describe("D19 closing is quick", () => {
  test("the exit lasts a fraction of a second", () => {
    const d = [...MODAL.matchAll(/transition=\{\{ duration: ([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(d.length).toBeGreaterThan(0);
    for (const s of d) expect(s).toBeLessThanOrEqual(0.2);
  });
});

describe("paths the modal prints", () => {
  test("the home folder is written as ~", () => {
    expect(tildify("/home/dev/code")).toMatch(/^(~|\/home)/);
  });
});

// Phase 2: the three gaps a mockup frame showed (frames 8 and 14, and the top-bar chip).
const GH = strip(await Bun.file(new URL("../src/components/RemoteRepoPage.tsx", import.meta.url)).text());
const TOPBAR = strip(await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text());

describe("frame 8 the GitHub pane draws one card per answer", () => {
  test("found, not found with close matches, no access, offline, already listed", () => {
    for (const w of ["Read-only", "nothing is cloned", "Not found: ", "Use this", "Your sign-in cannot read", "Re-run sign-in", "You appear to be offline", "Change URL", "Already on your list", "Show it in the list"]) expect(GH).toContain(w);
    expect(GH).toContain("<StateCard");
    expect(GH).toContain("<PaneHead");
  });
  test("Add repo is off with a reason on its tooltip for every card but found", () => {
    for (const c of ["not-found", "no-access", "unreachable", "already", "checking", "empty"] as const) expect(addReason(c)).not.toBe("");
    expect(addReason("found")).toBe("");
    expect(GH).toContain("<Why reason={addReason(card)}>");
  });
  test("close matches come from the list, near names only", () => {
    const list = ["acme/widget", "acme/widget-pipeline", "acme-labs/widgit", "orbit/api"].map((r) => ({ repo: r, addedAt: 1, lastSeen: 1 }));
    const near = closeMatches("acme/widgit", list);
    expect(near).toContain("acme/widget");
    expect(near).not.toContain("orbit/api");
  });
  test("the modal wires Show it in the list", () => {
    expect(MODAL).toContain("onShow={");
  });
});

describe("frame 14 the machine view has a Not on your list group with Add all", () => {
  test("repos under no folder are grouped under that name", () => {
    const g = buildGroups(view({ repos: [repo("/w/code/orbit"), repo("/tmp/scratch-notes"), repo("/dotfile/dotfiles")] }));
    const out = g.find((x) => x.kind === "elsewhere")!;
    expect(out.title).toBe(NOT_LISTED);
    expect(out.items.length).toBe(2);
  });
  test("its header offers Add all N and the modal adds every root", () => {
    expect(ROWS).toContain("Add all {g.items.length}");
    expect(LIST).toContain('it.g.kind === "elsewhere"');
    expect(MODAL).toContain("onAddAll={(paths) => void addMany(paths)}");
  });
});

describe("the top-bar chip's accessible name carries no path", () => {
  test("names only, and the button uses it", () => {
    const n = scopeAria(["/home/dev/code/acme/web", "/home/dev/code/orbit/api"], "/home/dev/code/acme/web");
    expect(n).toBe("Open project web, api. Switch project");
    expect(n).not.toContain("/");
    expect(TOPBAR).toContain("aria-label={scopeAria(open, workspace)}");
  });
});

describe("fidelity pass: parts the frames show", () => {
  test("the dialog header carries the git mark tile", async () => {
    expect(await src("ProjectsModal.tsx")).toContain('<Tile size={36} hue="primary"><BranchIcon size={ICON.md} /></Tile>');
  });
  test("a group that matches nothing is its header alone, no second row", async () => {
    expect(await src("ProjectList.tsx")).not.toContain("NoneRow");
    expect(strip(await Bun.file(new URL("../src/lib/projectsView.ts", import.meta.url)).text())).not.toContain('t: "none"');
  });
  test("a folder group is titled by its tilded path", async () => {
    expect(await src("Rows.tsx")).toContain("g.full ? railLabel(g.full, 28) : g.title");
  });
  test("the first run offers GitHub and has a footer with a disabled Open", async () => {
    const side = await src("SidePanes.tsx");
    expect(side).toContain("onClick={onGithub}");
    expect(side).toContain("0 ticked");
    expect(await src("ProjectsModal.tsx")).toContain("onGithub=");
  });
  test("the scope control is hidden until there is a folder to scope to", async () => {
    expect(await src("Rail.tsx")).toContain("{canFolders && (<div");
  });
  test("the verdict colour survives keyboard focus", async () => {
    expect(await src("FolderField.tsx")).toContain('"--primary": HUE[tone]');
    expect(GH).toContain('"--primary": hueOf(field)');
  });
  test("N adds, Del forgets, [ ] walk the sources, and none of them fire in a field", () => {
    expect(keyCommand(key("n"), ctx({}))).toEqual({ t: "add" });
    expect(keyCommand(key("Delete"), ctx({}))).toEqual({ t: "forget" });
    expect(keyCommand(key("]"), ctx({}))).toEqual({ t: "source", by: 1 });
    expect(keyCommand(key("["), ctx({}))).toEqual({ t: "source", by: -1 });
    for (const k of ["n", "Delete", "]"]) expect(keyCommand(key(k), ctx({ inField: true }))).toBeNull();
  });
  test("whole machine reads the disk, which is what fills Not on your list", async () => {
    const hook = await src("useProjectsModal.ts");
    expect(hook).toContain("const wide = o.known && !workspaces.length;");
    expect(hook).toContain("(scan = wide)");
  });
  test("a partial failure states its totals", async () => {
    expect(await src("ResultPane.tsx")).toContain(">Result</b>");
  });
  test("the undo toast counts its seconds down", async () => {
    expect(await src("SidePanes.tsx")).toContain("{left} s");
  });
});

describe("fidelity pass 2: tabs, session counts, names that never clip", () => {
  test("tabsByRoot counts one window once per project, by pane path or agent cwd", () => {
    const panes = [
      { windowId: "@1", path: "/w/orbit/api" }, { windowId: "@1", path: "/w/orbit/api/src" },
      { windowId: "@2", path: "/elsewhere", agentCwds: ["/w/orbit/api"] }, { windowId: "@3", path: "/w/orbit/apiary" },
    ];
    expect(tabsByRoot(panes, ["/w/orbit/api", "/w/orbit/apiary", "/w/none"])).toEqual({ "/w/orbit/api": 2, "/w/orbit/apiary": 1 });
  });
  test("sessionsByRoot counts by checkout else root, not by name prefix", () => {
    const rows = [{ project_path: "/w/orbit/api" }, { cwd_path: "/w/orbit/api/wt" }, { project_path: "/w/orbit/apiary" }];
    expect(sessionsByRoot(rows, ["/w/orbit/api"])).toEqual({ "/w/orbit/api": 2 });
  });
  test("nameSplit keeps the end of a long name", () => {
    const n = "this-is-an-extremely-long-project-name-orbit-billing-v2";
    expect(nameSplit(n).tail.endsWith("billing-v2")).toBe(true);
    expect(nameSplit("short").head).toBe("");
  });
  test("the column, the chip, the middle-cut name and the long group path are wired", async () => {
    const rows = await src("Rows.tsx");
    expect(rows).toContain('<span className="text-center">Tabs</span>');
    expect(rows).toContain("tabs > 0 && <Status hue=\"info\"");
    expect(rows).toContain("nameSplit(r.name)");
    expect(rows).toContain("tildify(g.full).length > 28");
    expect(await src("useProjectsModal.ts")).toContain("api.agentPanes()");
    expect(await src("AgentsPane.tsx")).toContain("sessionsByRoot(");
    expect(await src("CreatePane.tsx")).toContain("shortcut: no percentage");
  });
});

describe("open workspaces the repo list lacks", () => {
  const repo = (root: string): GitRepoRef => ({ root, name: root.split("/").pop()!, branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt: 1 });
  const listed = [repo("/acme/orbit")];
  const ws = ["/acme/orbit", "/acme/notes"];
  test("each gets a row under Open now, and a tick only for a row", () => {
    const all = withOpenFolders(listed, ws);
    expect(initialTicks(ws, all).length).toBe(2);
    const g = buildGroups({ repos: all as GitRepoRef[], folders: [], workspaces: ws, hidden: [], showHidden: false, query: "", source: SOURCE_ALL });
    expect(g[0]!.kind).toBe("open");
    expect(g[0]!.items.map((r) => r.root).sort()).toEqual(["/acme/notes", "/acme/orbit"]);
    expect(railCounts(all as GitRepoRef[], [], ws, []).open).toBe(2);
  });
  test("nothing extra when every open path is listed", () => {
    expect(withOpenFolders(listed, ["/acme/orbit"])).toEqual(listed);
  });
});

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const rail = await Bun.file(new URL("../src/components/projects/Rail.tsx", import.meta.url)).text();
describe("an open project that is also forgotten", () => {
  const repo = (root: string): GitRepoRef => ({ root, name: root.split("/").pop()!, branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt: 1 });
  const repos = [repo("/acme/orbit"), repo("/acme/notes"), repo("/acme/old")];
  const ws = ["/acme/orbit", "/acme/notes"], hidden = ["/acme/notes", "/acme/old"];
  test("lists under Open now, counts, and only closed ones are forgotten", () => {
    const g = buildGroups({ repos, folders: [], workspaces: ws, hidden, showHidden: false, query: "", source: SOURCE_ALL });
    expect(g[0]!.items.map((r) => r.root).sort()).toEqual(["/acme/notes", "/acme/orbit"]);
    expect(railCounts(repos, [], ws, hidden)).toMatchObject({ all: 2 + 0, open: 2, hidden: 1 });
  });
  test("every tick has a visible row", () => {
    const g = buildGroups({ repos, folders: [], workspaces: ws, hidden, showHidden: false, query: "", source: SOURCE_ALL });
    const shown = new Set(g.flatMap((x) => x.items.map((r) => r.root)));
    expect(initialTicks(ws, repos).every((t) => shown.has(t))).toBe(true);
  });
});

describe("the rail's scope track is one row", () => {
  test("a nowrap, equal-halves modifier, used by the rail only", () => {
    expect(css).toMatch(/\.agx-seg-rail \.agx-seg \{[^}]*flex-wrap: nowrap/);
    expect(rail).toContain("agx-seg-rail");
  });
});

// Submodules, Worktrees, Stashes and Tidy: the decisions (pure), the frames drawn, and the wiring read from source.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitDock } from "../src/components/GitDock.tsx";
import { SubmoduleInspector, NoSubmodulesFrame } from "../src/components/git/SubmodulesFrames.tsx";
import { WorktreeInspector } from "../src/components/git/WorktreesFrames.tsx";
import { StashInspector, NoStashesFrame, stashOverlap } from "../src/components/git/StashesFrames.tsx";
import { TidyView } from "../src/components/git/TidyFrames.tsx";
import { dockActionsFor, toolbarFor } from "../src/lib/gitDock.ts";
import { DOCK_TABS } from "../src/lib/gitDock.ts";
import {
  forceRemoveAsk, putBackAsk, refusedForSubmodule, stashClashes, stashSelection, tidySegments, unmergedPaths, worktreeSelection,
} from "../src/lib/gitG4.ts";
import type { GitWorktree, TidyReport } from "../../shared/types.ts";

const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = code(panel);
const draw = (el: React.ReactElement) => renderToStaticMarkup(el);
const fn = (name: string) => { const at = src.indexOf(`const ${name} = `); expect(at).toBeGreaterThan(0); return src.slice(at, src.indexOf("\n  };\n", at)); };

const wt = (o: Partial<GitWorktree> = {}): GitWorktree => ({ path: "/code/orbit-review", branch: "review/pr-1042", head: "a81e04c", current: false, bare: false, locked: false, ...o });

describe("G4 decisions", () => {
  test("a stash clashes only while unmerged paths exist, and only the applied one once the panel knows it", () => {
    expect(stashClashes(0, "aaa", undefined)).toBe(false);
    expect(stashClashes(2, "aaa", undefined)).toBe(true);
    expect(stashClashes(2, "aaa", "bbb")).toBe(false);
    expect(stashClashes(2, "bbb", "bbb")).toBe(true);
    expect(stashSelection({ index: 0, ref: "stash@{0}", message: "x", hash: "aaa" }, true).stashClash).toBe(true);
    expect(stashSelection(undefined, true).count).toBe(0);
  });
  test("unmerged paths come from the tree, relative to the repo, once each", () => {
    const ch = [
      { file_path: "/r/src/a.ts", status: "unmerged" }, { file_path: "/r/src/a.ts", status: "unmerged" },
      { file_path: "/r/b.ts", status: "modified" },
    ];
    expect(unmergedPaths(ch, "/r")).toEqual(["src/a.ts"]);
  });
  test("a submodule refusal is recognised, a dirty-tree refusal is not", () => {
    expect(refusedForSubmodule("fatal: working trees containing submodules cannot be moved or removed")).toBe(true);
    expect(refusedForSubmodule("fatal: contains modified or untracked files")).toBe(false);
    expect(refusedForSubmodule(undefined)).toBe(false);
  });
  test("worktree selection carries lock, busy and the refusal; Remove anyway only after it", () => {
    const refused = new Set(["/code/orbit-review"]);
    const sel = worktreeSelection(wt({ locked: true, busy: true }), refused);
    expect(sel).toMatchObject({ worktreeLocked: true, busy: true, worktreeSubmoduleRefused: true });
    const ids = (s: ReturnType<typeof worktreeSelection>) => dockActionsFor("worktrees", s).actions.map((a) => a.id);
    expect(ids(worktreeSelection(wt(), new Set()))).not.toContain("worktree-force-remove");
    expect(ids(worktreeSelection(wt(), refused))).toContain("worktree-force-remove");
    expect(ids(worktreeSelection(wt(), refused))).not.toContain("remove");
  });
  test("Remove is shut while a process is inside, with the reason", () => {
    const d = dockActionsFor("worktrees", worktreeSelection(wt({ busy: true, pid: 48211 }), new Set()));
    const r = d.actions.find((a) => a.id === "remove")!;
    expect(r.disabled).toBe(true);
    expect(r.reason).toBe("A process is running in it");
  });
  test("the force ask says what force drops; put-back names every file", () => {
    expect(forceRemoveAsk("orbit-review").body).toMatch(/uncommitted change/);
    const a = putBackAsk(["a.ts", "b.ts"]);
    expect(a.body).toContain("a.ts\nb.ts");
  });
  test("tidy bar: one segment per finding that has something, widths sum to 100", () => {
    const segs = tidySegments([
      { id: "merged", title: "Branches", items: ["a", "b", "c"], extra: 6 },
      { id: "gone", title: "Gone", items: [], extra: 0 },
      { id: "stashes", title: "Stashes", items: ["s"], extra: 0 },
    ]);
    expect(segs.map((g) => g.id)).toEqual(["merged", "stashes"]);
    expect(segs.reduce((n, g) => n + g.pct, 0)).toBeCloseTo(100);
  });
  test("every DockTab still has a dock after the new tabs are wired", () => {
    for (const t of DOCK_TABS) expect(() => dockActionsFor(t, { count: 0 })).not.toThrow();
  });
  test("the submodules doors are Add and Open .gitmodules", () => {
    expect(toolbarFor("submodules").map((a) => a.id)).toEqual(["submodule-add", "submodule-open-gitmodules"]);
  });
});

describe("G4 frames, tabs 2", () => {
  test("submodule inspector says what the status means; nothing picked asks for a pick", () => {
    const sub = { name: "ui-kit", path: "vendor/ui-kit", url: "https://example.com/acme/ui-kit.git", sha: "4be21d0aaaa", status: "uninitialized" as const };
    expect(draw(React.createElement(SubmoduleInspector, { sub }))).toContain("empty until it is updated");
    expect(draw(React.createElement(SubmoduleInspector, {}))).toContain("Pick a submodule");
    expect(draw(React.createElement(NoSubmodulesFrame))).toContain("No submodules");
  });
  test("the pid is drawn only when the row has one", () => {
    expect(draw(React.createElement(WorktreeInspector, { wt: wt({ busy: true, pid: 48211 }) }))).toContain("pid 48211");
    const quiet = draw(React.createElement(WorktreeInspector, { wt: wt() }));
    expect(quiet).not.toContain("pid");
    expect(quiet).not.toContain("Something is running");
    expect(draw(React.createElement(WorktreeInspector, { wt: wt({ busy: true }) }))).not.toContain("(pid");
  });
  test("stash inspector lists files, warns on overlap and on a clash", () => {
    const stash = { index: 0, ref: "stash@{0}", message: "On main: wip totals", hash: "aaa" };
    const files = [{ status: "M", path: "src/totals.ts" }, { status: "A", path: "test/totals.test.ts" }];
    const base = { stash, files, onRetry: () => {} };
    const calm = draw(React.createElement(StashInspector, { ...base, overlap: [], clashPaths: [] }));
    expect(calm).toContain("src/totals.ts");
    expect(calm).toContain("made on main");
    expect(calm).not.toContain("also changed");
    expect(draw(React.createElement(StashInspector, { ...base, overlap: ["src/totals.ts"], clashPaths: [] }))).toContain("also changed in your tree");
    expect(draw(React.createElement(StashInspector, { ...base, overlap: [], clashPaths: ["src/totals.ts"] }))).toContain("stopped on");
    expect(draw(React.createElement(StashInspector, { ...base, files: "failed", overlap: [], clashPaths: [] }))).toContain("Try again");
    expect(stashOverlap(files, new Set(["src/totals.ts"]))).toEqual(["src/totals.ts"]);
  });
  test("the stash dock offers Resolve and Put my tree back only on a clash, and shuts Apply until then", () => {
    const names = (clash: boolean) => dockActionsFor("stashes", { count: 1, name: "stash@{0}", stashClash: clash }).actions;
    expect(names(false).map((a) => a.id)).not.toContain("stash-resolve");
    expect(names(true).map((a) => a.id)).toContain("stash-put-back");
    expect(names(true).find((a) => a.id === "apply")?.reason).toBe("Resolve the conflict first");
    const html = draw(React.createElement(GitDock, { ...dockActionsFor("stashes", { count: 1, name: "stash@{0}", stashClash: true }), onRun: () => {}, selection: "stash@{0}" }));
    expect(html).toContain('data-dock="stash-resolve"');
    expect(draw(React.createElement(NoStashesFrame))).toContain("No stashes");
  });
  test("tidy: summary bar, Check again, and Open Stashes where there is no command", () => {
    const report: TidyReport = {
      root: "/r", base: "main",
      findings: [
        { id: "merged", title: "Branches already in main", what: "w", items: ["feat/a"], extra: 0, command: "git branch -d feat/a", blocked: [], why: "", effect: "", risk: "", diagram: [] },
        { id: "stashes", title: "Stashes", what: "w", items: ["stash@{0}"], extra: 0, command: null, blocked: [], why: "", effect: "", risk: "", diagram: [] },
      ],
    };
    const html = draw(React.createElement(TidyView, { report, root: "/r", busy: false, onRefresh: () => {}, onOpenStashes: () => {} }));
    expect(html).toContain("2 things have piled up");
    expect(html).toContain("Check again");
    expect(html).toContain("Clean up");
    expect(html).toContain("Open Stashes");
    const failed = draw(React.createElement(TidyView, { report: { ...report, findings: [], error: "fatal: not a git repository" }, root: "/r", busy: false, onRefresh: () => {}, onOpenStashes: () => {} }));
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("fatal:");
  });
});

describe("G4 wiring, tabs 2", () => {
  test("each tab mounts one dock, fed by dockActionsFor", () => {
    for (const t of ["submodules", "worktrees", "stashes"]) expect(src).toContain(`dockActionsFor("${t}"`);
    for (const d of ["submodulesDock", "worktreesDock", "stashesDock"]) expect(src).toContain(`{...${d}}`);
  });
  test("every new catalogue id has a handler", () => {
    const sm = src.slice(src.indexOf("const submoduleAction = "), src.indexOf("const worktreeAction = "));
    for (const id of ["update", "submodule-sync", "submodule-deinit", "submodule-remove", "copy-path"]) expect(sm).toContain(`case "${id}"`);
    expect(fn("submoduleToolbarRun")).toContain("submodule-open-gitmodules");
    expect(fn("submoduleToolbarRun")).toContain(".gitmodules");
    const w = src.slice(src.indexOf("const worktreeAction = "), src.indexOf("const tagAction = "));
    for (const id of ["open", "copy-path", "remove", "worktree-unlock", "worktree-force-remove"]) expect(w).toContain(`case "${id}"`);
    const st = src.slice(src.indexOf("const stashAction = "), src.indexOf("const stashPartialNow"));
    for (const id of ["stash-resolve", "stash-put-back", "stash-files"]) expect(st).toContain(`case "${id}"`);
  });
  test("the destructive submodule and stash moves ask once, before they act", () => {
    for (const [name, call] of [["submoduleDeinitAsk", "gitSubmoduleDeinit"], ["submoduleRemoveAsk", "gitSubmoduleRemove"], ["forceRemoveWorktree", "gitWorktreeRemove"], ["stashPutBack", "gitStashPutBack"]] as const) {
      const b = fn(name);
      expect(b.match(/await ask\(/g)?.length).toBe(1);
      expect(b.indexOf("await ask(")).toBeLessThan(b.indexOf(call));
    }
    expect(fn("submoduleDeinitAsk")).toContain("danger: true");
  });
  test("a submodule refusal opens no force ask of its own: it records the refusal for the dock", () => {
    const b = fn("removeWorktree");
    expect(b).toContain("setWtRefused");
    expect(b).not.toContain("Force remove");
    expect(fn("forceRemoveWorktree")).toContain("forceRemoveAsk(");
  });
  test("Resolve opens the block resolver the merge uses; Put my tree back calls the reset --merge route after one ask naming the files", () => {
    expect(fn("stashResolve")).toContain("openBlocks(");
    expect(fn("stashPutBack")).toContain("api.gitStashPutBack(");
    expect(fn("stashPutBack")).not.toContain("gitResolve");
    expect(fn("stashPutBack")).toContain("putBackAsk(unmerged)");
  });
  test("every new list failure has Try again; Tidy has no dock", () => {
    expect(src).toContain('title="Stashes could not be listed"');
    expect(src).toContain('title="Submodules could not be listed"');
    expect(src).toContain('title="Worktrees could not be listed"');
    expect(src).toContain('title="Tidy could not look"');
    const at = src.indexOf("<TidyView ");
    expect(src.slice(at, at + 400)).not.toContain("<GitDock");
  });
});

describe("submodule add refuses blank fields before it posts", () => {
  test("blank url or path gets a sentence, filled ones pass", async () => {
    const { submoduleAddRefusal } = await import("../src/lib/gitActions.ts");
    expect(submoduleAddRefusal("")).toBe("Type the clone URL first.");
    expect(submoduleAddRefusal("  ")).toBe("Type the clone URL first.");
    expect(submoduleAddRefusal("https://git.orbit.test/lib.git", " ")).toBe("Type where the submodule should live first.");
    expect(submoduleAddRefusal("https://git.orbit.test/lib.git", "vendor/lib")).toBeUndefined();
    expect(submoduleAddRefusal("https://git.orbit.test/lib.git")).toBeUndefined();
  });
  test("the handler consults it before api.gitSubmoduleAdd", async () => {
    const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
    const at = src.indexOf("const submoduleAddAsk = async (");
    const body = src.slice(at, src.indexOf("const submoduleOp = ", at));
    expect(body.indexOf("submoduleAddRefusal(url, path)")).toBeGreaterThan(-1);
    expect(body.indexOf("submoduleAddRefusal(url, path)")).toBeLessThan(body.indexOf("api.gitSubmoduleAdd"));
  });
});

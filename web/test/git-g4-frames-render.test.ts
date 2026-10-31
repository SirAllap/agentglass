// The G4 frames drawn, and the panel's wiring for the three tabs read from source.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitDock } from "../src/components/GitDock.tsx";
import { BranchInspector, NameList, OnlyBranchFrame } from "../src/components/git/BranchesFrames.tsx";
import { NoRemoteFrame, RemoteBranchInspector } from "../src/components/git/RemotesFrames.tsx";
import { NoTagsFrame, TagForm, TagInspector } from "../src/components/git/TagsFrames.tsx";
import { ErrorFrame } from "../src/components/git/HistoryFrames.tsx";
import { dockActionsFor } from "../src/lib/gitDock.ts";

const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const draw = (el: React.ReactElement) => renderToStaticMarkup(el);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("G4 frames", () => {
  test("every error frame carries Try again and the plain sentence only", () => {
    const html = draw(React.createElement(ErrorFrame, { title: "Tags could not be listed", sentence: "Could not reach origin.", onRetry: () => {} }));
    expect(html).toContain("Try again");
    expect(html).toContain("Could not reach origin.");
    expect(html).not.toContain("fatal:");
  });
  test("the bulk-delete list names every branch, one per line, and groups the held ones", () => {
    const html = draw(React.createElement(NameList, { can: Array.from({ length: 10 }, (_, i) => `feat/x-${i}`), cannot: ["main"] }));
    expect((html.match(/<li /g) ?? []).length).toBe(11);
    expect(html).toContain("Cannot delete (1)");
    expect(html).not.toMatch(/and \d+ more/);
  });
  test("a tag dock draws Delete… as one button with a menu", () => {
    const d = dockActionsFor("tags", { count: 1, name: "v1.2.0", tagOnOrigin: "yes" });
    const html = draw(React.createElement(GitDock, { ...d, onRun: () => {}, selection: "v1.2.0" }));
    expect(html).toContain('data-dock="delete-menu"');
    expect(html).not.toContain('data-dock="delete-remote"');
  });
  test("the tag form says lightweight until a message is typed, and shuts Create on an empty name", () => {
    const html = draw(React.createElement(TagForm, { head: "main", existing: [], busy: false, onCreate: () => {}, onCancel: () => {} }));
    expect(html).toContain("lightweight");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Create/);
  });
  test("empty frames say the mockup's sentences", () => {
    expect(draw(React.createElement(NoTagsFrame))).toContain("No tags yet");
    expect(draw(React.createElement(NoRemoteFrame, { copy: () => {} }))).toContain("This repository has no remote");
    expect(draw(React.createElement(OnlyBranchFrame, { name: "main" }))).toContain("is the only branch");
  });
  test("inspectors ask for a pick when nothing is picked, and show a tag's origin when known", () => {
    expect(draw(React.createElement(BranchInspector, { track: { ahead: 0, behind: 0, gone: false }, root: "/r", isCurrent: false }))).toContain("Pick a branch");
    expect(draw(React.createElement(RemoteBranchInspector, { remote: "origin", root: "/r" }))).toContain("Pick a remote branch");
    const tag = { name: "v1.2.0", subject: "Release", date: "1 d ago", hash: "77e3b10", annotated: true };
    expect(draw(React.createElement(TagInspector, { tag, origin: { name: "v1.2.0", onOrigin: "yes", remote: "origin" } }))).toContain("on origin");
  });
});

describe("GitPanel wiring for Branches, Remotes and Tags", () => {
  const src = code(panel);
  test("each tab mounts one dock, fed by dockActionsFor", () => {
    for (const t of ["branches", "remotes", "tags"]) expect(src).toContain(`dockActionsFor("${t}"`);
    for (const d of ["branchesDock", "remotesDock", "tagsDock"]) expect(src).toContain(`{...${d}}`);
  });
  test("the two tag prompts are gone: the form replaces them", () => {
    expect(src).not.toContain("askTag");
    expect(src).not.toContain("createTagAsk");
    expect(src).toContain("<TagForm");
  });
  test("tag origins are only asked when a remote exists", () => {
    const at = src.indexOf("api.gitRemotes(root)\n      .then((r) => (r.remotes.length ? api.gitTagsOrigin");
    expect(at).toBeGreaterThan(0);
  });
  test("every G4 list failure has Try again and logs the raw text", () => {
    expect((src.match(/<ErrorFrame /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('console.warn("git view failed:", e)');
  });
  test("Remove & delete goes through the rescue modal and a held branch asks nothing before it", () => {
    const at = src.indexOf("const removeAndDelete = async (");
    const body = src.slice(at, src.indexOf("\n  };\n", at));
    expect(body).toContain("rescueThenRemoveWorktrees([b]");
    expect(body.indexOf("rescueThenRemoveWorktrees")).toBeLessThan(body.indexOf("gitBranchDelete"));
    expect(body).not.toContain("await ask({ title: `${b.name} is checked out");
  });
});

/*
 * The Log and the Reflog act through one dock under the list, and a row carries
 * no button of its own. The dock is drawn here; the panel's wiring is asserted
 * against its source, because there is no renderer for the whole panel.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitDock } from "../src/components/GitDock.tsx";
import { CleanFrame } from "../src/components/git/HistoryFrames.tsx";
import { commitRows, List } from "../src/components/git/Lists.tsx";
import { dockActionsFor, hunkActionsFor } from "../src/lib/gitDock.ts";
import { actionsFor } from "../src/lib/gitActions.ts";
import { commitEffect } from "../src/lib/commitActions.ts";

const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const dockSrc = await Bun.file(new URL("../src/components/GitDock.tsx", import.meta.url)).text();
const lists = await Bun.file(new URL("../src/components/git/Lists.tsx", import.meta.url)).text();

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** From `start` to the first `end` after it, comments stripped. */
function between(text: string, start: string, end: string): string {
  const at = text.indexOf(start);
  expect(at).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, at + start.length);
  expect(to).toBeGreaterThan(at);
  return code(text.slice(at, to));
}
/** A function's own body: its signature (with the paren) to its closing brace on a line of its own. */
function fn(text: string, signature: string): string {
  const at = text.indexOf(signature);
  expect(at).toBeGreaterThanOrEqual(0);
  const to = text.indexOf("\n}\n", at);
  expect(to).toBeGreaterThan(at);
  return code(text.slice(at, to + 2));
}

const LOG = between(panel, 'view === "log" ? (', ') : view === "branches" ?');
const REFLOG = between(panel, 'view === "reflog" ? (', 'newWtBranch');
const CHANGES = between(panel, 'view === "changes" ? (', ') : view === "log" ? (');
const FILEROW = fn(panel, "function FileRow(");

const dock = (tab: "log" | "reflog", count: number, repo = { branch: "main" }) =>
  renderToStaticMarkup(React.createElement(GitDock, { ...dockActionsFor(tab, { count }, repo), onRun: () => {}, selection: "5d0b7e2" }));

describe("the dock, drawn", () => {
  test("every Log action is a button, and the target branch is a chip inside its label", () => {
    const html = dock("log", 1);
    for (const a of dockActionsFor("log", { count: 1 }, { branch: "main" }).actions) expect(html).toContain(`data-dock="${a.id}"`);
    expect(html).toContain("Cherry-pick onto");
    expect(html).toMatch(/<span class="shrink-0[^>]*title="main"[^>]*>main<\/span>/);
  });
  test("a shut button says why on hover and stays in place", () => {
    const html = dock("log", 0);
    expect(html).toContain('title="Pick one first"');
    expect(html).toContain('data-dock="show"');
  });
  test("the dirty-tree reason reaches Cherry-pick and Revert", () => {
    const html = dock("log", 1, { branch: "main", dirty: true } as never);
    expect(html.match(/title="Commit or stash your changes first"/g)?.length).toBe(2);
  });
  test("More is a menu button", () => {
    expect(dock("log", 1)).toContain('data-dock="more"');
    expect(dock("reflog", 1)).toContain('data-dock="more"');
  });
  test("a danger action is drawn as danger", () => {
    expect(dock("log", 1)).toMatch(/data-tone="danger"[^>]*data-dock="revert"|data-dock="revert"[^>]*data-tone="danger"/);
  });
});

describe("a row carries no button of its own in the Log and the Reflog", () => {
  const rows = commitRows(
    [{ hash: "aaa1111", parents: [], subject: "one", graph: "" }],
    { picked: new Set(), run: () => {} },
  );
  const draw = (inspector?: (i: number) => React.ReactNode) => renderToStaticMarkup(
    React.createElement(List, { rows, cursor: 0, onCursor: () => {}, onMenu: () => {}, what: "commits", inspector }),
  );
  test("with an inspector the hover action and the right-hand list are gone", () => {
    const html = draw(() => React.createElement("aside", { id: "insp" }));
    expect(html).toContain('id="insp"');
    expect(html).not.toContain("group-hover:opacity-100");
  });
  test("List only draws the primary action when there is no inspector", () => {
    expect(code(fn(lists, "export function List("))).toContain("disabled || inspector ? null : primaryAction(");
  });
  test("pick badges number oldest first, as the commits are applied", () => {
    const rows = commitRows(
      [
        { hash: "new", parents: ["old"], subject: "newer", graph: "" },
        { hash: "old", parents: [], subject: "older", graph: "" },
      ],
      { picked: new Set(["new", "old"]), numbers: new Map([["old", 1], ["new", 2]]), run: () => {} },
    );
    expect(rows.map((r) => r.pickMark)).toEqual([2, 1]);
  });
});

describe("the panel wires both tabs to the dock", () => {
  for (const [name, src] of [["Log", LOG], ["Reflog", REFLOG]] as const) {
    test(`${name} renders its actions through GitDock and passes an inspector`, () => {
      expect(src).toContain("<GitDock");
      expect(src).toContain("inspector={");
    });
    test(`${name} has no row-level action button`, () => {
      expect(src).not.toContain("RowAction");
      expect(src).not.toContain("primaryAction");
    });
  }
  test("the Log keeps its row menu", () => {
    expect(LOG).toContain("setRowMenu(");
    expect(REFLOG).toContain("setRowMenu(");
  });
  test("Reflog off offers the enable route and then reads the list again", () => {
    expect(REFLOG).toContain("api.gitReflogEnable(root)");
    expect(REFLOG).toContain("Turn it on for this repository");
    expect(REFLOG).toContain("loadView()");
  });
  test("every failed frame has Try again, and an empty Log goes to Changes", () => {
    expect(LOG).toContain("<ErrorBox ");
    expect(LOG).toContain("onRetry={() => void loadView()}");
    expect(REFLOG).toContain("retryButton(");
    expect(LOG).toContain('setView("changes")');
  });
  test("the dock itself never asks: Revert and Reset each ask once, inside their own handler", () => {
    const run = code(panel.slice(panel.indexOf("const dockRun = async ("), panel.indexOf("\n  };\n", panel.indexOf("const dockRun = async ("))));
    expect(run).toContain('resetTo(hash, "hard")');
    expect(run).not.toContain('resetTo(hash, "hard", true)');
    expect(run).not.toMatch(/\bask\(/);
    for (const h of ["const revertOne = async (", "const resetTo = async ("]) {
      const at = panel.indexOf(h);
      expect(code(panel.slice(at, panel.indexOf("\n  };\n", at))).match(/\bask\(/g)?.length).toBe(1);
    }
  });
});

describe("every dock action is one the catalogue offers and the panel can run", () => {
  const catalogue = {
    log: actionsFor("commit", "abc1234", { inLog: true }).map((a) => a.id),
    reflog: actionsFor("commit", "abc1234", {}).map((a) => a.id),
  };
  for (const tab of ["log", "reflog"] as const) {
    test(`${tab}: each id is in the commit catalogue and has an effect`, () => {
      const d = dockActionsFor(tab, { count: 1 }, { branch: "main" });
      for (const a of [...d.actions, ...d.more]) {
        expect([a.id, catalogue[tab].includes(a.id)]).toEqual([a.id, true]);
        expect([a.id, commitEffect(a.id) !== null]).toEqual([a.id, true]);
      }
    });
  }
});

describe("the Changes tab acts through the same dock", () => {
  const changesDock = (sel: Parameters<typeof dockActionsFor>[1]) =>
    renderToStaticMarkup(React.createElement(GitDock, { ...dockActionsFor("changes", sel), onRun: () => {}, selection: "src/a.ts" }));
  test("an unstaged file offers Stage and Discard, never Unstage", () => {
    const html = changesDock({ count: 1, staged: false });
    expect(html).toContain('data-dock="stage"');
    expect(html).toContain('data-dock="discard"');
    expect(html).not.toContain('data-dock="unstage"');
  });
  test("a staged file offers Unstage and no Discard, never Stage", () => {
    const html = changesDock({ count: 1, staged: true });
    expect(html).toContain('data-dock="unstage"');
    expect(html).not.toContain('data-dock="discard"');
    expect(html).not.toContain('data-dock="stage"');
  });
  test("nothing picked shuts every button with Pick a file first", () => {
    expect(changesDock({ count: 0 }).match(/title="Pick a file first"/g)?.length).toBe(4);
  });
  test("an untracked file's Discard says delete <path>", () => {
    expect(changesDock({ count: 1, untracked: true, path: "notes.md" })).toContain('title="delete notes.md"');
  });
  test("the panel renders the Changes actions through GitDock and the row has no button", () => {
    expect(CHANGES).toContain("<GitDock");
    expect(FILEROW).not.toContain("<button");
    expect(FILEROW).not.toContain("onAction");
    expect(FILEROW).not.toContain("group-hover");
  });
  test("a failed read offers Try again", () => {
    expect(CHANGES).toContain("retryButton(");
  });
  test("hunk buttons come from hunkActionsFor, and Discard hunk is only for an unstaged file", () => {
    expect(code(panel)).toContain("hunkActionsFor(selected.staged)");
    expect(hunkActionsFor(true).map((a) => a.id)).toEqual(["unstage-hunk"]);
    expect(hunkActionsFor(false).map((a) => a.id)).toEqual(["stage-hunk", "discard-hunk"]);
  });
  test("each Changes dock action id is one the catalogue offers and fileAction handles", () => {
    const at = panel.indexOf("const fileAction = (");
    const run = code(panel.slice(at, panel.indexOf("\n  };\n", at)));
    for (const staged of [false, true]) {
      const d = dockActionsFor("changes", { count: 1, staged }, {});
      const cat = actionsFor("file", "a.ts", { merged: staged }).map((a) => a.id);
      for (const a of d.actions) {
        expect([a.id, cat.includes(a.id)]).toEqual([a.id, true]);
        expect([a.id, run.includes(`case "${a.id}"`)]).toEqual([a.id, true]);
      }
    }
  });

  test("a long branch chip wraps the dock instead of clipping it, and More opens above its button", () => {
    const src = code(dockSrc);
    // 100-character branch at 1500px: More, Revert and Reset left the screen when this was one nowrap row.
    expect(src).toMatch(/data-git-dock/);
    expect(src.slice(src.indexOf("<div className=\"shrink-0 flex"), src.indexOf("data-git-dock"))).toContain("flex-wrap");
    // ContextMenu clamps but never flips; from the button's top it covered the buttons beside it.
    expect(src).toContain("y: r.top - items.length");
  });
});

describe("Changes frames and ticks", () => {
  test("the clean frame names the last commit, and says only what it knows without one", () => {
    expect(renderToStaticMarkup(React.createElement(CleanFrame, { sha: "3f9c2a1" }, "Last commit 12 minutes ago."))).toContain("Nothing changed since <span");
    const bare = renderToStaticMarkup(React.createElement(CleanFrame, {}));
    expect(bare).toContain("Nothing changed");
    expect(bare).not.toContain("since");
  });
  test("the read failure is a plain sentence with Try again, never the URL or the raw error", () => {
    const at = panel.indexOf('title="The changes could not be read"');
    expect(at).toBeGreaterThan(0);
    const frame = panel.slice(at, panel.indexOf("/>", at));
    expect(frame).not.toContain("treeFail");
    expect(frame).toContain("retryButton(");
  });
  test("a file row has a tick box that does not select the row, and the dock counts the ticks", () => {
    expect(FILEROW).toContain('type="checkbox"');
    expect(FILEROW).toContain("stopPropagation");
    expect(panel).toContain("count: dockFiles.length");
  });
  test("several ticked files go to the server in one request, and Discard asks once", () => {
    const at = panel.indexOf("const changesRun = async (");
    const run = code(panel.slice(at, panel.indexOf("\n  };\n", at)));
    for (const call of ["api.gitStage(root, paths)", "api.gitUnstage(root, paths)", "api.gitDiscard(root, paths)"]) expect(run).toContain(call);
    expect(run.match(/\bask\(/g)?.length).toBe(1);
  });
});

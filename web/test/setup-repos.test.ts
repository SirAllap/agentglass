/*
 * Step 4: what a folder answer means, and what Continue sends.
 *
 * The read is `GET /setup/repos`; nothing is written until Continue, and what
 * Continue writes is the ticked roots added to the ones already open — adding a
 * repository must not close the project the person was in.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { SetupRepoRow, SetupRepos } from "../../shared/types.ts";
import { addedRoots, branchLabel, repoRowsOf, reposView, repoTally, skipAction, tickAll } from "../src/lib/setupRepos.ts";
import { RepoList, ReposStep } from "../src/components/setup/ReposStep.tsx";

const row = (name: string, branch = "main"): SetupRepoRow => ({ name, root: `/home/acme/code/${name}`, branch });
const rows = [row("orbit"), row("harbour"), row("ledger-api", "feat/canvas-board")];
const answer = (over: Partial<SetupRepos> = {}): SetupRepos =>
  ({ path: "/home/acme/code", exists: true, repos: rows, capped: false, ...over });

describe("what a folder answer means", () => {
  test("three repositories are three rows", () => {
    expect(reposView("/home/acme/code", answer())).toMatchObject({ state: "rows", path: "/home/acme/code" });
    expect(repoRowsOf(reposView("/home/acme/code", answer())).map((r) => r.name)).toEqual(["orbit", "harbour", "ledger-api"]);
  });

  test("a folder with no repository in it is its own sentence, never an empty list", () => {
    expect(reposView("/home/acme/docs", answer({ path: "/home/acme/docs", repos: [] })).state).toBe("notrepo");
  });

  test("a folder that is gone is not a folder with no repositories", () => {
    expect(reposView("/home/acme/gone", answer({ path: "/home/acme/gone", exists: false, repos: [] })).state).toBe("gone");
  });

  test("while the read is in the air the step says so, and nothing is called a failure yet", () => {
    expect(reposView("/home/acme/code", null).state).toBe("reading");
    expect(reposView("", null).state).toBe("empty");
  });
});

describe("the ticks", () => {
  test("Select all ticks what is not ticked and keeps what is", () => {
    expect([...tickAll([rows[1]!.root], rows)].sort()).toEqual([...rows.map((r) => r.root)].sort());
  });

  test("the tally counts the ticked rows only, out of the rows on screen", () => {
    expect(repoTally([], rows)).toEqual({ n: 0, of: 3 });
    expect(repoTally([rows[0]!.root, rows[2]!.root], rows)).toEqual({ n: 2, of: 3 });
  });
});

describe("what Continue sends", () => {
  test("the ticked ones, and the projects already open stay open", () => {
    expect(addedRoots(["/home/acme/other"], [rows[0]!.root])).toEqual(["/home/acme/other", rows[0]!.root]);
  });

  test("a ticked project that is already open is not sent twice", () => {
    expect(addedRoots([rows[0]!.root], rows.map((r) => r.root))).toEqual(rows.map((r) => r.root));
  });

  test("nothing ticked sends nothing, which is why Continue is off at zero", () => {
    expect(addedRoots(["/home/acme/other"], [])).toEqual(["/home/acme/other"]);
  });
});

describe("the footer's left button", () => {
  test("Skip for now on a middle step moves on without finishing", () => {
    expect(skipAction(3, 4)).toBe("advance");
    expect(skipAction(1, 4)).toBe("advance");
  });

  test("step 1 and the last step finish the setup", () => {
    expect(skipAction(0, 4)).toBe("finish");
    expect(skipAction(4, 4)).toBe("finish");
  });
});

describe("the rendered list", () => {
  const html = renderToStaticMarkup(React.createElement(RepoList, { path: "/home/acme/code", rows, ticked: [rows[0]!.root], onToggle: () => {} }));

  test("one checkbox per repository, in order, with its name", () => {
    expect([...html.matchAll(/type="checkbox"/g)]).toHaveLength(3);
    expect([...html.matchAll(/setup-reponame" title="([^"]+)"/g)].map((m) => m[1])).toEqual(["orbit", "harbour", "ledger-api"]);
  });

  test("only the ticked row is drawn as ticked", () => {
    expect([...html.matchAll(/data-on="1"/g)]).toHaveLength(1);
    expect([...html.matchAll(/checked=""/g)]).toHaveLength(1);
  });
});

describe("the step before a folder is picked", () => {
  const html = renderToStaticMarkup(React.createElement(ReposStep, { onFrame: () => {}, onCommit: () => {}, onSearch: () => {} }));

  test("the title and the typed path are on screen, and no repository row is", () => {
    expect(html).toContain("Bring your code in");
    expect(html).toContain("Or type a folder path");
    expect(html).not.toContain("type=\"checkbox\"");
  });

  test("the typed-path label points at the field it names", () => {
    const forId = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(forId).toBe("setup-repo-path");
    expect(html).toContain(`id="${forId}"`);
  });

  test("a window with no folder chooser draws no chooser button", () => {
    expect(html).not.toContain("Pick a folder");
  });
});

describe("the step writes nothing until Continue", () => {
  const src = readFileSync(new URL("../src/components/setup/ReposStep.tsx", import.meta.url).pathname, "utf8");
  const frame = readFileSync(new URL("../src/components/setup/SetupFlow.tsx", import.meta.url).pathname, "utf8");

  test("the one write is the ticked roots, added to what is open", () => {
    expect(src).toContain("api.setWorkspaces(addedRoots(");
    expect(src).not.toContain("setProjectRoot");
  });

  test("reading a folder is not a write, and skipping the step is not either", () => {
    expect(src).not.toContain("settingsDoorSet");
    expect(frame).toContain('skipAction(step, SETUP_STEPS.length - 1) === "advance"');
  });

  test("a line the footer names reads the step's own tally", () => {
    expect(frame).toContain("repositories");
    expect(frame).toContain("<ReposStep onFrame={setRepos}");
  });
});

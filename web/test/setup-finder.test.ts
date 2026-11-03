/*
 * The Finder: its six states, what the bar counts, and what Select all means
 * once a filter is on.
 *
 * The screen is rendered without a browser, like the rest of this suite, so
 * the state machine is asked directly and the markup is read as text. The one
 * behaviour a render cannot show — that `←` and `×` keep the ticks — is
 * asserted against the source that owns it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { SetupScan, SetupScanRow } from "../../shared/types.ts";
import { SETUP_SCAN_MAX_REPOS, SETUP_SCAN_SKIPS } from "../../shared/setupScan.ts";
import {
  addLabel, failureLine, filterRows, finderPhase, groupRows, relativeAge, selectAll, selectNone, skipLine,
  stoppedLine, tickFiltered, untickFiltered,
} from "../src/lib/setupScan.ts";
import { FinderScreen } from "../src/components/setup/ProjectFinder.tsx";

const row = (name: string, parent = "/home/acme/code/acme", branch = "main"): SetupScanRow =>
  ({ name, root: `${parent}/${name}`, parent, branch, touchedAt: Date.now() - 2 * 3_600_000 });

const rows = [
  row("orbit"),
  row("harbour", "/home/acme/code/acme", "release/2.4"),
  row("ledger-api", "/home/acme/code/acme", "feat/canvas-board"),
  row("docs", "/home/acme/work"),
];

const scan = (over: Partial<SetupScan> = {}): SetupScan => ({
  id: "scan-1", state: "done", roots: ["/home/acme"], folders: 18, current: "/home/acme/code",
  repos: rows, capped: null, startedAt: 0, elapsedMs: 1200, skips: [...SETUP_SCAN_SKIPS], ...over,
});

const draw = (over: Partial<SetupScan> | null, extra: Partial<Parameters<typeof FinderScreen>[0]> = {}) =>
  renderToStaticMarkup(React.createElement(FinderScreen, {
    homedir: "/home/acme",
    scan: over === null ? null : scan(over),
    failure: "",
    filter: "",
    ticked: [],
    adding: false,
    addError: "",
    onFilter: () => {}, onTick: () => {}, onAll: () => {}, onNone: () => {},
    onStart: () => {}, onStop: () => {}, onBack: () => {}, onAdd: () => {},
    ...extra,
  }));

describe("the six states", () => {
  test("empty: where it will look, what it skips, and one way to start", () => {
    const html = draw(null);
    expect(html).toContain("Find projects on this computer");
    expect(html).toContain("Start the search");
    expect(html).toContain("/home/acme");
    expect(html).toContain("node_modules");
    expect(html).toContain("nothing is kept");
  });

  test("scanning: live counts, the folder being read, and Stop inside the scan", () => {
    const html = draw({ state: "running", elapsedMs: 5000, folders: 42, current: "/home/acme/code/acme" });
    expect(html).toContain("Reading this computer");
    expect(html).toContain("42");
    expect(html).toContain("about 15s left");
    expect(html).toContain("~/code/acme");
    expect(html).toContain("Stop");
    expect(html).toContain('disabled=""');
  });

  test("done: groups, a filter, select all/none and Add in the corner", () => {
    const html = draw({}, { ticked: rows.slice(0, 3).map((r) => r.root) });
    expect(html).toContain("Filter by name or path");
    expect(html).toContain("Select all");
    expect(html).toContain("Select none");
    expect(html).toContain("~/code/acme");
    expect(html).toContain("3 selected");
    expect(html).toContain("Add 3 projects");
    expect(html.indexOf("finder-foot")).toBeGreaterThan(html.indexOf("finder-body"));
  });

  test("nothing found: the skip list is named, and there are two other ways in", () => {
    const html = draw({ repos: [], folders: 26 });
    expect(html).toContain("No git repository turned up");
    for (const skip of SETUP_SCAN_SKIPS) expect(html).toContain(skip);
    expect(html).toContain("Search again");
    expect(html).toContain("Pick a folder instead");
  });

  test("stopped early: the cap, the folders read, and what to do instead", () => {
    const html = draw({ state: "stopped", capped: "count", folders: 500, repos: [rows[0]!] });
    expect(html).toContain("Stopped at 500 repositories");
    expect(html).toContain("500 folders read");
    expect(html).toContain("Search again");
    expect(html).toContain("Add projects");
  });

  test("a person stopping says so without inventing a cap", () => {
    const html = draw({ state: "stopped", capped: "person", folders: 7, repos: [] });
    expect(html).toContain("Stopped with 7 folders read");
    expect(html).not.toContain("500 repositories");
  });

  test("failed: the server's own sentence, Try again, and nothing kept", () => {
    const html = draw({ state: "failed", error: "the disk is not readable" });
    expect(html).toContain("The search could not run: the disk is not readable.");
    expect(html).toContain("Try again");
    expect(html).toContain("Nothing was kept");
  });
});

describe("the bar and the ticks", () => {
  test("the bar equals the checked rows and the button says the same number", () => {
    const html = draw({}, { ticked: rows.slice(0, 3).map((r) => r.root) });
    expect(html).toContain("3 selected");
    expect(html).toContain("Add 3 projects");
    expect(addLabel(1)).toBe("Add 1 project");
  });

  test("a ticked row the filter hides is still counted, because it will be added", () => {
    const ticked = rows.map((r) => r.root);
    const html = draw({}, { ticked, filter: "ledger" });
    expect(html).toContain("4 selected");
    expect(html).toContain("Add 4 projects");
  });

  test("Select none then Add is refused, because nothing is ticked", () => {
    const ticked = rows.map((r) => r.root);
    const none = untickFiltered(ticked, rows);
    expect(none).toEqual([]);
    const html = draw({}, { ticked: none });
    expect(html).toContain("Add projects");
    expect(html).toContain('disabled=""');
  });

  test("Select all acts on the filtered rows, never the whole set", () => {
    const pick = selectAll([], rows, "code/acme");
    expect(pick.sort()).toEqual([rows[0]!.root, rows[1]!.root, rows[2]!.root].sort());
    expect(pick).not.toContain(rows[3]!.root);
  });

  test("Select none clears the filtered rows and leaves a checked row outside the filter", () => {
    const ticked = rows.map((r) => r.root);
    const left = selectNone(ticked, rows, "work");
    expect(left).not.toContain(rows[3]!.root);
    expect(left).toContain(rows[0]!.root);
  });

  test("the filter matches a name or a path, and nothing matches an empty result", () => {
    expect(filterRows(rows, "ledger").map((r) => r.name)).toEqual(["ledger-api"]);
    expect(filterRows(rows, "/work/").map((r) => r.name)).toEqual(["docs"]);
    expect(filterRows(rows, "acme")).toHaveLength(4);
    expect(filterRows(rows, "zzz")).toEqual([]);
  });
});

describe("what a row says", () => {
  test("a branch is cut to one line, and the full value is its title and name", () => {
    const long = "feature/ORBIT-1042-a-very-long-branch-name-for-one-row";
    const html = renderToStaticMarkup(React.createElement(FinderScreen, {
      homedir: "/home/acme", scan: scan({ repos: [row("orbit", "/home/acme/code/acme", long)] }), failure: "",
      filter: "", ticked: [], adding: false, addError: "",
      onFilter: () => {}, onTick: () => {}, onAll: () => {}, onNone: () => {},
      onStart: () => {}, onStop: () => {}, onBack: () => {}, onAdd: () => {},
    }));
    expect(html).toContain(`title="${long}"`);
    expect(html).toContain(`aria-label="${long}"`);
    expect(html).not.toContain(`>${long}<`);
  });

  test("a last-commit age reads in the mock's words", () => {
    const now = Date.UTC(2026, 10, 1, 12, 0, 0);
    expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(relativeAge(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3 d ago");
    expect(relativeAge(now - 8 * 86_400_000, now)).toBe("1 w ago");
    expect(relativeAge(0, now)).toBe("no commit");
  });
});

describe("the phase a search is in", () => {
  test("six states, from the one answer", () => {
    expect(finderPhase(null)).toBe("empty");
    expect(finderPhase(scan({ state: "running" }))).toBe("scanning");
    expect(finderPhase(scan())).toBe("done");
    expect(finderPhase(scan({ repos: [] }))).toBe("nothing");
    expect(finderPhase(scan({ state: "stopped" }))).toBe("stopped");
    expect(finderPhase(scan({ state: "failed" }))).toBe("failed");
    expect(finderPhase(null, "no answer")).toBe("failed");
  });

  test("groups are by parent, both orders readable", () => {
    const groups = groupRows(rows);
    expect(groups.map((g) => g.parent)).toEqual(["/home/acme/code/acme", "/home/acme/work"]);
    expect(groups[0]!.rows.map((r) => r.name)).toEqual(["harbour", "ledger-api", "orbit"]);
  });

  test("a sentence never ends twice", () => {
    expect(failureLine(scan({ state: "failed", error: "the disk is not readable." }))).toBe("The search could not run: the disk is not readable.");
    expect(failureLine(null, "")).toBe("The search could not run.");
  });

  test("the stopped line names the cap the walk hit", () => {
    expect(stoppedLine(scan({ state: "stopped", capped: "count", folders: 610 })))
      .toContain(`Stopped at ${SETUP_SCAN_MAX_REPOS} repositories with 610 folders read`);
    expect(stoppedLine(scan({ state: "stopped", capped: "time", folders: 40, elapsedMs: 20_400 })))
      .toContain("Stopped after 20 seconds with 40 folders read");
  });

  test("the skip list is one sentence with the last item joined", () => {
    expect(skipLine()).toBe("It skips node_modules, caches, hidden folders and system folders.");
  });
});

describe("the ticks survive the way back", () => {
  const finder = readFileSync(new URL("../src/components/setup/ProjectFinder.tsx", import.meta.url), "utf8");
  const flow = readFileSync(new URL("../src/components/setup/SetupFlow.tsx", import.meta.url), "utf8");

  test("back and close both only close; neither clears the ticks", () => {
    expect(finder).toContain('aria-label="Close the search"');
    expect(finder).toContain("onClick={onBack}");
    expect(finder).not.toContain("onTicked([])");
    expect(flow).toContain("onBack={() => setFinder(false)}");
  });

  test("the ticks live in the frame, so reopening the Finder shows them again", () => {
    expect(flow).toContain("ticked={scanTicked}");
    expect(flow).toContain("onTicked={setScanTicked}");
  });
});

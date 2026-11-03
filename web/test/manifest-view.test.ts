/*
 * THE MANIFEST VIEW, RENDERED.
 *
 * `ManifestScreen` is the whole screen without its wiring, so every state the
 * plan names is drawn here from a fixture: no server, no effects, no clock.
 * The words asserted are the plan's and the decisions', not this test's.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManifestScreen, type ManifestScreenProps } from "../src/components/ManifestView.tsx";
import {
  ALL_PROJECTS, ageWords, dateTimeWords, fixesLanded, leftLine, projectView, readScope, rememberScope, showsFilter,
  signoffLine, startLineWords, summaryHasLeft, verdictLine, type ManifestProjectView, type ManifestRowRef,
} from "../src/lib/manifest.ts";
import { VIEWS, SHIPPED_RAIL } from "../src/components/workspace/views.ts";
import { VIEW_IDS } from "../../shared/uiActions.ts";
import type { ManifestProject, ManifestRow, ManifestSummaryProject } from "../../shared/manifest.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

const NOW = new Date("2026-11-01T09:00:00").getTime();
const ROOT = "/home/acme/orbit";
const sha = (n: number) => String(n).repeat(40).slice(0, 40);

const row = (over: Partial<ManifestRow> = {}): ManifestRow => ({
  sha: sha(1), subject: "ORBIT-1042 make the tab strip follow the pane", time: Math.floor((NOW - 3 * 3_600_000) / 1000),
  ticket: "ORBIT-1042", inBuild: true, verdict: null, at: null, kind: null, note: null, group: "toTest", ...over,
});

/** The same row after the filter has tagged it with its project. */
const ref = (over: Partial<ManifestRowRef> = {}): ManifestRowRef => ({
  ...row(), project: ROOT, projectName: "orbit", ...over,
});

export const project = (over: Partial<ManifestProject> = {}): ManifestProject => ({
  root: ROOT, name: "orbit", boundary: "build", trunk: true, signOff: "yes",
  start: { sha: sha(9), at: NOW - 3_600_000, omitted: 192 },
  rows: [row()],
  inProgress: [{ name: "orbit-queue", doing: "writing the retry guard", branch: "orbit-queue-retry", startedAt: NOW - 38 * 60_000, paneId: "%12" }],
  counters: { merged: 1, running: 1, builtWaiting: 0 },
  left: 1,
  ...over,
});

/** What the screen draws: one project's answer, or the merge of several. */
const view = (over: Partial<ManifestProjectView> = {}): ManifestProjectView => ({
  root: ROOT, name: "orbit", boundary: "build", trunk: true, signOff: "yes",
  start: { at: NOW - 3_600_000, omitted: 192 },
  rows: [ref()],
  inProgress: [{ name: "orbit-queue", doing: "writing the retry guard", branch: "orbit-queue-retry", startedAt: NOW - 38 * 60_000, paneId: "%12", project: ROOT, projectName: "orbit" }],
  counters: { merged: 1, running: 1, builtWaiting: 0 },
  left: 1,
  ...over,
});

const summary: ManifestSummaryProject[] = [{ root: ROOT, name: "orbit", left: 1, signOff: "yes", trunk: true }];

const base = (over: Partial<ManifestScreenProps> = {}): ManifestScreenProps => ({
  project: view(), name: "orbit", summary, scope: ROOT, readAt: NOW - 60_000, now: NOW,
  loading: false, error: null, failedRefetch: false, busy: null, rowErrors: {},
  notes: {}, openRow: null, toTestLimit: 50, doneOpen: false, readyOpen: false,
  startAsk: false, startBusy: false, startError: null,
  onRefresh: () => {}, onProject: () => {}, onScope: () => {}, onSign: () => {}, onUndo: () => {}, onRetry: () => {},
  onOpenRow: () => {}, onNote: () => {}, onSaveNote: () => {}, onShowOlder: () => {},
  onDoneToggle: () => {}, onReadyToggle: () => {}, onShowIt: () => {},
  onStartAsk: () => {}, onStartCancel: () => {}, onStartConfirm: () => {},
  ...over,
});
const html = (over: Partial<ManifestScreenProps> = {}) => renderToStaticMarkup(React.createElement(ManifestScreen, base(over)));

describe("the words a clock becomes", () => {
  test("an age has one spelling in the header and the pill", () => {
    expect(ageWords(0)).toBe("less than a minute ago");
    expect(ageWords(59_000)).toBe("less than a minute ago");
    expect(ageWords(60_000)).toBe("1 minute ago");
    expect(ageWords(5 * 60_000)).toBe("5 minutes ago");
    expect(ageWords(60 * 60_000)).toBe("1 hour ago");
    expect(ageWords(3 * 60 * 60_000)).toBe("3 hours ago");
  });
  test("a verdict pill and the sign-off line name who and when", () => {
    expect(verdictLine("tested", NOW)).toBe("Tested by you · 09:00");
    expect(signoffLine("failed", NOW, "phone", "the footer still shifts")).toBe("Failed by you · 09:00 · from the phone · “the footer still shifts”");
  });
  test("the aggregate title counts fixes", () => {
    expect(fixesLanded(1)).toBe("1 fix landed after the build you are running");
    expect(fixesLanded(4)).toBe("4 fixes landed after the build you are running");
  });
  test("the header's left line is this project's, then another project's", () => {
    expect(leftLine({ left: 2, name: "orbit" }, summary)).toBe("2 left for you");
    expect(leftLine({ left: 0, name: "orbit" }, [{ ...summary[0]!, left: 4, name: "acme" }])).toBe("4 left for you in acme");
    expect(leftLine({ left: 0, name: "orbit" }, summary)).toBe("nothing left for you");
  });
  test("the dot lights for a project the caller may sign in and that has a trunk", () => {
    expect(summaryHasLeft(summary)).toBe(true);
    expect(summaryHasLeft([{ ...summary[0]!, signOff: "grant" }])).toBe(false);
    expect(summaryHasLeft([{ ...summary[0]!, trunk: false }])).toBe(false);
    expect(summaryHasLeft([])).toBe(false);
  });
  test("the start line's date and the older commits it leaves out", () => {
    expect(dateTimeWords(NOW)).toBe("1 Nov 2026, 09:00");
    expect(startLineWords({ at: NOW, omitted: 192 })).toBe("Counting from 1 Nov 2026, 09:00 · 192 older commits are not listed");
    expect(startLineWords({ at: NOW, omitted: 1 })).toBe("Counting from 1 Nov 2026, 09:00 · 1 older commit is not listed");
    expect(startLineWords({ at: NOW, omitted: 0 })).toBe("Counting from 1 Nov 2026, 09:00 · 0 older commits are not listed");
    expect(startLineWords(null)).toBeNull();
  });
});

describe("starting from zero", () => {
  test("the header names the line, and the button sits beside Refresh", () => {
    const h = html();
    expect(h).toContain("Counting from 1 Nov 2026, 08:00 · 192 older commits are not listed");
    expect(h).toContain("Start from zero now");
    expect(h).toContain('class="mv-tools"');
    expect(viewSrc.indexOf("mv-startbtn")).toBeGreaterThan(viewSrc.indexOf('className="mv-tools"'));
    expect(viewSrc.indexOf("mv-startbtn")).toBeLessThan(viewSrc.indexOf("<RefreshButton"));
  });

  test("pressing it asks one line in the page, never a browser dialog", () => {
    const closed = html();
    expect(closed).not.toContain("Count from the current commit on?");
    const open = html({ startAsk: true });
    expect(open).toContain("Count from the current commit on? Older commits leave the list.");
    expect(open).toContain(">Start from zero<");
    expect(open).toContain(">Cancel<");
    expect(open).toContain('role="group" aria-label="Start from zero"');
    expect(viewSrc).not.toContain("window.confirm");
    expect(viewSrc).not.toContain("confirm(");
  });

  test("a caller who may not move the line gets the button disabled", () => {
    for (const signOff of ["grant", "off"] as const) {
      const h = html({ project: view({ signOff }) });
      expect(h).toMatch(/<button[^>]*class="mv-btn mv-startbtn"[^>]*disabled/);
    }
    expect(html()).not.toMatch(/<button[^>]*class="mv-btn mv-startbtn"[^>]*disabled/);
  });

  test("a checkout with no trunk has nothing to start from", () => {
    const h = html({ project: view({ trunk: false, start: null, rows: [], inProgress: [], counters: { merged: 0, running: 0, builtWaiting: 0 }, left: 0 }) });
    expect(h).not.toContain("Start from zero now");
    expect(h).not.toContain("Counting from");
  });

  test("a refused move says the server's sentence in the header", () => {
    const h = html({ startError: "only the person starts the count from zero" });
    expect(h).toContain("only the person starts the count from zero");
  });

  test("the merged line counts from the earliest project and adds their omitted commits", () => {
    const rows = [
      project({ start: { sha: sha(9), at: NOW - 2 * 3_600_000, omitted: 5 } }),
      project({ root: "/home/acme/queue", name: "queue", start: { sha: sha(8), at: NOW - 3_600_000, omitted: 7 }, rows: [], inProgress: [], counters: { merged: 0, running: 0, builtWaiting: 0 }, left: 0 }),
    ];
    const merged = projectView(rows, ALL_PROJECTS)!;
    expect(merged.start).toEqual({ at: NOW - 2 * 3_600_000, omitted: 12 });
  });
});

describe("states", () => {
  test("loading says it is reading this machine and draws rows the height of one", () => {
    const h = html({ project: null, loading: true, summary: null });
    expect(h).toContain("reading this machine");
    expect(h).toContain("aria-busy=\"true\"");
    expect(h).toContain("mv-skel");
    expect(h).not.toContain("Sign-off is off in this window");
  });

  test("a failed read is one sentence and Try again, and the server's own words win", () => {
    const fallback = html({ project: null, error: "", readAt: NOW - 4 * 60_000 });
    expect(fallback).toContain("This machine did not answer");
    expect(fallback).toContain("The view could not read the checkout at orbit. Nothing was lost; the verdicts you already gave are on the server.");
    expect(fallback).toContain("Try again");
    expect(fallback).toContain("read 4 minutes ago · the last answer this window got");
    const answered = html({ project: null, error: "that project is not open" });
    expect(answered).toContain("that project is not open");
    expect(answered).not.toContain("Nothing was lost");
  });

  test("a checkout with no trunk says so where To test would be", () => {
    const h = html({ project: view({ trunk: false, rows: [], inProgress: [], counters: { merged: 0, running: 0, builtWaiting: 0 }, left: 0 }) });
    expect(h).toContain("No branch to read");
    expect(h).toContain("This checkout has no branch to compare against.");
    expect(h).not.toContain("To test");
  });

  test("no install boundary: the header says it, the third counter is an en dash, and every row signs", () => {
    const h = html({ project: view({ boundary: "none", counters: { merged: 1, running: 1, builtWaiting: null }, rows: [ref({ inBuild: null })] }) });
    expect(h).toContain("no install boundary");
    expect(h).toContain("This app&#x27;s build is not in this checkout, so there is nothing to measure installed against.");
    expect(h).toContain("–");
    expect(h).toContain("no boundary for this project");
    expect(h).not.toContain("Ready to install");
    expect(h).toContain(">Tested<");
  });

  test("a phone without the answer grant is read-only, in the plan's sentence", () => {
    const h = html({ project: view({ signOff: "grant" }) });
    expect(h).toContain("Signing off needs the answer grant; this device can read the list.");
    expect(h).toContain("disabled");
  });

  test("any other refused window has its own sentence", () => {
    const h = html({ project: view({ signOff: "off" }) });
    expect(h).toContain("Sign-off is off in this window. Open it in the app, or from a paired phone.");
  });

  test("with signOff yes there is no line and every row signs", () => {
    const h = html();
    expect(h).not.toContain("Sign-off is off in this window");
    expect(h).not.toContain("Signing off needs the answer grant");
    expect(h).toContain(">Tested<");
    expect(h).toContain(">Failed<");
  });

  test("a signed row draws one pill and Undo, not two buttons", () => {
    const h = html({ project: view({ rows: [ref({ verdict: "tested", at: NOW, kind: "person", note: "the strip follows the pane" })] }) });
    expect(h).toContain("Tested by you · 09:00");
    expect(h).toContain("Undo");
    expect(h).toContain("Undo removes the verdict and its note");
    expect(h).not.toContain(">Tested<");
  });

  test("an unsigned row carries the no-steps chip, a signed one does not", () => {
    expect(html()).toContain("no steps — ask the builder");
    const signed = html({ project: view({ rows: [ref({ verdict: "tested", at: NOW, kind: "person" })] }) });
    expect(signed).toContain("no steps — ask the builder");
    const doneOnly = html({ project: view({ rows: [ref({ group: "done", verdict: "tested", at: NOW, kind: "person" }) ] }), doneOpen: true });
    expect(doneOnly).not.toContain("no steps — ask the builder");
  });

  test("Done this week is collapsed first, and an old unsigned row lives there", () => {
    const old = ref({ sha: sha(2), subject: "ORBIT-1051 export the queue", time: Math.floor((NOW - 25 * 3_600_000) / 1000), group: "done", ticket: "ORBIT-1051" });
    const closed = html({ project: view({ rows: [ref(), old] }) });
    expect(closed).toContain("Done this week");
    expect(closed).toContain("Show 1");
    expect(closed).toContain("in the build you are running · signed off or not");
    const open = html({ project: view({ rows: [ref(), old] }), doneOpen: true });
    expect(open).toContain("ORBIT-1051 export the queue");
    expect(open).toContain("Hide 1");
  });

  test("Ready to install is one aggregate row, and absent without a boundary", () => {
    const r = ref({ sha: sha(3), subject: "ORBIT-1052 paint the corner", group: "ready", inBuild: false, ticket: "ORBIT-1052" });
    const h = html({ project: view({ rows: [ref(), r], counters: { merged: 2, running: 1, builtWaiting: 1 } }) });
    expect(h).toContain("Ready to install");
    expect(h).toContain("merged, not in the build you are looking at");
    expect(h).toContain("1 fix landed after the build you are running");
    expect(h).toContain("1 commits ahead");
  });

  test("the empty window is the mockup's box, counters zero and no Ready group", () => {
    const h = html({ project: view({ rows: [], inProgress: [], counters: { merged: 0, running: 0, builtWaiting: 0 }, left: 0 }) });
    expect(h).toContain("Nothing merged this week");
    expect(h).toContain("Nothing merged, nothing running, nothing waiting for your eyes. The next thing a worker lands will appear here on its own.");
    expect(h).not.toContain("Ready to install");
  });

  test("nothing running is one line, not a card", () => {
    const h = html({ project: view({ inProgress: [], counters: { merged: 1, running: 0, builtWaiting: 0 } }) });
    expect(h).toContain("Nothing is running on this project.");
  });

  test("`Show N older` counts only the rows not yet drawn", () => {
    const many = Array.from({ length: 60 }, (_, i) => ref({ sha: sha((i % 9) + 1), subject: `ORBIT-10${i} row ${i}` }));
    const h = html({ project: view({ rows: many }), toTestLimit: 50 });
    expect(h).toContain("Show 10 older");
  });

  test("when the last refetch failed, the rows say when they were read", () => {
    const h = html({ readAt: NOW - 4 * 60_000, failedRefetch: true });
    expect(h).toContain("these rows were read 4 minutes ago — a merge may have landed since");
    expect(h).toContain("read 4 minutes ago");
  });
});

/* The server answers one project at a time; the filter merges them here. */
describe("the project filter", () => {
  const queueRoot = "/home/acme/queue";
  const orbit = project({
    rows: [
      row({ sha: sha(5), subject: "ORBIT-1075 orbit newer", time: Math.floor((NOW - 3_600_000) / 1000) }),
      row({ sha: sha(3), subject: "ORBIT-1073 orbit older", time: Math.floor((NOW - 9 * 3_600_000) / 1000) }),
    ],
    counters: { merged: 2, running: 1, builtWaiting: 0 }, left: 2,
  });
  const queue = project({
    root: queueRoot, name: "queue",
    rows: [row({ sha: sha(4), subject: "ORBIT-1074 queue middle", ticket: "ORBIT-1074", time: Math.floor((NOW - 5 * 3_600_000) / 1000) })],
    inProgress: [], counters: { merged: 1, running: 0, builtWaiting: 0 }, left: 1,
  });
  const two: ManifestSummaryProject[] = [
    { root: ROOT, name: "orbit", left: 2, signOff: "yes", trunk: true },
    { root: queueRoot, name: "queue", left: 1, signOff: "yes", trunk: true },
  ];

  test("All merges every project's rows by time and keeps each row's project", () => {
    const all = projectView([orbit, queue], ALL_PROJECTS)!;
    expect(all.rows.map((r) => r.subject)).toEqual([
      "ORBIT-1075 orbit newer", "ORBIT-1074 queue middle", "ORBIT-1073 orbit older",
    ]);
    expect(all.rows.map((r) => r.projectName)).toEqual(["orbit", "queue", "orbit"]);
    expect(all.rows[1]!.project).toBe(queueRoot);
  });

  test("the counters follow the filter", () => {
    const all = projectView([orbit, queue], ALL_PROJECTS)!;
    expect(all.counters).toEqual({ merged: 3, running: 1, builtWaiting: 0 });
    expect(all.left).toBe(3);
    const one = projectView([orbit, queue], queueRoot)!;
    expect(one.rows.map((r) => r.subject)).toEqual(["ORBIT-1074 queue middle"]);
    expect(one.counters).toEqual({ merged: 1, running: 0, builtWaiting: 0 });
    expect(one.left).toBe(1);
  });

  test("a project that is no longer open draws nothing", () => {
    expect(projectView([orbit, queue], "/home/acme/gone")).toBeNull();
  });

  test("one project hides the filter; two draw All and a chip per project", () => {
    expect(showsFilter(summary)).toBe(false);
    expect(html()).not.toContain("mv-filter");
    expect(showsFilter(two)).toBe(true);
    const h = html({ project: projectView([orbit, queue], ALL_PROJECTS), summary: two, scope: ALL_PROJECTS });
    expect(h).toContain('class="mv-filter agx-seg"');
    expect(h).toContain(">All<");
    expect(h).toContain(">queue<");
    expect(h).toContain('role="tab" class="agx-seg-b" aria-selected="true">All<');
    expect(h).toContain('<span class="mv-pill">queue</span>');
  });

  test("a chip shows only its project's rows", () => {
    const h = html({ project: projectView([orbit, queue], queueRoot), summary: two, scope: queueRoot });
    expect(h).toContain("ORBIT-1074 queue middle");
    expect(h).not.toContain("ORBIT-1075 orbit newer");
    expect(h).toContain('aria-selected="true" title="/home/acme/queue">queue<');
  });

  test("the window remembers its project and falls back to All when it is closed", () => {
    const cells = new Map<string, string>();
    stubGlobal("localStorage", {
      getItem: (k: string) => cells.get(k) ?? null,
      setItem: (k: string, v: string) => { cells.set(k, v); },
      removeItem: (k: string) => { cells.delete(k); },
    });
    expect(readScope([ROOT, queueRoot])).toBe(ALL_PROJECTS);
    rememberScope(queueRoot);
    expect(readScope([ROOT, queueRoot])).toBe(queueRoot);
    expect(readScope([ROOT])).toBe(ALL_PROJECTS);
  });

  test("a window that refuses storage still filters", () => {
    const denied = () => { throw new Error("storage is off"); };
    stubGlobal("localStorage", { getItem: denied, setItem: denied, removeItem: denied });
    expect(readScope([ROOT])).toBe(ALL_PROJECTS);
    expect(() => rememberScope(ROOT)).not.toThrow();
  });

  test("a sign-off goes to the row's own project, never the filter's", () => {
    expect(viewSrc).toContain("signOff(row.project, row.sha");
    expect(viewSrc).not.toContain("signOff(root,");
  });
});

describe("controls keep their place", () => {
  test("a phone's controls take TOUCH; the desk's take HIT", () => {
    const h = html();
    expect(h).toContain("--mv-touch:40px");
    expect(h).toContain("--mv-hit:26px");
  });

  test("the note field is drawn on an unsigned row, with the rule's sentence", () => {
    const h = html({ openRow: sha(1) });
    expect(h).toContain("Test it, then sign off with a note");
    expect(h).toContain("Pick Tested or Failed first");
  });

  test("over the limit, the sentence and a quiet Save", () => {
    const h = html({ openRow: sha(1), notes: { [sha(1)]: "x".repeat(501) } });
    expect(h).toContain("500 characters at most");
    expect(h).toContain("disabled");
  });

  test("a signed row's body is the sign-off line, never the note field", () => {
    const h = html({ openRow: sha(1), project: view({ rows: [ref({ verdict: "failed", at: NOW, kind: "phone", note: "the footer still shifts" })] }) });
    expect(h).toContain("<b>Failed</b> by you · 09:00 · from the phone · “the footer still shifts”");
    expect(h).not.toContain("Test it, then sign off with a note");
  });
});

/* What the first shots showed: a group squeezed by the flex column, a counter
 * label wrapped, and a bucket with commits drawn in the empty colour. */
const css = await Bun.file(new URL("../src/components/manifestView.css", import.meta.url)).text();
const viewSrc = await Bun.file(new URL("../src/components/ManifestView.tsx", import.meta.url)).text();
const rule = (selector: string): string => {
  const at = css.indexOf(selector);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at) + 1);
};

describe("the body's groups keep their height", () => {
  test("a group does not shrink, so the body scrolls instead of clipping rows", () => {
    expect(rule(".mv-body > *")).toContain("flex: none");
  });

  test("a counter label is one line on the desk", () => {
    expect(rule(".mv-count .mv-l")).not.toContain("max-width");
  });

  test("a counter keeps its label off the next divider", () => {
    const c = rule(".mv-count {");
    expect(c).toContain("padding-right");
    expect(c).toMatch(/min-width:\s*11[0-9]px/);
  });

  test("a bucket with a commit wears --info, not the empty baseline's colour", () => {
    expect(rule(".mv-strip i.hit")).toContain("--info");
    expect(html()).toContain('class="hit"');
  });
});

describe("the rail and the agent door", () => {  test("Manifest ships hidden: it is one click away in the restore menu, not a seat on the rail", () => {
    expect(SHIPPED_RAIL.hidden.map((v) => v.id)).toContain("manifest");
    expect(SHIPPED_RAIL.utility.map((v) => v.id)).not.toContain("manifest");
    expect(VIEWS.find((v) => v.id === "manifest")?.label).toBe("Manifest");
  });

  test("three lists agree, so `view.open to=manifest` is a view the rail draws", () => {
    expect(VIEW_IDS).toContain("manifest");
    expect(VIEWS.map((v) => v.id)).toContain("manifest");
  });
});

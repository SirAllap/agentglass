/*
 * What the site's development tool adds to a card's Development section: one row
 * per pull request however many ways it was found, the richest state on it, and
 * nothing at all when the tool holds nothing.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardDev, CardDevPr } from "../../shared/providers.ts";
import { approvalsOf, countsLine, withDev } from "../src/lib/jiraDev.ts";
import { JiraPrsView } from "../src/components/jira/JiraCardPrs.tsx";
import { JiraDevLists } from "../src/components/jira/JiraDev.tsx";
import type { JiraLink } from "../src/lib/jiraLinks.ts";

const pr = (n: number, o: Partial<CardDevPr> = {}): CardDevPr => ({ url: `https://github.com/acme/orbit/pull/${n}`, title: `Retry the export (${n})`, state: "OPEN", reviewers: [], comments: 0, updated: 0, ...o });
const link = (n: number, where: JiraLink["where"] = "link"): JiraLink => ({ url: `https://github.com/acme/orbit/pull/${n}`, number: n, title: `acme/orbit#${n}`, resolved: false, where });
const dev = (o: Partial<CardDev> = {}): CardDev => ({ counts: { pullRequests: 0, branches: 0, commits: 0, builds: 0 }, buildsPassed: 0, buildsFailed: 0, prs: [], branches: [], commits: [], builds: [], ...o });

describe("withDev", () => {
  test("one pull request found twice is one row, with the tool's title and state laid over the app's", () => {
    const out = withDev([link(7)], [pr(7, { state: "MERGED" })]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ number: 7, title: "Retry the export (7)", where: "link" });
    expect(out[0]!.dev?.state).toBe("MERGED");
  });
  test("the address is compared in its canonical form, a trailing /files or a capital does not make a second row", () => {
    const out = withDev([link(7)], [pr(7, { url: "https://github.com/Acme/Orbit/pull/7/files" })]);
    expect(out.length).toBe(1);
  });
  test("a pull request only the tool knows is a row marked dev, after the app's", () => {
    const out = withDev([link(7, "comment")], [pr(8)]);
    expect(out.map((l) => [l.number, l.where])).toEqual([[7, "comment"], [8, "dev"]]);
    expect(out[1]!.resolved).toBe(false);
  });
  test("a merged one only the tool knows is resolved", () => {
    expect(withDev([], [pr(8, { state: "MERGED" })])[0]!.resolved).toBe(true);
  });
  test("a host the app has no pattern for keeps its own address and the number it ends in", () => {
    const out = withDev([], [pr(0, { url: "https://bitbucket.example/acme/orbit/pull-requests/41" })]);
    expect(out[0]).toMatchObject({ number: 41, where: "dev" });
  });
  test("nothing from the tool leaves the app's rows exactly as they were", () => {
    const rows = [link(7), link(9, "description")];
    expect(withDev(rows, [])).toEqual(rows);
  });
});

describe("the words", () => {
  test("approvals: nobody asked says nothing", () => {
    expect(approvalsOf(pr(1))).toBe("");
    expect(approvalsOf(pr(1, { reviewers: [{ name: "Bo", approved: true }, { name: "Cy", approved: false }] }))).toBe("1 of 2 approved");
  });
  test("counts: kinds of zero are left out, one is singular", () => {
    expect(countsLine({ pullRequests: 1, branches: 0, commits: 12, builds: 2 })).toBe("1 PR · 12 commits · 2 builds");
    expect(countsLine({ pullRequests: 0, branches: 1, commits: 0, builds: 0 })).toBe("1 branch");
  });
});

describe("drawn", () => {
  const view = (links: JiraLink[]) => renderToStaticMarkup(React.createElement(JiraPrsView, { links, error: "", writable: false, said: "", busy: false, draft: "", onDraft() {}, onLink() {} }));
  test("a pull request row says its state, who wrote it, where it goes and who approved", () => {
    const html = view(withDev([link(7)], [pr(7, { state: "MERGED", author: "Ada Example", from: "feature/ORBIT-1042", into: "main", reviewers: [{ name: "Bo Sample", approved: true }] })]));
    for (const said of ["MERGED", "by Ada Example", "feature/ORBIT-1042 → main", "1 of 1 approved"]) expect(html).toContain(said);
  });
  test("a row only the tool knows says so", () => {
    expect(view(withDev([], [pr(8)]))).toContain("known to the development tool");
  });
  test("a row the tool does not know carries no tool line", () => {
    expect(view([link(7)])).not.toContain("approved");
  });
  const lists = (d: CardDev | null | undefined) => renderToStaticMarkup(React.createElement(JiraDevLists, { dev: d }));
  test("nothing for null, for undefined, and for a tool that holds only pull requests", () => {
    expect(lists(null)).toBe("");
    expect(lists(undefined)).toBe("");
    expect(lists(dev({ counts: { pullRequests: 2, branches: 0, commits: 0, builds: 0 }, prs: [pr(1), pr(2)] }))).toBe("");
  });
  test("branches, commits and builds each get a group, and the ones the site counted past the rows say how many are left", () => {
    const html = lists(dev({
      counts: { pullRequests: 0, branches: 1, commits: 25, builds: 2 }, buildsPassed: 1, buildsFailed: 1,
      branches: [{ name: "feature/ORBIT-1042-retry", url: "", repo: "acme/orbit" }],
      commits: Array.from({ length: 20 }, (_, i) => ({ id: `abc${String(i).padStart(4, "0")}`, message: `step ${i}`, url: "", at: i })),
      builds: [{ name: "ci", url: "", state: "passed", at: 2 }, { name: "lint", url: "", state: "failed", at: 1 }],
    }));
    for (const said of ["Branches", "feature/ORBIT-1042-retry", "Commits", "and 5 more on the site", "Builds · 1 passed, 1 failed", "passed", "failed"]) expect(html).toContain(said);
    expect(html).not.toContain("<a ");
  });
  test("a branch name is text, never markup", () => {
    const html = lists(dev({ counts: { pullRequests: 0, branches: 1, commits: 0, builds: 0 }, branches: [{ name: "<img src=x onerror=alert(1)>", url: "", repo: "" }] }));
    expect(html).not.toContain("<img");
  });
});

/*
 * The picker decision for Settings ▸ Orchestration ▸ Session start: which
 * status names the row offers, from the same read the Jira workflow map page
 * already holds — and what it falls back to when that read failed.
 */
import { describe, expect, test } from "bun:test";
import { sessionStartStatusNames } from "../src/lib/sessionStartMoveStatus.ts";
import type { UnitsState } from "../src/lib/jiraUnits.ts";
import type { JiraUnit } from "../../shared/jiraStatusUnits.ts";

const UNITS: JiraUnit[] = [
  { id: "ORBIT", name: "Orbit core", statuses: [{ status: "Queued", type: "open" }, { status: "Building", type: "open" }, { status: "Shipped", type: "done" }] },
  { id: "DOCS", name: "Orbit docs", statuses: [{ status: "Drafting", type: "open" }, { status: "Building", type: "open" }] },
];

describe("sessionStartStatusNames", () => {
  test("a good read: every status, deduped across projects, sorted — the picker is offered", () => {
    const state: UnitsState = { kind: "ok", units: UNITS, at: Date.now(), counted: [] };
    expect(sessionStartStatusNames(state)).toEqual(["Building", "Drafting", "Queued", "Shipped"]);
  });

  test("still loading, nothing held yet: no names, so the row falls back to free text", () => {
    expect(sessionStartStatusNames({ kind: "loading" })).toEqual([]);
  });

  test("the tracker could not be read, and nothing was held before: no names, free text", () => {
    expect(sessionStartStatusNames({ kind: "error", error: "Jira is not connected", throttled: false })).toEqual([]);
  });

  test("the tracker could not be read, but an earlier good read is still held: that stale list is offered, not free text", () => {
    const state: UnitsState = { kind: "error", error: "Could not reach Jira", throttled: false, stale: UNITS, staleAt: Date.now() - 1000 };
    expect(sessionStartStatusNames(state)).toEqual(["Building", "Drafting", "Queued", "Shipped"]);
  });

  test("the tracker answered with no projects at all: no names, free text", () => {
    expect(sessionStartStatusNames({ kind: "empty", at: Date.now() })).toEqual([]);
  });
});

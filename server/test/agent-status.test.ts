// "How are we": card | role | state | next, off the board's own BoardRow and
// the project's flow — pure, no server, no board.
import { describe, expect, test } from "bun:test";
import { nextRoleAfter, statusReadout, statusRows } from "../src/agentStatus.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import type { BoardRow } from "../src/agentboard.ts";
import type { Flow } from "../../shared/flow.ts";

const flow: Flow = templateFlow();
const PATH = flow.path;

const row = (over: Partial<BoardRow>): BoardRow => ({ name: "builder-1", from: "seen", state: "working", ...over });

describe("nextRoleAfter", () => {
  test("the step after the first role on the path", () => {
    expect(nextRoleAfter(flow, PATH[0])).toBe(flow.roster.find((r) => r.id === PATH[1])!.name);
  });
  test("the last role on the path: done", () => {
    expect(nextRoleAfter(flow, PATH[PATH.length - 1])).toBe("done");
  });
  test("a role not on the path: nothing to say", () => {
    expect(nextRoleAfter(flow, "no-such-role")).toBe("");
  });
  test("no role at all: nothing to say", () => {
    expect(nextRoleAfter(flow, undefined)).toBe("");
  });
});

describe("statusRows", () => {
  test("a worker on a card: its card id, role name, state, and the next step", () => {
    const builder = PATH[0]!, next = flow.roster.find((r) => r.id === PATH[1])!.name;
    const rows = statusRows([row({ branch: "ORBIT-1042-fix-x", worker: { role: builder, since: 1 } })], flow);
    expect(rows).toEqual([{ card: "ORBIT-1042", role: flow.roster.find((r) => r.id === builder)!.name, state: "working", next }]);
  });

  test("a worker stopped on a person: next says so, whatever the path says comes next", () => {
    const builder = PATH[0]!;
    const rows = statusRows([row({
      branch: "ORBIT-1042-fix-x", worker: { role: builder, since: 1 },
      needsYou: { kind: "input", why: "which plan?", since: 1 },
    })], flow);
    expect(rows[0]!.next).toBe("waiting on person");
    expect(rows[0]!.state).toBe("waiting on person");
  });

  test("a branch with no card id prefix: left out", () => {
    expect(statusRows([row({ branch: "fix-the-thing" })], flow)).toEqual([]);
  });

  test("no branch at all: left out", () => {
    expect(statusRows([row({})], flow)).toEqual([]);
  });

  test("the Lantern's own row (role set): left out, it is not a card", () => {
    expect(statusRows([row({ branch: "ORBIT-1042-fix-x", role: "lantern" })], flow)).toEqual([]);
  });
});

describe("statusReadout", () => {
  test("empty board: one line, no header over nothing", () => {
    expect(statusReadout([])).toBe("No card has a worker on it right now.");
  });
  test("a row: header, a rule, the row, columns aligned", () => {
    const out = statusReadout([{ card: "ORBIT-1042", role: "Builder", state: "working", next: "Reviewer" }]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("card        role     state    next    ");
    expect(lines[2]).toBe("ORBIT-1042  Builder  working  Reviewer");
  });
});

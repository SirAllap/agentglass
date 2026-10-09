/*
 * What the card screen promises about its Assignees row, asserted against its
 * source (there is no renderer here).
 *
 *   - The row opens the sheet only for a phone that may write, and a locked row
 *     has no handler at all.
 *   - The row sits in the field block under Status; the switch for yourself and
 *     its `/clickup/assign` toggle are gone, because faces and names replace it.
 *   - Everything staged goes out as ONE request, and an "apply anyway" after a
 *     refusal sends the stamp the dialog was built from.
 *   - The sheet is the shared one, used through its existing props.
 */
import { describe, expect, test } from "bun:test";

const read = async (path: string): Promise<string> =>
  (await Bun.file(new URL(path, import.meta.url)).text()).split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

const screen = await read("../app/card/[id].tsx");
const sheet = await read("../src/cards/AssigneeSheet.tsx");

describe("the assignees row", () => {
  test("has a handler only when the phone may edit, and reads the members then", () => {
    expect(screen).toMatch(/onPress=\{assign\.can && !busy \? \(\) => \{ setAssigning\(true\); void readRoster\(\); \} : undefined\}/);
  });

  test("shows a lock, not a chevron, when the phone may not", () => {
    expect(screen).toContain('assign.can ? "chevron" : assign.why ? "lock" : null');
  });

  test("lives in the field block, between Status and List", () => {
    const status = screen.indexOf('label="Status"'), who = screen.indexOf('label="Assignees"'), list = screen.indexOf('label="List"');
    expect(status).toBeGreaterThan(0);
    expect(who).toBeGreaterThan(status);
    expect(list).toBeGreaterThan(who);
  });

  test("the self-assign switch is gone", () => {
    expect(screen).not.toContain("/clickup/assign");
    expect(screen).not.toContain("Assigned to you");
    expect(screen).not.toContain("<Switch");
  });
});

describe("the write", () => {
  test("is one request carrying both lists and the stamp", () => {
    expect(screen).toContain('"/clickup/card"');
    expect(screen).toContain("updated: how.stamp ?? card.updated, add: diff.add, rem: diff.rem");
    expect(screen.match(/"\/clickup\/card"/g)).toHaveLength(1);
  });

  test("apply anyway sends the stamp of the card the dialog described", () => {
    expect(screen).toContain("void apply(a.diff, { stamp: a.stamp })");
    expect(screen).toContain("stamp: theirs.updated");
  });

  test("keeping theirs writes nothing", () => {
    expect(screen).toContain("onKeep={() => { setConflict(null); setAssignConflict(null); }}");
  });

  test("undo goes through the same write, marked so it is not undone in its turn", () => {
    expect(screen).toContain("void apply(undoPeople, { undo: true })");
  });
});

describe("the sheet", () => {
  test("uses the shared Sheet through its existing props", () => {
    expect(sheet).toMatch(/<Sheet\s+open=\{open\}\s+onClose=\{onClose\}\s+tall\s+title="Assignees"\s+subtitle=/);
    expect(sheet).toContain("footer={(");
  });

  test("the footer says how long undo lasts from the snackbar's own number", () => {
    expect(sheet).toContain("{SNACK_MS / 1000}");
    expect(sheet).not.toMatch(/undo for 8/);
  });
});

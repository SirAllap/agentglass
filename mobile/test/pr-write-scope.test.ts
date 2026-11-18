/*
 * The PR writes are drawn at the level a pairing can act, and the ones that
 * cannot be undone hold.
 *
 * There is no renderer in this project, and the rule here IS the screen: a
 * `read` phone sees the rows and the reason rather than a control that
 * vanishes, a missing `mayWrite` on a write is the 403 mid-gesture the scope
 * model exists to prevent, and close/reopen/update-branch are Holds while
 * labels, reviewers, draft and edit are taps. Asserted against source, the way
 * `checks-ask-claude.test.ts` asserts the one rule that is a screen.
 */
import { describe, expect, test } from "bun:test";
import { holdsToConfirm } from "../src/model/confirmPolicy.ts";

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();
const detail = await read("../app/pr/[number].tsx");
const checks = await read("../app/pr/checks.tsx");
const prs = await read("../app/(tabs)/prs.tsx");
const manage = await read("../src/review/PrActionsSheet.tsx");
const labels = await read("../src/review/LabelsSheet.tsx");
const reviewers = await read("../src/review/ReviewersSheet.tsx");
const sync = await read("../src/review/SyncSheet.tsx");

/** Source with whole-line comments removed, so a rule cannot pass by being written down. */
const code = (src: string): string =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("a read phone sees the writes, disabled, with the reason", () => {
  test("the pull request derives the block from the pairing's scope", () => {
    expect(code(detail)).toContain("writeBlocked(host.scope)");
    expect(code(detail)).toContain("blocked={blocked}");
  });

  test("every row of the manage sheet is drawn and disabled", () => {
    const body = code(manage);
    const disabled = body.match(/disabled=\{!!blocked\}/g) ?? [];
    // Ask the agent, Labels, Edit, Draft, Close, and Reviewers (drawn by the row loop).
    expect(disabled.length).toBeGreaterThanOrEqual(5);
    expect(body).toContain('row.id === "reviewers" && !!blocked');
    expect(body).toContain("<Note tone=\"bad\">{blocked}</Note>");
  });

  test("the label and reviewer saves are gated as well", () => {
    for (const body of [code(labels), code(reviewers)]) {
      expect(body).toContain("disabled={!mayWrite");
    }
    expect(code(sync)).toContain("disabled={!mayWrite");
  });

  test("re-running the checks is behind the full grant, and says why on a read phone", () => {
    const body = code(checks);
    expect(body).toContain("/prs/rerun");
    const at = body.indexOf('"/prs/rerun"');
    expect(body.slice(Math.max(0, at - 900), at)).toContain("mayWrite");
    expect(body).toContain("needs a phone paired with Everything");
  });
});

describe("the writes that cannot be undone hold", () => {
  test("merge, close and reopen, and a branch update are holds", () => {
    expect(holdsToConfirm("pr.merge")).toBe(true);
    expect(holdsToConfirm("pr.close")).toBe(true);
    expect(holdsToConfirm("pr.reopen")).toBe(true);
    expect(holdsToConfirm("pr.branch.update")).toBe(true);
  });

  test("the screens use HoldButton for exactly those three", () => {
    expect(code(detail)).toContain('action="pr.merge"');
    expect(code(manage)).toContain('action={close.verb === "close" ? "pr.close" : "pr.reopen"}');
    expect(code(sync)).toContain('action="pr.branch.update"');
  });

  test("labels, reviewers, draft and edit are one tap, so their sheets carry no hold", () => {
    expect(code(labels)).not.toContain("HoldButton");
    expect(code(reviewers)).not.toContain("HoldButton");
    const body = code(manage);
    const draft = body.slice(body.indexOf("if (mode === \"draft\")"), body.indexOf("if (mode === \"edit\")"));
    expect(draft).toContain("<Btn");
    expect(draft).not.toContain("HoldButton");
  });
});

describe("a lane sync is N single syncs, never a bulk route", () => {
  test("the board offers it on the landing lane and opens the same sheet", () => {
    const body = code(prs);
    expect(body).toContain("onSyncLane={setLaneSync}");
    expect(body).toContain("<SyncSheet");
    expect(code(sync)).toContain("/prs/update-branch");
  });

  test("the sheet loops over the branches rather than posting once for the lane", () => {
    const body = code(sync);
    expect(body).toContain("for (const t of rows)");
    expect(body).not.toContain("sync-lane");
    expect(body).not.toContain("/prs/bulk");
  });
});

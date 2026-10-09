/*
 * A step's blocks as the server keeps them: validated the way the screen
 * validates them, written beside the three keys they replaced, and read back
 * from a file that only has those keys.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "../src/clickupPrefs.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-blocks-"));
const file = join(dir, "clickup-prefs.json");
afterAll(() => { P.__setPrefsPath(null); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { rmSync(file, { force: true }); P.__setPrefsPath(file); });

const save = (patch: unknown) => P.setClickupPrefs(patch);
const person = { who: "person" as const, person: { id: 8, name: "Sam Rivera" } };

describe("saving blocks", () => {
  test("a list is stored in order and the three old keys follow it", () => {
    const r = save({ handoff: { enabled: true, blocks: [{ type: "assign", who: "author" }, { type: "move", statusNames: ["Ready for QA"] }, { type: "unassign", who: "all" }] } });
    expect(r.ok).toBe(true);
    P.__setPrefsPath(file);
    const h = P.clickupPrefs().handoff;
    expect(h.blocks!.map((b) => b.type)).toEqual(["assign", "move", "unassign"]);
    expect(h).toMatchObject({ enabled: true, statusNames: ["Ready for QA"], unassign: "all", assign: { who: "author" } });
  });
  test("a person is kept whole and the block's kind is not part of the assignment", () => {
    save({ merge: { enabled: true, blocks: [{ type: "assign", ...person }] } });
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().merge.assign).toEqual(person);
    expect(P.clickupPrefs().merge.blocks).toEqual([{ type: "assign", ...person }]);
  });
  test("a step with no move block has no status names, so nothing reads it as the built-in guess for the old keys' reader", () => {
    save({ handoff: { enabled: true, blocks: [{ type: "assign", who: "me" }] } });
    expect(P.clickupPrefs().handoff.statusNames).toEqual([]);
    expect(P.clickupPrefs().handoff.blocks).toEqual([{ type: "assign", who: "me" }]);
  });
  test("removing a step clears its blocks and what the old keys held", () => {
    save({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["qa"] }, { type: "unassign", who: "me" }] } });
    save({ handoff: { enabled: false, blocks: [] } });
    expect(P.clickupPrefs().handoff).toEqual({ enabled: false, blocks: [], statusNames: [], unassign: "none", assign: { who: "none" } });
  });
});

describe("what is refused, and nothing is written", () => {
  const refused = (patch: unknown, why: RegExp) => {
    const before = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
    const r = save(patch);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(why);
    const after = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
    expect(after).toBe(before);
  };
  test("taking people off on a review item or the merge dialog", () => {
    refused({ review: { blocks: [{ type: "unassign", who: "all" }] } }, /review menu item/);
    refused({ merge: { blocks: [{ type: "unassign", who: "me" }] } }, /merge dialog/);
  });
  test("two of a kind, an unknown kind, a kind not built yet, an unknown key", () => {
    refused({ handoff: { blocks: [{ type: "move", statusNames: ["a"] }, { type: "move", statusNames: ["b"] }] } }, /Already in this step/);
    refused({ handoff: { blocks: [{ type: "teleport" }] } }, /must be move, unassign or assign/);
    refused({ handoff: { blocks: [{ type: "comment" }] } }, /must be move, unassign or assign/);
    refused({ handoff: { blocks: [{ type: "move", statusNames: ["a"], colour: "red" }] } }, /colour is not a setting/);
  });
  test("an assign that assigns nobody, a person without an id, a list that is not a list, too many", () => {
    refused({ handoff: { blocks: [{ type: "assign", who: "none" }] } }, /remove the block/);
    refused({ handoff: { blocks: [{ type: "assign", who: "person", person: { name: "Sam" } }] } }, /member id/);
    refused({ handoff: { blocks: "move" } }, /must be a list of blocks/);
    refused({ handoff: { blocks: Array(9).fill({ type: "assign", who: "me" }) } }, /more than 8/);
  });
  test("blocks and old keys in one save must agree", () => {
    refused({ handoff: { blocks: [{ type: "move", statusNames: ["qa"] }], statusNames: ["other"] } }, /says something different/);
    expect(save({ handoff: { blocks: [{ type: "move", statusNames: ["qa"] }], statusNames: ["qa"] } }).ok).toBe(true);
  });
});

describe("the old shape still reads and still writes", () => {
  test("a file with only the three keys reads as the same step, in blocks", () => {
    writeFileSync(file, JSON.stringify({ handoff: { enabled: true, statusNames: ["ready for qa"], unassign: "all", assign: { who: "me" } } }));
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().handoff.blocks).toEqual([{ type: "move", statusNames: ["ready for qa"] }, { type: "unassign", who: "all" }, { type: "assign", who: "me" }]);
  });
  test("an old key saved on its own rewrites the blocks from it, so the two never disagree", () => {
    save({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["qa"] }, { type: "assign", who: "me" }] } });
    save({ handoff: { unassign: "all" } });
    expect(P.clickupPrefs().handoff.blocks).toEqual([{ type: "move", statusNames: ["qa"] }, { type: "unassign", who: "all" }, { type: "assign", who: "me" }]);
  });
  test("old keys edited by hand to disagree with the blocks: the blocks win, the step is not lost", () => {
    save({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["qa"] }, { type: "assign", who: "me" }] } });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.handoff.statusNames = ["something else"];
    writeFileSync(file, JSON.stringify(disk));
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().handoff).toMatchObject({ enabled: true, statusNames: ["qa"], assign: { who: "me" }, blocks: [{ type: "move", statusNames: ["qa"] }, { type: "assign", who: "me" }] });
  });
  test("what is written on disk carries both, and reading it back gives the same blocks", () => {
    save({ review: { enabled: true, blocks: [{ type: "move", statusNames: ["code review"] }, { type: "assign", who: "author" }] } });
    const disk = JSON.parse(readFileSync(file, "utf8")).review;
    expect(disk).toMatchObject({ statusNames: ["code review"], assign: { who: "author" }, blocks: [{ type: "move" }, { type: "assign" }] });
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().review.blocks).toEqual(disk.blocks);
  });
  test("a first start with a token seeds the blocks the keys mean", () => {
    expect(P.settleFirstRun(true)).toBe("seeded");
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().handoff.blocks).toEqual([{ type: "move", statusNames: [], fallback: true }, { type: "unassign", who: "all" }]);
  });
});

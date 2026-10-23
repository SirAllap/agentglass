/*
 * What a staged Finder operation says and runs (lib/finderStage.ts), without a
 * dialog: every path is named in the words, and the request body is the one the
 * menu sends for the same act.
 */
import { describe, expect, it } from "bun:test";
import { FINDER_STAGE_NEEDS, FINDER_STAGE_OPS } from "../../shared/uiActions.ts";
import { stageConfirm, stagePaths, stageRun, stageSentence, type FinderStageArgs } from "../src/lib/finderStage.ts";

const A = (a: Record<string, unknown>) => a as unknown as FinderStageArgs;

describe("the words", () => {
  it("name what moves and where", () => {
    expect(stageSentence(A({ op: "trash", path: "/home/acme/notes.txt" }))).toBe("move notes.txt to the trash");
    expect(stageSentence(A({ op: "move", path: "/home/acme/notes.txt", dest: "/home/acme/docs" }))).toBe("move notes.txt to docs");
    expect(stageSentence(A({ op: "copy", path: "/home/acme/notes.txt", dest: "/home/acme/docs" }))).toBe("copy notes.txt to docs");
    expect(stageSentence(A({ op: "rename", path: "/home/acme/notes.txt", name: "plan.txt" }))).toBe("rename notes.txt to plan.txt");
    expect(stageSentence(A({ op: "new-folder", path: "/home/acme/docs", name: "archive" }))).toBe("create a folder called archive in docs");
    expect(stageSentence(A({ op: "duplicate", path: "/home/acme/notes.txt" }))).toBe("duplicate notes.txt");
  });
  it("list every full path the operation touches", () => {
    expect(stagePaths(A({ op: "move", path: "/home/acme/notes.txt", dest: "/home/acme/docs" }))).toEqual(["Item: /home/acme/notes.txt", "Into: /home/acme/docs"]);
    expect(stagePaths(A({ op: "new-folder", path: "/home/acme/docs", name: "archive" }))).toEqual(["In: /home/acme/docs", "Name: archive"]);
  });
  it("every operation has a button label, and one that needs an argument has a sentence that uses it", () => {
    for (const op of FINDER_STAGE_OPS) {
      expect(stageConfirm(op), op).not.toBe("");
      const need = FINDER_STAGE_NEEDS[op];
      const args = A({ op, path: "/a/b", dest: "/a/dest", name: "nm" });
      if (need) expect(stageSentence(args), op).toContain(need === "dest" ? "dest" : "nm");
    }
  });
});

describe("the run", () => {
  it("is the body the menu sends, with the folders to reload", () => {
    expect(stageRun(A({ op: "trash", path: "/home/acme/notes.txt" }))).toEqual({ body: { op: "trash", paths: ["/home/acme/notes.txt"] }, dirs: ["/home/acme"], name: "notes.txt" });
    expect(stageRun(A({ op: "move", path: "/home/acme/notes.txt", dest: "/home/acme/docs" }))).toEqual({
      body: { op: "move", paths: ["/home/acme/notes.txt"], dest: "/home/acme/docs", conflict: "keep-both" }, dirs: ["/home/acme", "/home/acme/docs"], name: "notes.txt",
    });
    expect(stageRun(A({ op: "rename", path: "/home/acme/notes.txt", name: "plan.txt" })).body).toEqual({ op: "rename", path: "/home/acme/notes.txt", name: "plan.txt" });
    expect(stageRun(A({ op: "new-folder", path: "/home/acme/docs", name: "archive" }))).toEqual({ body: { op: "mkdir", parent: "/home/acme/docs", name: "archive" }, dirs: ["/home/acme/docs"], name: "archive" });
    expect(stageRun(A({ op: "duplicate", path: "/notes.txt" })).dirs).toEqual(["/"]);
  });
  it("never produces an irreversible operation", () => {
    for (const op of FINDER_STAGE_OPS) expect(["delete", "empty-trash"]).not.toContain(stageRun(A({ op, path: "/a/b", dest: "/a/d", name: "n" })).body.op);
  });
});

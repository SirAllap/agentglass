import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Three git actions threw work away on a single click: squash rewrites local
 * history (back only through the reflog), aborting a conflicted merge drops
 * the answers already given, and restoring a snapshot lays its tree over the
 * working tree. Each now goes through the same `ask` dialog as Discard and
 * Delete branch. Source-level lock: these are closures in a hook-heavy
 * component and there is no renderer in this project.
 */
const src = readFileSync(new URL("../src/components/GitPanel.tsx", import.meta.url), "utf8");

const fnBody = (head: string): string => {
  const a = src.indexOf(head);
  expect(a).toBeGreaterThan(-1);
  const brace = src.indexOf("{", src.indexOf("=>", a));
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(brace, i + 1);
  }
  throw new Error("unbalanced: " + head);
};

describe("destructive git actions ask first", () => {
  test("squashPicked asks (danger) before api.gitSquash", () => {
    const body = fnBody("const squashPicked = async");
    const askAt = body.indexOf("await ask(");
    expect(askAt).toBeGreaterThan(-1);
    expect(body.indexOf("danger: true", askAt)).toBeGreaterThan(askAt);
    expect(body.indexOf("api.gitSquash(")).toBeGreaterThan(askAt);
  });

  test("abortMerge asks (danger) before api.gitMergeAbort, only when answers would be lost", () => {
    const body = fnBody("const abortMerge = async");
    const askAt = body.indexOf("await ask(");
    expect(askAt).toBeGreaterThan(-1);
    expect(body).toContain("danger: true");
    expect(body.indexOf("api.gitMergeAbort(")).toBeGreaterThan(askAt);
    expect(body).toContain("api.gitMergeSession(");
  });

  test("the abort button calls abortMerge, not the api directly", () => {
    expect(src).toMatch(/onClick=\{abortMerge\}/);
    expect(src).not.toMatch(/onClick=\{\(\) => act\(\(\) => api\.gitMergeAbort/);
  });

  test("snapshot restore asks (danger) before api.gitSnapshotRestore", () => {
    const body = fnBody("const restoreSnapshot = async");
    const askAt = body.indexOf("await ask(");
    expect(askAt).toBeGreaterThan(-1);
    expect(body).toContain("danger: true");
    expect(body.indexOf("api.gitSnapshotRestore(")).toBeGreaterThan(askAt);
    expect(src).toMatch(/restoreSnapshot\(s\.sha\)/);
    expect(src).not.toMatch(/onClick=\{\(\) => act\(\(\) => api\.gitSnapshotRestore/);
  });
});

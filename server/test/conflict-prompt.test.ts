import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickConflictModel, resolveConflictModel } from "../../shared/conflictModel.ts";
import { conflictRecipe, saveReviewRecipe, removeReviewRecipe, resetReviewRecipe, reviewRecipes, __setReviewPromptsPath, __clearReviewPrompts } from "../src/reviewPrompts.ts";
import { conflictPrompt, countHunks } from "../src/conflictPrompt.ts";
import { modelFlags } from "../src/terminal.ts";
import { CONFLICT_ASK } from "../../shared/conflictAsk.ts";

/*
 * The conflict button's prompt lives in the review-prompts store, so what needs
 * holding is the part that is new: which prompt a project gets, what the
 * placeholders say about a conflict, and which model the conflict deserves.
 * A lockfile the two sides regenerated must not open on the biggest model, and
 * a migration must not open on the smallest.
 */
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-conflict-prompt-"));
  __setReviewPromptsPath(join(dir, "review-prompts.json"));
});
afterAll(() => {
  __setReviewPromptsPath(null);
  __clearReviewPrompts();
  rmSync(dir, { recursive: true, force: true });
});

const mine = (over: Record<string, unknown>) =>
  saveReviewRecipe({ id: "", title: "Mine", body: "regenerate uv.lock, never merge it", group: "conflicts", when: "any", ...over } as never);

test("with nothing written, a conflict gets the built-in ask", () => {
  expect(conflictRecipe("/code/orbit").body).toBe(CONFLICT_ASK.join("\n"));
});

test("a prompt for one project wins there and nowhere else", () => {
  const r = mine({ repo: "/code/orbit" });
  expect(r.ok).toBe(true);
  expect(conflictRecipe("/code/orbit").title).toBe("Mine");
  expect(conflictRecipe("/code/acme").body).toBe(CONFLICT_ASK.join("\n"));
  removeReviewRecipe(r.recipe!.id);
});

test("a prompt for every project beats the built-in, and a project's own beats both", () => {
  const all = mine({ title: "Everywhere" });
  const one = mine({ title: "Orbit only", repo: "/code/orbit" });
  expect(conflictRecipe("/code/acme").title).toBe("Everywhere");
  expect(conflictRecipe("/code/orbit").title).toBe("Orbit only");
  removeReviewRecipe(all.recipe!.id);
  removeReviewRecipe(one.recipe!.id);
});

test("hiding the built-in still leaves a conflict something to say", () => {
  removeReviewRecipe("conflicts");
  expect(reviewRecipes().some((r) => r.id === "conflicts")).toBe(false);
  expect(conflictRecipe("/code/orbit").body).toBe(CONFLICT_ASK.join("\n"));
  resetReviewRecipe("conflicts");
});

test("repo, model and effort are kept on a conflict prompt and dropped on any other", () => {
  const c = mine({ repo: "/code/orbit", model: "opus", effort: "high" }).recipe!;
  expect([c.repo, c.model, c.effort]).toEqual(["/code/orbit", "opus", "high"]);
  const other = saveReviewRecipe({ id: "", title: "Review", body: "x", group: "reviewing", when: "any", repo: "/code/orbit", model: "opus" } as never).recipe!;
  expect([other.repo, other.model]).toEqual([undefined, undefined]);
  removeReviewRecipe(c.id);
  removeReviewRecipe(other.id);
});

test("a garbage model is not stored", () => {
  const r = mine({ model: "gpt-9", effort: "extreme" }).recipe!;
  expect([r.model, r.effort]).toEqual([undefined, undefined]);
  removeReviewRecipe(r.id);
});

test("the built-in can be pinned to a model and reset", () => {
  const b = reviewRecipes().find((r) => r.id === "conflicts")!;
  saveReviewRecipe({ ...b, model: "haiku" });
  expect(conflictRecipe("/x").model).toBe("haiku");
  resetReviewRecipe("conflicts");
  expect(conflictRecipe("/x").model).toBeUndefined();
});

test("model: lockfiles are small, a migration is not, and the count of hunks tips it", () => {
  expect(pickConflictModel({ files: ["uv.lock", "web/pnpm-lock.yaml", "app/baml_client/types.py"] }).model).toBe("haiku");
  expect(pickConflictModel({ files: ["src/a.ts", "src/b.ts"], hunks: 3 })).toMatchObject({ model: "sonnet", effort: "medium" });
  expect(pickConflictModel({ files: ["db/migrations/0004_orders.py"] })).toMatchObject({ model: "opus", effort: "medium" });
  expect(pickConflictModel({ files: ["src/a.ts"], hunks: 9 }).model).toBe("opus");
  expect(pickConflictModel({ files: ["a", "b", "c", "d", "e", "f", "g"].map((x) => `src/${x}.ts`) }).model).toBe("opus");
  // a lockfile beside one small source file is still a small conflict
  expect(pickConflictModel({ files: ["uv.lock", "src/a.ts"], hunks: 1 }).model).toBe("sonnet");
});

test("model: a pinned model wins, `auto` does not", () => {
  const pick = pickConflictModel({ files: ["src/a.ts"], hunks: 1 });
  expect(resolveConflictModel({ model: "opus", effort: "auto" }, pick)).toMatchObject({ model: "opus", effort: "medium", why: "model set on the prompt; effort from the conflict" });
  expect(resolveConflictModel({ model: "opus", effort: "high" }, pick).why).toBe("set on the prompt");
  expect(resolveConflictModel({ model: "auto" }, pick)).toEqual(pick);
  expect(resolveConflictModel({}, pick)).toEqual(pick);
});

test("hunks are counted in the worktree, and only there", () => {
  mkdirSync(join(dir, "wt/src"), { recursive: true });
  writeFileSync(join(dir, "wt/src/a.ts"), "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\nok\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n");
  writeFileSync(join(dir, "outside.ts"), "<<<<<<< HEAD\n");
  expect(countHunks(join(dir, "wt"), ["src/a.ts", "missing.ts"])).toBe(2);
  expect(countHunks(join(dir, "wt"), ["../outside.ts", join(dir, "outside.ts")])).toBe(0);
});

/** A project and one linked worktree of it, laid out the way git leaves them. */
function projectWithWorktree(name: string): { project: string; worktree: string } {
  const project = join(dir, name);
  const worktree = join(dir, `${name}-conflict-x`);
  mkdirSync(join(project, ".git/worktrees/x"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${project}/.git/worktrees/x\n`);
  return { project, worktree };
}

test("the ask is filled in from the conflict: base, files, worktree", () => {
  const { project, worktree } = projectWithWorktree("orbit");
  const r = mine({ repo: project, body: "Merge {base} into {branch} (#{number}) in {worktree}:\n{files}" }).recipe!;
  const out = conflictPrompt({ worktree, files: ["a.ts", "b.ts"], number: 12, branch: "feat/x", base: "main" });
  expect(out.ask).toBe(`Merge main into feat/x (#12) in ${worktree}:\na.ts\nb.ts`);
  expect(out.recipeId).toBe(r.id);
  removeReviewRecipe(r.id);
});

test("the project is worked out from the worktree, so a conflict worktree finds its project's prompt", () => {
  const a = projectWithWorktree("orbit-a");
  const b = projectWithWorktree("orbit-b");
  const r = mine({ repo: a.project, body: "only A" }).recipe!;
  expect(conflictPrompt({ worktree: a.worktree, files: [] }).ask).toBe("only A");
  expect(conflictPrompt({ worktree: b.worktree, files: [] }).ask).toBe(CONFLICT_ASK.join("\n"));
  removeReviewRecipe(r.id);
});

test("a skill is returned apart from the ask, for the caller to put first", () => {
  const { project, worktree } = projectWithWorktree("orbit-s");
  const r = mine({ repo: project, skill: "/base-merge {number}", body: "" }).recipe!;
  const out = conflictPrompt({ worktree, files: [], number: 7 });
  expect(out.skill).toBe("/base-merge 7");
  removeReviewRecipe(r.id);
});

test("choosing a project on the built-in saves a copy for it; the built-in stays global", () => {
  const b = reviewRecipes().find((r) => r.id === "conflicts")!;
  const res = saveReviewRecipe({ ...b, repo: "/code/orbit", body: "ONLY ORBIT" });
  expect(res.ok).toBe(true);
  expect(res.recipe!.id).not.toBe("conflicts");
  expect(conflictRecipe("/code/orbit").body).toBe("ONLY ORBIT");
  expect(conflictRecipe("/code/other").body).toBe(CONFLICT_ASK.join("\n"));
  expect(reviewRecipes().find((r) => r.id === "conflicts")!.body).toBe(CONFLICT_ASK.join("\n"));
  expect(reviewRecipes().find((r) => r.id === "conflicts")!.repo).toBeUndefined();
  removeReviewRecipe(res.recipe!.id);
});

test("a lockfile's hunks do not push a small hand conflict up to the big model", () => {
  const wt = join(dir, "lock-wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "a.ts"), "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n");
  writeFileSync(join(wt, "package-lock.json"), "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n".repeat(30));
  const out = conflictPrompt({ worktree: wt, files: ["a.ts", "package-lock.json"] });
  expect(out.model).toBe("sonnet");
});

test("hunks are not counted through a symlink out of the worktree, and a FIFO is not opened", () => {
  const wt = join(dir, "link-wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(dir, "secret.txt"), "<<<<<<< HEAD\n");
  symlinkSync(join(dir, "secret.txt"), join(wt, "link.ts"));
  const fifo = Bun.spawnSync(["mkfifo", join(wt, "pipe.ts")]);
  expect(fifo.exitCode).toBe(0);
  expect(countHunks(wt, ["link.ts", "pipe.ts"])).toBe(0);
});

test("the reason says which half was pinned", () => {
  const pick = pickConflictModel({ files: ["uv.lock"] });
  expect(resolveConflictModel({ model: "opus" }, pick).why).toBe("model set on the prompt; effort from the conflict");
  expect(resolveConflictModel({ effort: "high" }, pick).why).toBe("effort set on the prompt; model from the conflict");
});

test("the flags for a model are the server's, from an allowlist", () => {
  expect(modelFlags("sonnet", "medium")).toEqual(["--model", "sonnet", "--effort", "medium"]);
  expect(modelFlags("sonnet; rm -rf ~", "max")).toEqual([]);
  expect(modelFlags(undefined, undefined)).toEqual([]);
  expect(modelFlags("", "low")).toEqual(["--effort", "low"]);
});

test("the conflict route is matched before the /pr-prompts/ family, whose prefix would answer not-found", async () => {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const mine = src.indexOf('pathname === "/pr-prompts/conflict"');
  const family = src.indexOf('pathname.startsWith("/pr-prompts/")');
  expect(mine).toBeGreaterThan(0);
  expect(family).toBeGreaterThan(mine);
});

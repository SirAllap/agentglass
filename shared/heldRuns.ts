/**
 * Workflow runs GitHub holds for a maintainer's approval.
 *
 * A pull request from a fork, by somebody who has not contributed before, gets
 * its workflow runs created with status `action_required` and nothing runs
 * until a maintainer presses "Approve workflows to run". Its required checks
 * then never report, and the plain reading of that — "nothing is running, the
 * author should push" — is wrong twice: nobody has to push, and the move is the
 * maintainer's. These are the words and the decision for that case, kept here
 * so the merge box, the blocker list and the card menu say the same thing.
 */

export interface HeldRun {
  id: number;
  /** The workflow's name, as the runs list gives it. */
  name: string;
}

/** The runs in a `GET /actions/runs` answer that wait for approval. */
export function heldRunsOf(runs: unknown): HeldRun[] {
  if (!Array.isArray(runs)) return [];
  const out: HeldRun[] = [];
  const seen = new Set<number>();
  for (const r of runs as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") continue;
    const held = r.status === "action_required" || r.conclusion === "action_required";
    const id = Number(r.id);
    if (!held || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof r.name === "string" && r.name ? r.name : `run ${id}` });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The banner's sentence, without the closing full stop (callers add it). */
export function heldRunsTitle(n: number): string {
  return `Waiting for your approval to run ${plural(n, "workflow")} (a contributor's pull request)`;
}

/** What to do about it, under the banner and on the blocker row. */
export const HELD_RUNS_DETAIL =
  "GitHub holds the workflows of a contributor's pull request until a maintainer approves them. Read the change first: the workflows run its code.";

export const APPROVE_RUNS_LABEL = "Approve workflows to run";

/** GitHub's refusal of `POST /actions/runs/{id}/approve`, in plain words. */
export function approveRunsError(raw: string): string {
  const s = raw.trim();
  if (/HTTP 403|must have admin|not authorized|resource not accessible|forbidden/i.test(s)) {
    return "GitHub refused: only a maintainer of this repository can approve these workflows.";
  }
  if (/already|not waiting|cannot be approved|HTTP 422|HTTP 409/i.test(s)) {
    return "Already approved: nothing is waiting for approval any more.";
  }
  if (/HTTP 404|not found/i.test(s)) return "GitHub could not find that workflow run any more.";
  return s.split("\n")[0] || "GitHub did not approve the workflows.";
}

/**
 * Files this repository's workflows run by name, outside the patterns below
 * (`run:` lines of `.github/workflows/*.yml`, with their working directory).
 * web/test/held-runs.test.ts reads the workflows and fails when one is missing.
 */
export const WORKFLOW_RUN_FILES: readonly string[] = ["electron/build.mjs", "server/src/index.ts"];

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"]);

/**
 * The changed files that can change what CI runs, in the order given.
 *
 * Approving a contributor's workflows runs their code on this repository's
 * runners, and the files that decide what runs are the ones to read first:
 * the workflows and actions themselves, the build and test scripts they call,
 * the package manager's config and lockfiles (an install runs what they pin),
 * and Gradle's build files. `package.json` is listed whole: its scripts are
 * what `bun test` and friends run, and a file list cannot tell a scripts
 * change from a version bump.
 */
export function ciTouchingFiles(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const path = p.replace(/^\.\//, "");
    const base = path.slice(path.lastIndexOf("/") + 1);
    return path.startsWith(".github/")
      || base === "package.json"
      || /^(GNU)?makefile$/i.test(base)
      || /^Dockerfile(\..+)?$/.test(base) || base.endsWith(".Dockerfile")
      || base.startsWith("bun.lock") || base === "bunfig.toml" || LOCKFILES.has(base)
      || base === "action.yml" || base === "action.yaml"
      || base.endsWith(".gradle") || base.endsWith(".gradle.kts") || base === "gradlew" || base === "gradlew.bat"
      || path.startsWith("gradle/") || path.includes("/gradle/")
      || base.endsWith(".sh")
      || path.startsWith("scripts/") || path.includes("/scripts/")
      || WORKFLOW_RUN_FILES.includes(path);
  });
}

/** The banner's warning line, or null when no CI file changed. */
export function ciChangeLine(files: readonly string[]): string | null {
  if (!files.length) return null;
  const shown = files.slice(0, 4).join(", ");
  return `This pull request changes what CI runs: ${shown}${files.length > 4 ? ` +${files.length - 4} more` : ""}`;
}

/** GitHub cut the changed-file list short, so "no CI files changed" cannot be said. */
export function uncheckedFilesLine(listed: number, total: number): string {
  return `Could not check every file (GitHub listed ${listed} of ${total})`;
}

export const APPROVE_ANYWAY_LABEL = "Approve anyway";

/**
 * What the banner says before "Approve": the CI files the change touches, and
 * a line when GitHub listed only part of the changed files (`missing` of them
 * are not in `paths`). Empty means the whole list was read and nothing in it
 * changes what CI runs: the button approves at once. Anything here turns it
 * into "Approve anyway" — still one click, with the reason in front of it.
 */
export function heldRunsWarnings(paths: readonly string[], missing: number): string[] {
  const out: string[] = [];
  const ci = ciChangeLine(ciTouchingFiles(paths));
  if (ci) out.push(ci);
  if (missing > 0) out.push(uncheckedFilesLine(paths.length, paths.length + missing));
  return out;
}

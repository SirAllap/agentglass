/**
 * Reading and approving the workflow runs GitHub holds for a maintainer
 * (shared/heldRuns.ts says why they exist). The `gh` call is handed in, so the
 * approve path is tested against a fake GitHub with no process started.
 *
 * The run ids are always re-read here from the pull request's head, never taken
 * from the request: a click approves what is held on this pull request now, not
 * a list of ids a caller chose.
 */
import { approveRunsError, heldRunsOf, type HeldRun } from "../../shared/heldRuns.ts";

export type GhCall = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const firstLine = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n")[0] ?? "";

export async function readHeldRuns(call: GhCall, nameWithOwner: string, number: number): Promise<{ ok: boolean; runs: HeldRun[]; headSha?: string; error?: string }> {
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, runs: [], error: "invalid pull request number" };
  const head = await call(["api", `repos/${nameWithOwner}/pulls/${number}`, "--jq", ".head.sha"]);
  const sha = head.code === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, runs: [], error: firstLine(head) || "could not read the pull request's head" };
  const r = await call(["api", `repos/${nameWithOwner}/actions/runs?head_sha=${sha}&per_page=100`, "--jq", "[.workflow_runs[] | {id, name, status, conclusion}]"]);
  if (r.code !== 0) return { ok: false, runs: [], headSha: sha, error: firstLine(r) || "could not read the workflow runs" };
  let rows: unknown = [];
  try { rows = JSON.parse(r.stdout || "[]"); } catch { return { ok: false, runs: [], headSha: sha, error: "GitHub's answer was not JSON" }; }
  return { ok: true, runs: heldRunsOf(rows), headSha: sha };
}

/**
 * `headSha` is the head the panel showed when the person clicked, as `/prs/merge`
 * carries it: a contributor who pushes between the look and the click would
 * otherwise have the new, unread commit approved. It is required.
 */
export async function approveHeldRuns(call: GhCall, nameWithOwner: string, number: number, headSha: unknown): Promise<{ ok: boolean; approved: number; detail?: string; error?: string }> {
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(headSha)) return { ok: false, approved: 0, error: "The panel did not say which commit it showed. Look again." };
  const read = await readHeldRuns(call, nameWithOwner, number);
  if (!read.ok) return { ok: false, approved: 0, error: read.error };
  const live = (read.headSha ?? "").toLowerCase();
  if (!live.startsWith(headSha.toLowerCase())) {
    return { ok: false, approved: 0, error: `The pull request changed since you looked: ${headSha.slice(0, 7)} -> ${live.slice(0, 7)}. Look again.` };
  }
  if (!read.runs.length) return { ok: false, approved: 0, error: "Nothing is waiting for approval on this pull request." };
  let approved = 0;
  const errors: string[] = [];
  for (const run of read.runs) {
    const r = await call(["api", "--method", "POST", `repos/${nameWithOwner}/actions/runs/${run.id}/approve`]);
    if (r.code === 0) approved++;
    else errors.push(approveRunsError(firstLine(r)));
  }
  const n = read.runs.length;
  if (!approved) return { ok: false, approved, error: errors[0] ?? "GitHub did not approve the workflows." };
  const word = (k: number) => `${k} workflow${k === 1 ? "" : "s"}`;
  if (errors.length) return { ok: false, approved, error: `Approved ${approved} of ${n}. ${errors[0]}` };
  return { ok: true, approved, detail: `Approved ${word(approved)} to run` };
}

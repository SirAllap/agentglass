import { repoIdFor, mergeLockOf } from "./prs.ts";
import { dropLock, putLock, tickItem } from "./mergeLockStore.ts";
import { cleanLockInput, type MergeLock, type MergeLockState } from "../../shared/mergeLock.ts";

export type LockWriteResult =
  | { ok: true; lock: MergeLock | null; state: MergeLockState | null }
  | { ok: false; error: string; status?: number };

export const AGENT_REFUSED = "only the person can set, tick or lift a merge lock; an agent cannot.";

/**
 * The three writes on a merge lock: set or edit (`/prs/merge-lock`), tick one
 * item (`/tick`), and the override (`/unlock`, which needs the PR number typed
 * back). `person` is the Go/No-go test; when it is false every write is refused
 * before anything is read.
 */
export async function mergeLockWrite(pathname: string, b: Record<string, unknown>, person: boolean, who: string, now = Date.now()): Promise<LockWriteResult> {
  if (!person) return { ok: false, error: AGENT_REFUSED, status: 403 };
  const number = Number(b.number);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(b.root);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const after = async (): Promise<LockWriteResult> => {
    const l = await mergeLockOf(b.root, number);
    return { ok: true, lock: l?.lock ?? null, state: l?.state ?? null };
  };
  if (pathname === "/prs/merge-lock") {
    const c = cleanLockInput(b, number);
    if (!c.ok) return c;
    putLock({ repo: repo.key, pr: number, until: c.until, items: c.items, note: c.note, afterPr: c.afterPr, who, now });
    return after();
  }
  if (pathname === "/prs/merge-lock/tick") {
    const l = tickItem(repo.key, number, String(b.itemId ?? ""), b.done !== false, who, now);
    if (!l) return { ok: false, error: "no such item on this pull request's lock" };
    return after();
  }
  if (pathname === "/prs/merge-lock/unlock") {
    /* The override: typed, so a stray click cannot ship a rollout step early. */
    if (String(b.confirm ?? "").trim().replace(/^#/, "") !== String(number)) return { ok: false, error: `type ${number} to unlock now` };
    if (!dropLock(repo.key, number, "unlock-now", who, now)) return { ok: false, error: "this pull request has no merge lock" };
    return { ok: true, lock: null, state: null };
  }
  return { ok: false, error: "unknown merge lock route", status: 404 };
}

/**
 * The gate's half (index.ts `/gate`): an agent's own `gh pr merge <n>` in a
 * shell, or a GitHub MCP merge tool, never reaches mergePr — it goes straight
 * to GitHub. So the gate refuses it here while the lock holds, before anyone is
 * asked. Only a merge that names its number is matched: `gh pr merge` with no
 * number (the current branch's PR) is still held for the person as outward.
 * Cancelling auto-merge stays allowed, as in mergePr.
 */
export async function gateMergeLock(toolName: string, input: Record<string, unknown>, out: { kind: string; target?: string } | null, cwd: string): Promise<string | null> {
  if (out?.kind !== "merge" || !out.target || !/^\d+$/.test(out.target)) return null;
  let root = cwd;
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    if (!/\bgh\s+pr\s+merge\b/.test(cmd) || /--disable-auto\b/.test(cmd)) return null;
    const r = /(?:-R|--repo)[=\s]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(cmd);
    if (r) root = `gh:${r[1]}/${r[2]}`;
  } else {
    const owner = typeof input.owner === "string" ? input.owner : "", repo = typeof input.repo === "string" ? input.repo : "";
    if (/^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repo)) root = `gh:${owner}/${repo}`;
  }
  if (!root.startsWith("/") && !root.startsWith("gh:")) return null;
  const held = await mergeLockOf(root, Number(out.target), true).catch(() => null);
  return held?.state.locked ? `merge lock on #${out.target}: ${held.state.reason}` : null;
}

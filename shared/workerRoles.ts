/*
 * The worker roles, and the lock each one runs under on whichever CLI it is
 * given.
 *
 * context-diet splits a job into three kinds of worker — a scout that finds,
 * a builder that changes, a verifier that runs the checks — and pinned each
 * one to a Claude model in its agent files. The cheap two are exactly the
 * work that does not need Claude at all, so the role, not the agent file,
 * now names a provider and a model, and a person picks them in Settings.
 *
 * ── the lock ─────────────────────────────────────────────────────────────
 * A role changes which CLI runs, so it cannot rely on that CLI's own config
 * to keep a worker from pushing: the person's opencode.json may allow
 * everything, and a project can ship its own. Every role therefore starts
 * with a deny list rendered into the one layer of that CLI the person's and
 * the project's files cannot loosen (see `LockSpelling`), and a CLI with no
 * such layer is refused rather than run unlocked.
 *
 * What it cannot do: it is a list of command PREFIXES, and a CLI decides what
 * a prefix matches. An OpenCode agent switched to by hand in the TUI runs
 * under the project's rules for that agent, not these. `sh -c 'git push'` or a script that pushes is not a
 * command named `git push`. It closes the ordinary way a worker does the
 * thing it was told not to; it is not a sandbox, and the one this app has for
 * that is the local-review plugin's.
 */
import type { Provider } from "./agentKinds.ts";

export type RoleId = "scout" | "builder" | "verifier";

export interface RoleChoice {
  provider: string;
  /** Handed to the CLI's model flag as it is. Empty is the CLI's default. */
  model: string;
}

export interface WorkerRole {
  id: RoleId;
  title: string;
  what: string;
  /** No file edits either: the role reports, it does not change the tree. */
  readOnly: boolean;
  /** What context-diet's own agent files pin it to today. */
  default: RoleChoice;
}

export const WORKER_ROLES: WorkerRole[] = [
  {
    id: "scout",
    title: "Scout",
    what: "Finds things and returns file:line. Reads, never writes.",
    readOnly: true,
    default: { provider: "claude", model: "haiku" },
  },
  {
    id: "builder",
    title: "Builder",
    what: "Makes one bounded change in its worktree. Never commits or pushes.",
    readOnly: false,
    default: { provider: "claude", model: "sonnet" },
  },
  {
    id: "verifier",
    title: "Verifier",
    what: "Runs the checks and brings back the verdict. Changes nothing.",
    readOnly: true,
    default: { provider: "claude", model: "haiku" },
  },
];

export const workerRole = (id: unknown): WorkerRole | undefined =>
  WORKER_ROLES.find((r) => r.id === id);

/**
 * The commands no worker runs, whatever its role: anything that publishes,
 * rewrites history or moves the checkout under the person, the network
 * clients, and the two that reach past the worktree. The integration is the
 * caller's; a worker's work stops at the diff.
 *
 * `rm` is on it because a delete is the one edit no diff review can undo, and
 * that has a price: a builder cannot delete a file, and says so in its report
 * for the caller to do.
 */
export const DENIED_COMMANDS: readonly string[] = [
  "git push", "git commit", "git merge", "git rebase", "git reset", "git checkout",
  "git switch", "git stash", "git tag", "git remote", "git worktree", "git clean",
  "gh", "curl", "wget", "ssh", "scp", "docker", "aws", "sudo", "rm",
];

/** A model name as a CLI takes it: `haiku`, `claude-sonnet-5`, `opencode/big-pickle`. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;

/**
 * What starting a role on this CLI adds to its command line and environment.
 *
 * `file` is the content of a settings file the caller writes, and `fileEnv`
 * the variable that must name it. Null when the CLI has no lock this app
 * knows how to apply — the caller refuses the role rather than run it without.
 */
export function roleLaunch(p: Provider, role: WorkerRole, model: string): {
  args: string[];
  env: Record<string, string>;
  file?: { env: string; content: string };
} | null {
  const lock = p.lock;
  if (!lock) return null;
  const pick = model && p.modelFlag ? [p.modelFlag, model] : [];

  if (lock.via === "env") {
    // OpenCode: one pattern for the bare command and one for it with
    // arguments, because its patterns are globs over the whole line and
    // `git push*` would also refuse `git pushd-helper`.
    const bash: Record<string, "deny"> = {};
    for (const c of DENIED_COMMANDS) { bash[c] = "deny"; bash[`${c} *`] = "deny"; }
    const perm: Record<string, unknown> = { bash, task: "deny" };
    if (role.readOnly) perm.edit = "deny";
    const config = { default_agent: "build", permission: perm, agent: { build: { permission: perm } } };
    return { args: pick, env: { [lock.env]: JSON.stringify(config) } };
  }

  // Claude Code and Qwen Code share a rule syntax: `Bash(prefix…)`, and the
  // tool names for edits. Claude's prefix form is `cmd:*`; Qwen's documented
  // one is `cmd *`, with the bare command as a rule of its own.
  const edits = role.readOnly ? ["Edit", "Write", "NotebookEdit"] : [];
  if (lock.via === "flag") {
    const deny = [...DENIED_COMMANDS.map((c) => `Bash(${c}:*)`), ...edits];
    return { args: [lock.flag, JSON.stringify({ permissions: { deny } }), ...pick], env: {} };
  }
  // Qwen's `Edit` is a meta-rule over its edit, write and notebook tools.
  const deny = [...DENIED_COMMANDS.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]), ...(role.readOnly ? ["Edit", "Write"] : [])];
  return {
    args: pick,
    env: {},
    file: { env: lock.env, content: JSON.stringify({ permissions: { deny } }, null, 2) + "\n" },
  };
}

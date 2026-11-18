/*
 * The worker roles, and the lock each one runs under on whichever CLI it is
 * given.
 *
 * context-diet splits a job into kinds of worker — a scout that finds,
 * a builder that changes, a reviewer that reads the change adversarially, a
 * verifier that runs the checks — and pinned each
 * one to a Claude model in its agent files. The cheap two are exactly the
 * work that does not need Claude at all, so the role, not the agent file,
 * now names a provider and a model, and a person picks them in Settings.
 *
 * ── the lock ─────────────────────────────────────────────────────────────
 * A role changes which CLI runs, so it cannot rely on that CLI's own config
 * to keep a worker from pushing: the person's opencode.json may allow
 * everything, and a project can ship its own. Every role therefore starts
 * with a deny list rendered into the layer of that CLI the person's and the
 * project's files cannot loosen (see `LockSpelling`), and a CLI with no such
 * layer is refused rather than run unlocked. OpenCode has no such layer, only
 * a merge, so its lock is checked against the merged rules at every start.
 *
 * What it cannot do: it is a list of command PREFIXES, and a CLI decides what
 * a prefix matches. An OpenCode agent switched to by hand in the TUI runs
 * under the project's rules for that agent, not these. `sh -c 'git push'` or a script that pushes is not a
 * command named `git push`. It closes the ordinary way a worker does the
 * thing it was told not to; it is not a sandbox, and the one this app has for
 * that is the local-review plugin's.
 */
import type { Provider } from "./agentKinds.ts";

export type RoleId = "scout" | "builder" | "reviewer" | "verifier";

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
  /** Command prefixes this role may run on top of the floor (`NEVER_LIFTABLE` aside). */
  allow?: readonly string[];
  /** May call the Agent tool: a flow role's own `mayStartSubagents`, carried
   *  onto the role so `allowedToolsFor` (agents/headless.ts) sees it. No
   *  built-in role sets this; it only ever comes from a flow role's lock. */
  mayStartSubagents?: boolean;
  /** The built-in role a custom flow role runs as (its own `policyRole`), so
   *  `DOORS_FOR_ROLE` (agents/envelope.ts) can be read off a role this app
   *  knows even when `id` is the flow's own string. Absent for a built-in
   *  role (whose `id` already is one) and for a flow role with no
   *  `policyRole`, which then opens no door, same as `scout`. */
  base?: RoleId;
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
    id: "reviewer",
    title: "Reviewer",
    what: "Reads a change adversarially and reports what it finds. Changes nothing.",
    readOnly: true,
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
 * The roles whose turn is worth nothing without an answer in it: a builder's
 * change, a reviewer's verdict, a verifier's word. A scout that reports where
 * a thing is has answered; so has anything with no role at all.
 */
export const RESULT_ROLES: readonly RoleId[] = ["builder", "reviewer", "verifier"];
export const owesResult = (id: unknown): boolean => (RESULT_ROLES as readonly unknown[]).includes(id);

/**
 * The floor: the only commands no worker runs, because the seat must not run
 * them either. `sudo` is root. The four worktree subcommands rewrite or pin
 * ANOTHER worktree's gitdir (`repair` can point it anywhere). Nothing else is
 * on it: a worker does what its seat does, and what a person wants kept from
 * both lives in the agent rules (`agentglass-ui rules`: never push to master,
 * never merge a PR, ask before sudo or `rm -rf /`).
 *
 * A prefix lock cannot say "`rm -rf /` but not `rm -rf /tmp/x`", so that one is
 * a base rule, not a floor entry.
 */
export const DENIED_COMMANDS: readonly string[] = [
  "git worktree lock", "git worktree move", "git worktree repair", "git worktree unlock", "sudo",
];

/** The floor entries no role may ever be granted. Same list: the floor has no grant. */
export const NEVER_LIFTABLE: readonly string[] = DENIED_COMMANDS;

/** The floor entries with no switch anywhere. */
export const FIXED_COMMANDS: readonly string[] = DENIED_COMMANDS;

/**
 * The commands a seat or a project may CLOSE to workers. Open by default; a
 * per-project switch (`workers.commands.<cmd>`) closes one, and the envelope
 * flags close the git, network and docker groups at start (see envelope.ts
 * `LIFTS`). These were the old floor; closing is narrowing, never the default.
 */
/**
 * The floor as it was before a worker had its seat's powers. An engine that does
 * not run the person's hooks (OpenCode, Codex) keeps it, so the powers apply only
 * where the seat's own safety hooks run beside the worker.
 */
export const LEGACY_FLOOR: readonly string[] = [
  "git push", "git commit", "git merge", "git rebase", "git reset", "git checkout",
  "git switch", "git stash", "git tag", "git remote", "git clean",
  "git worktree add", "git worktree lock", "git worktree move", "git worktree repair", "git worktree unlock",
  "git worktree remove", "git worktree prune", "git worktree list",
  "gh", "curl", "wget", "ssh", "scp", "docker", "aws", "sudo", "rm",
  "kill", "pkill", "killall", "killall5", "xkill",
];

/* Every command a project may close to its workers, open by default: a missing value is open, a stored false is closed. The ones that left the
   floor (publish, the network clients, the cloud CLI, docker, history rewrites) are here so a project can pin them shut. */
export const SWITCHABLE_COMMANDS: readonly string[] = [
  "ssh", "scp", "rm", "kill", "pkill", "killall", "killall5", "xkill",
  "git push", "gh", "curl", "wget", "aws", "docker", "git rebase", "git stash", "git tag", "git remote",
];

/** The flags that leave a worker's own tab (`--shared`, `--active`), at their
 *  stem so an abbreviation argparse once accepted is refused too. `--page` is
 *  not here: it names a tab the relay serves only if this worker opened it.
 *  `--show` is here for consent rather than data: it brings the pane forward. */
export const BROWSER_CROSS_FLAGS = ["--shar", "--acti", "--show"] as const;

/** A model name as a CLI takes it: `haiku`, `claude-sonnet-5`, `opencode/big-pickle`. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;

/**
 * What starting a role on this CLI adds to its command line and environment.
 *
 * `file` is the content of a settings file the caller writes, and `fileEnv`
 * the variable that must name it. Null when the CLI has no lock this app
 * knows how to apply — the caller refuses the role rather than run it without.
 */
export function roleLaunch(p: Provider, role: WorkerRole, model: string, denied: readonly string[] = DENIED_COMMANDS, deniedTools: readonly string[] = []): {
  args: string[];
  env: Record<string, string>;
  file?: { env: string; content: string };
} | null {
  const lock = p.lock;
  if (!lock) return null;
  const pick = model && p.modelFlag ? [p.modelFlag, model] : [];
  // The browser door is open only where the caller left it out of `denied`;
  // the flags that cross out of a worker's own tab stay refused when it is.
  const door = !denied.includes("agentglass-browser");

  if (lock.via === "env") {
    // OpenCode: one pattern for the bare command and one for it with
    // arguments, because its patterns are globs over the whole line and
    // `git push*` would also refuse `git pushd-helper`.
    const bash: Record<string, "deny"> = {};
    for (const c of denied) { bash[c] = "deny"; bash[`${c} *`] = "deny"; }
    if (door) for (const f of BROWSER_CROSS_FLAGS) bash[`*agentglass-browser*${f}*`] = "deny";
    const perm: Record<string, unknown> = { bash, task: "deny" };
    if (role.readOnly) perm.edit = "deny";
    const config = { default_agent: "build", permission: perm, agent: { build: { permission: perm } } };
    return { args: pick, env: { [lock.env]: JSON.stringify(config) } };
  }

  // Claude Code and Qwen Code share a rule syntax: `Bash(prefix…)`, and the
  // tool names for edits. Claude's prefix form is `cmd:*`; Qwen's documented
  // one is `cmd *`, with the bare command as a rule of its own.
  const edits = [...new Set([...(role.readOnly ? ["Edit", "Write", "NotebookEdit"] : []), ...deniedTools])];
  const crossing = door ? BROWSER_CROSS_FLAGS : [];
  if (lock.via === "flag") {
    const deny = [
      ...denied.map((c) => `Bash(${c}:*)`),
      ...crossing.map((f) => `Bash(agentglass-browser ${f}:*)`),
      ...edits,
    ];
    // A subagent with no model of its own inherits the session's; pinning it
    // keeps a cheap role from spawning helpers at the expensive model.
    return { args: [lock.flag, JSON.stringify({ permissions: { deny } }), ...pick], env: { CLAUDE_CODE_SUBAGENT_MODEL: model || role.default.model } };
  }
  // Qwen's `Edit` is a meta-rule over its edit, write and notebook tools.
  const deny = [
    ...denied.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
    ...crossing.flatMap((f) => [`Bash(agentglass-browser ${f})`, `Bash(agentglass-browser ${f} *)`]),
    ...new Set([...(role.readOnly ? ["Edit", "Write"] : []), ...deniedTools]),
  ];
  return {
    args: pick,
    env: {},
    file: { env: lock.env, content: JSON.stringify({ permissions: { deny } }, null, 2) + "\n" },
  };
}

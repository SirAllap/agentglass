/*
 * Who may drive the built-in browser, at the launch path.
 *
 * The setting lives in `config.json` as `browserWorkers` and is read as every
 * engine and role unless the person turned something off. This module is the
 * one place that decides it, and the two mint sites call it in place of
 * `mintWorkerToken` directly: an engine or role that is off gets no credential,
 * and the worker's brief says so. Nothing here widens what a credential reaches
 * — that floor is in auth.ts and browserdrive.ts.
 *
 * A stored name this app does not know is dropped, never read as "all on": a
 * typo or a half hand-edit can only narrow, and a list with nothing known left
 * is nothing on.
 *
 * Two gaps this module cannot close. A server run without a token has no
 * identity to check, so `POST /browser/*` on it answers anyone on the machine
 * as the person, and an engine or role that is off here gets no credential but
 * needs none. Set AGENTGLASS_TOKEN to make this list mean anything. And a
 * hand-written process running as the same operating-system user could still
 * read the files the person can read; the worker envelope (sandbox) is what
 * limits that, not this list.
 */
import {
  BROWSER_ENGINES, BROWSER_ROLES, browserOffLine, browserWorkerAllowed, cleanBrowserWorkers,
  defaultBrowserWorkers, readBrowserWorkers, type BrowserWorkers,
} from "../../shared/browserWorkers.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { mintWorkerToken } from "./auth.ts";
import { storedBrowserWorkers, writeBrowserWorkers } from "./config.ts";

/** What is in force: the stored lists with unknown names dropped, every one when there is nothing stored. */
export function browserWorkersNow(): BrowserWorkers {
  return readBrowserWorkers(storedBrowserWorkers());
}

/** The setting's own validation (the settings door), and the write. */
export function validateBrowserWorkers(raw: unknown): { value: BrowserWorkers } | { error: string } {
  return cleanBrowserWorkers(raw);
}

export function saveBrowserWorkers(v: BrowserWorkers): { ok: true } | { ok: false; error: string } {
  const r = writeBrowserWorkers(v);
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "could not save it" };
}

/** The variables a credential arrives in. A worker whose engine or role is off
 *  must not inherit the person's: a tmux window takes the SERVER's environment,
 *  so leaving them unset lets `AGENTGLASS_TOKEN` through, and setting them
 *  empty is no better — a CLI that finds an empty one falls back to the
 *  person's token file. They are removed from the window instead. */
export const BROWSER_CREDENTIAL_VARS = ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"] as const;

/** Set by the app on a window it hands no credential: the supplied CLI and MCP
 *  server refuse every verb under it rather than fall back to the machine
 *  identity. Only the name is passed; it carries no secret. */
export const BROWSER_OFF_VAR = "AGENTGLASS_BROWSER_OFF";

/** What an agent window must not inherit: the credentials, and the marker that
 *  belongs to the window it was set for. */
const BROWSER_WINDOW_VARS = [...BROWSER_CREDENTIAL_VARS, BROWSER_OFF_VAR] as const;

/**
 * The one door for a window or process that runs an AGENT.
 *
 * A tmux window inherits the SERVER's environment, so an agent handed no
 * credential of its own still arrives holding the person's machine token. This
 * cannot tell an inherited token from a handed-down one by looking at the
 * process, so it looks at what the caller passed in `env`: a start that means
 * the agent to have a credential puts it there (a role's minted `wk_`, a seat's
 * token), and `env` without one is an agent with none — the variables are
 * removed before the command runs. Emptying is not enough: a CLI that reads an
 * empty token falls back to the person's token file.
 *
 * The person's own terminals do not come through here: a bench, the console and
 * a tab they opened by hand pass `person` to the window opener and keep exactly
 * the environment they had.
 */
export function agentWindowDrops(env: Record<string, string> | undefined): readonly string[] {
  /* A credential the caller handed over does not vouch for its siblings: one
     the server itself holds (a `WORKER_TOKEN` left in its own environment) is
     still removed, or it would shadow the one the window was given. */
  return BROWSER_WINDOW_VARS.filter((v) => !env?.[v]);
}

/**
 * The prefix a direct tmux call puts before an agent's own argv: the inherited
 * credentials removed and the off marker set, because a window made here is
 * handed no credential of its own. Same door by another doorbell.
 */
export function agentWindowGuard(env: Record<string, string> = { [BROWSER_OFF_VAR]: "1" }): string[] {
  const drops = agentWindowDrops(env);
  return ["env", ...drops.flatMap((v) => ["-u", v]), ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
}

/**
 * The credential a worker's environment is given, or null when its engine or
 * role is off. Off sets `AGENTGLASS_BROWSER_OFF` and no credential: the CLI and
 * the MCP server refuse under it instead of falling back to the machine
 * identity. The caller removes what the window would inherit.
 */
export function mintBrowserCredential(
  env: Record<string, string>, name: string, engine: string, role: string,
  opts: { ttlMs?: number; replace?: boolean } = {},
): string | null {
  if (!browserWorkerAllowed(browserWorkersNow(), engine, role)) {
    env[BROWSER_OFF_VAR] = "1";
    return null;
  }
  delete env[BROWSER_OFF_VAR];
  const t = mintWorkerToken(name, opts.ttlMs, opts.replace);
  env.AGENTGLASS_TOKEN = t;
  env.AGENTGLASS_WORKER_TOKEN = t;
  /* The browser CLI derives its identity from the directory when nothing names
     it, and the relay serves a worker only the container its own name opened.
     So the name the credential was minted for is handed over with it. */
  env.AGENTGLASS_PROFILE = name;
  env.AGENTGLASS_BROWSER_AS = name;
  return t;
}

/** The brief, with the one line a worker whose access is off needs to read first. */
export function withBrowserLine(prompt: string, engine: string, role: string): string {
  // A custom flow role has no browser line and no credential: Settings ▸ Browser names the four built-ins only.
  if (!workerRole(role)) return prompt;
  const line = browserOffLine(browserWorkersNow(), engine, role);
  if (!line) return prompt;
  return prompt.trim() ? `${line}\n\n${prompt}` : line;
}

/** Every list, so the card and a test read the same names as the check. */
export { BROWSER_ENGINES, BROWSER_ROLES };

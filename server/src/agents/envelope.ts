/*
 * The envelope a policy-started worker runs inside, compiled per engine.
 *
 * One neutral `Envelope` (shared/orchestration.ts) in, one lock out. The
 * floor is DENIED_COMMANDS; an envelope can lift exactly two things from it
 * (`commit` lifts `git commit`, `network` lifts `curl` and `wget`) and add
 * more, and there is no field that lifts anything else. What cannot be
 * expressed cannot be granted by mistake, so no combination of flags takes
 * `git push`, `gh`, `ssh`, history rewrites, `sudo` or `rm` off the list.
 *
 * Being on the list is not being impossible. Not a sandbox: the engine applies
 * its own permission system, as the same user as this server, and its rules
 * read a command line as text. Claude Code's match the start of the line, so
 * `git -C . push` or `/usr/bin/git push` is not `git push` to it; OpenCode's
 * are globs a shell can build a line around. The app's own CLIs are on the
 * list the same way, and its token file is readable by anything that runs as
 * this user. So no engine's lock is reported as more than "partly" enforced
 * (agentprobe.ts), every start says so, and SECURITY.md says what follows.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProvider } from "../../../shared/agentKinds.ts";
import type { Envelope } from "../../../shared/orchestration.ts";
import { DENIED_COMMANDS, roleLaunch, type WorkerRole } from "../../../shared/workerRoles.ts";

/** The two things an envelope may lift from the floor, and nothing else. */
export const LIFTS: Readonly<Record<"commit" | "network", readonly string[]>> = {
  commit: ["git commit"],
  network: ["curl", "wget"],
};

/** What a worker may not reach through its engine: this app's own doors. A
 *  worker that could call them could start workers or change a setting. */
export const WORKER_DENIED = ["agentglass-agent", "agentglass-ui", "agentglass-browser", "agentglass-cockpit-mcp"] as const;

/** The command prefixes the engine's lock denies for this envelope. */
export function deniedFor(e: Envelope): string[] {
  const lifted = new Set<string>([...(e.commit ? LIFTS.commit : []), ...(e.network ? LIFTS.network : [])]);
  const out = [...DENIED_COMMANDS.filter((c) => !lifted.has(c)), ...WORKER_DENIED, ...e.deny];
  return [...new Set(out)];
}

/** The globs that deny a command wherever it sits in a line: word-bounded, so
 *  `cat gh.txt` still runs, and any line that names one of the app's own doors
 *  is denied. A shell can still build a command line these do not read. */
function anywhere(c: string): string[] {
  if (c.startsWith("agentglass-")) return [`*${c}*`];
  const words = c.split(" ");
  return [...(words.length > 1 ? [`*${words.join("*")}*`] : []), `* ${c} *`, `* ${c}`, `*/${c} *`, `*/${c}`];
}

export type Compiled =
  | { ok: true; args: string[]; env: Record<string, string>; partly?: string }
  | { ok: false; error: string };

/** Where the lock files go: beside the rest of the app's state, owner-only. */
export function envelopeDir(): string {
  const state = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(state, "worker-locks");
}

/** OpenCode's config layers that come from the environment; see agentops.ts
 *  (`OPENCODE_ENV_LAYERS`), which pins them so the lock check and the window
 *  read the same set. */
const OPENCODE_LAYERS = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION", "OPENCODE_DISABLE_PROJECT_CONFIG"];

/** What a start on Claude Code or Qwen Code says about its own lock. */
const PREFIX_LOCK = "the lock is a list of command prefixes: the same command spelled another way (git -C . push, /usr/bin/git push) is not refused by it";

/**
 * The lock for one engine under one envelope: the flags and environment the
 * start adds. Claude Code, OpenCode and Qwen Code have a lock this app writes;
 * Codex gets sandbox flags and Hermes the person's own deny list. Every one is
 * said out loud as "partly": none of them is a wall.
 */
export function compileEnvelope(
  engine: string, role: WorkerRole, e: Envelope, model: string, dir: string = envelopeDir(),
): Compiled {
  const p = agentProvider(engine);
  if (!p) return { ok: false, error: `${engine} is not an engine this app knows` };
  // A role that only reads, or an envelope that writes nothing, gets no edits.
  const effective: WorkerRole = { ...role, readOnly: role.readOnly || e.write === "none" };
  if (engine === "codex") {
    return { ok: true, args: [], env: {}, partly: "Codex has no command deny list: the sandbox is the limit, and its network rule is its own" };
  }
  if (engine === "hermes") {
    return { ok: true, args: [], env: {}, partly: "Hermes refuses what its own approvals.deny lists; this app checks that list but does not write it" };
  }
  if (!p.lock) return { ok: false, error: `${p.title} has no lock this app can apply, so it cannot run as a worker` };
  const denied = deniedFor(e);
  const launch = roleLaunch(p, effective, model, denied);
  if (!launch) return { ok: false, error: `${p.title} has no lock this app can apply, so it cannot run as a worker` };
  const env = { ...launch.env };
  if (engine === "claude" && !e.network) {
    // Its shell prefixes do not cover its own network tools, and a settings file
    // of the person's or the repo's may allow them.
    const lock = JSON.parse(launch.args[1]!) as { permissions: { deny: string[] } };
    lock.permissions.deny.push("WebFetch", "WebSearch");
    launch.args[1] = JSON.stringify(lock);
  }
  if (engine === "opencode" && p.lock.via === "env") {
    // An unlisted tool is allowed under a headless run (measured), so the
    // network tool is denied by name unless the envelope lets the worker out.
    type Perm = Record<string, any>;
    const cfg = JSON.parse(env[p.lock.env]!) as { permission: Perm; agent: { build: { permission: Perm } } };
    if (!e.network) { cfg.permission.webfetch = "deny"; cfg.agent.build.permission.webfetch = "deny"; }
    // Its shell is allowed unless a rule says otherwise, and a rule matches the
    // whole line: `git push` does not match `env git push` or `/usr/bin/git
    // push`. So each denied command is also denied wherever it sits in a line.
    for (const c of denied) for (const g of anywhere(c)) cfg.permission.bash[g] = cfg.agent.build.permission.bash[g] = "deny";
    env[p.lock.env] = JSON.stringify(cfg);
    for (const k of OPENCODE_LAYERS) env[k] = process.env[k] ?? "";
  }
  if (launch.file) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${role.id}-${engine}-envelope.json`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, launch.file.content, { mode: 0o600 });
    renameSync(tmp, path);
    env[launch.file.env] = path;
  }
  const partly = engine === "opencode"
    ? "the lock is a list of patterns over the command line: a line a shell builds around a command is not refused by it"
    : PREFIX_LOCK;
  return { ok: true, args: launch.args, env, partly };
}

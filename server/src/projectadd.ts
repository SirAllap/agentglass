/**
 * The two ways of getting a project that do not exist on this machine yet:
 * clone one, or start an empty one.
 *
 * Until now "open a project" could only name a folder already sitting there, so
 * the first thing anybody does with a new repo — clone it — happened in a
 * terminal somewhere else and then had to be found again by typing its path.
 *
 * Both of these write to the filesystem outside any scope, which is deliberate
 * and is the only pair of endpoints here that do: adding a project is precisely
 * the operation that steps outside the project you have open. That makes the
 * argument checking the whole substance of this file rather than ceremony:
 *
 *   * **A remote URL is not a shell string, and it is not a flag.** `git clone`
 *     reads an argument beginning with `-` as an option, so a "URL" of
 *     `--upload-pack=…` runs a command of the caller's choosing. It is refused
 *     here and `--` is passed as well, because one of the two being right is
 *     not a guarantee.
 *   * **`ext::` is remote code execution by design.** git's ext transport takes
 *     a shell command as its address (`ext::sh -c …`). Only the transports
 *     somebody actually clones with are allowed through, by name.
 *   * **A name is one path segment.** The directory to create is derived from
 *     the URL, so a repository called `../../.ssh` would otherwise write where
 *     it liked. Names are matched against a closed character set rather than
 *     scanned for the tricks known today.
 *   * **Nothing is overwritten, ever.** An existing target is an error, not a
 *     merge: cloning onto a directory somebody has work in is unrecoverable
 *     from here.
 *
 * The spawn carries no shell in either case, so quoting is not part of the
 * threat model at all — the argv is built as an array and handed over whole.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

/** How long a clone may take before it is abandoned. Generous, because a real
 *  repository over a slow line legitimately takes minutes; bounded, because the
 *  request is held open for the whole of it and a hung transport would
 *  otherwise hold it forever. */
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/** A directory name this will create: one segment, no dots-only, no surprises.
 *  Closed set rather than a blocklist — `..` and `/` are the two that matter
 *  today and the set is what makes tomorrow's third one uninteresting. */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function validProjectName(name: unknown): name is string {
  return typeof name === "string" && SAFE_NAME.test(name) && name !== "." && name !== "..";
}

/**
 * The transports a person clones with, and only those.
 *
 * `ext::` and `file::` are absent on purpose — the first runs a command, and
 * the second is a way of reaching the first. Anything unrecognised is refused
 * rather than passed through hopefully: a URL this cannot name is a URL this
 * cannot reason about.
 */
const URL_SCHEME = /^(https?|ssh|git):\/\/[^\s]+$/i;
/** `git@github.com:owner/repo.git` — the form every host prints on its own
 *  page, so refusing it would mean refusing the commonest copy-paste there is. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;

/** Why this URL cannot be cloned, or null when it can. A sentence, because it
 *  is shown to the person who typed it. */
export function cloneUrlError(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "Paste a repository URL";
  const u = url.trim();
  if (u.length > 2048) return "That URL is too long";
  // Control characters, spaces and newlines: not part of any address, and the
  // way a second argument gets smuggled into one.
  if (/[\s\u0000-\u001f\u007f]/.test(u)) return "That URL contains characters a repository address cannot have";
  if (u.startsWith("-")) return "A URL cannot start with “-” — git would read it as an option";
  if (/^ext::/i.test(u) || /^file:/i.test(u) || u.includes("::")) return "That transport is not allowed — use https, ssh or git@host:path";
  if (!URL_SCHEME.test(u) && !SCP_LIKE.test(u)) return "That does not look like a repository URL (https://…, ssh://… or git@host:path)";
  return null;
}

/**
 * What to call the folder a URL clones into.
 *
 * git's own rule — the last path segment without `.git` — and then held to the
 * same closed character set as a name somebody types, because this one is
 * derived from a string the caller controls.
 */
export function cloneTargetName(url: string): string | null {
  let rest = url.trim().split(/[?#]/)[0]!.replace(/\/+$/, "");
  const scheme = rest.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  if (scheme) {
    // Past the scheme, then past host[:port]. Splitting the whole URL on any
    // `/` or `:` and taking the last piece looked equivalent and was not: for
    // `https://host/` it answered "host", so a URL that names no repository at
    // all cloned into a folder named after the server.
    rest = rest.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    rest = slash >= 0 ? rest.slice(slash + 1) : "";
  } else {
    // scp-like: everything after the first colon is the path.
    const colon = rest.indexOf(":");
    rest = colon >= 0 ? rest.slice(colon + 1) : rest;
  }
  const name = (rest.split("/").pop() ?? "").replace(/\.git$/i, "");
  return validProjectName(name) ? name : null;
}

/** `~` and `~/x` mean what the shell means by them; everything else must be
 *  absolute already. A relative path here would resolve against the server's
 *  working directory, which is not a place anybody meant. */
export function expandDir(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return join(homedir(), t.slice(2));
  return t;
}

export interface AddResult { ok: boolean; path?: string; error?: string }

/** The parent a project is going into: absolute, existing, and a directory. */
export function parentError(parentIn: unknown): string | null {
  if (typeof parentIn !== "string" || !parentIn.trim()) return "Choose a folder to put it in";
  const parent = expandDir(parentIn);
  if (parent.includes("\0")) return "invalid path";
  if (!isAbsolute(parent)) return "That folder has to be an absolute path";
  try {
    if (!statSync(parent).isDirectory()) return "That is not a folder";
  } catch {
    return "That folder does not exist";
  }
  return null;
}

/** Where this would end up, with the checks that do not need to run a command
 *  already done. Split out so both callers and their tests can ask "where
 *  would this go?" without going anywhere. */
export function targetFor(parentIn: string, name: string): { target: string } | { error: string } {
  const bad = parentError(parentIn);
  if (bad) return { error: bad };
  if (!validProjectName(name)) return { error: "That name can only contain letters, numbers, dots, dashes and underscores" };
  const target = resolve(join(expandDir(parentIn), name));
  // Belt and braces: `name` is already one safe segment, so this can only fail
  // if the rule above ever loosens.
  if (!target.startsWith(resolve(expandDir(parentIn)) + "/")) return { error: "invalid path" };
  if (existsSync(target)) return { error: `${name} already exists in that folder` };
  return { target };
}

/** Run git, with no shell and no inherited stdin. Returns the failure text git
 *  printed, because "clone failed" on its own sends people to a terminal to
 *  find out what this already knew. */
async function git(args: string[], cwd: string, timeout: number): Promise<{ ok: boolean; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeout);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, err: "" } : { ok: false, err: err.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Clone a repository into a folder, and say where it landed.
 *
 * `--` before the URL for the reason at the top of this file, and the target
 * directory is named explicitly rather than left to git: the name has already
 * been checked, and letting git derive it again from the URL would put the one
 * decision that matters back in the hands of the string.
 */
export async function cloneProject(urlIn: unknown, parentIn: unknown): Promise<AddResult> {
  const urlBad = cloneUrlError(urlIn);
  if (urlBad) return { ok: false, error: urlBad };
  const url = (urlIn as string).trim();
  const name = cloneTargetName(url);
  if (!name) return { ok: false, error: "Could not work out a folder name from that URL" };
  const t = targetFor(parentIn as string, name);
  if ("error" in t) return { ok: false, error: t.error };

  const r = await git(["clone", "--", url, t.target], expandDir(parentIn as string), CLONE_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: r.err || "git clone failed" };
  return { ok: true, path: t.target };
}

/**
 * An empty project: a folder and a git repository in it.
 *
 * `git init` rather than a bare directory, because everything this app is for —
 * the diff, the branch, the commit — needs a repository, and a project that
 * silently has none looks broken in four panels at once.
 */
export async function createProject(nameIn: unknown, parentIn: unknown): Promise<AddResult> {
  if (!validProjectName(nameIn)) return { ok: false, error: "That name can only contain letters, numbers, dots, dashes and underscores" };
  const t = targetFor(parentIn as string, nameIn);
  if ("error" in t) return { ok: false, error: t.error };
  try {
    mkdirSync(t.target);
  } catch (e) {
    return { ok: false, error: `Could not create that folder: ${e instanceof Error ? e.message : e}` };
  }
  const r = await git(["init"], t.target, 30_000);
  // The folder is real either way and naming it is more useful than pretending
  // nothing happened — but say plainly that it is not a repository yet.
  if (!r.ok) return { ok: true, path: t.target, error: `Created, but git init failed: ${r.err}` };
  return { ok: true, path: t.target };
}

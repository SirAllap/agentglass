/*
 * The `sandbox` block of a plugin manifest: what a plugin asks to be given
 * inside its box. Read by the server (validation and the approved hash), by
 * the approval screen (what to draw) and mirrored in `bin/agentglass-plugin`
 * for a plugin's CI.
 *
 * This is the DECLARATION. Nothing enforces it yet: a plugin still runs as the
 * user, and the screen says so. What lives here is what the enforcement will
 * stand on, so a grant that could never be honoured is refused when the
 * manifest is read rather than when the box is built.
 */

export interface PluginSandbox {
  /** `agentglass`: the app's own address and nothing else. `internet`: any host. */
  network: "agentglass" | "internet";
  /** Extra read-only paths, `~/…` or absolute. */
  read: string[];
  /** Extra read-write paths. */
  write: string[];
  /** Commands under the home folder to put on the plugin's PATH, by bare name. */
  programs: string[];
}

export type SandboxResult = { ok: true; value: PluginSandbox } | { ok: false; error: string };

/**
 * Never mountable, whatever a manifest says: the app's own token, the keys and
 * the session bus. The parents of these are refused too, since a grant of
 * `~/.config` is a grant of `~/.config/agentglass`. `~` is the user's home;
 * an absolute spelling of it is resolved where the box is built.
 */
export const NEVER_MOUNTABLE = ["~/.config/agentglass", "~/.ssh", "~/.gnupg", "/run/user", "~/.local/share/keyrings"] as const;

const MAX_ENTRIES = 16;
const MAX_PATH = 200;
const CONTROL = /[\x00-\x1f\x7f]/;
const PROGRAM_RE = /^[A-Za-z0-9._+-]{1,60}$/;
const KEYS = new Set(["network", "read", "write", "programs"]);

/** `~/a//b/` and `~/a/b` are one path; anything else about it is the caller's. */
const segments = (p: string): string[] => p.split("/").filter((s, i) => s !== "" || i === 0);
const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((s, i) => s === b[i]);

function pathError(raw: unknown, key: string): { path: string } | { error: string } {
  const at = `sandbox.${key}`;
  if (typeof raw !== "string" || !raw.trim()) return { error: `${at} entries must be non-empty text` };
  if (raw.length > MAX_PATH || CONTROL.test(raw)) return { error: `${at} paths must be at most ${MAX_PATH} characters with no control characters` };
  if (!raw.startsWith("~/") && !raw.startsWith("/")) return { error: `${at} paths must start with ~/ or /, and "${raw}" does not` };
  const segs = segments(raw.replace(/\/+$/, "") || "/");
  if (segs.some((s) => s === ".." || s === ".")) return { error: `${at} path "${raw}" may not contain . or .. segments` };
  if (raw === "/" || raw === "~/" || segs.length < 2) return { error: `${at} may not be the whole disk or the whole home folder` };
  for (const never of NEVER_MOUNTABLE) {
    const n = segments(never);
    if (isPrefix(segs, n) || isPrefix(n, segs)) return { error: `${at} path "${raw}" is or leads to ${never}, which no plugin can be given` };
  }
  return { path: segs.join("/") };
}

function pathList(raw: unknown, key: "read" | "write"): { list: string[] } | { error: string } {
  if (raw === undefined) return { list: [] };
  if (!Array.isArray(raw)) return { error: `sandbox.${key} must be a list of paths` };
  if (raw.length > MAX_ENTRIES) return { error: `sandbox.${key} may list at most ${MAX_ENTRIES} paths` };
  const out = new Set<string>();
  for (const item of raw) {
    const r = pathError(item, key);
    if ("error" in r) return r;
    out.add(r.path);
  }
  return { list: [...out].sort() };
}

/**
 * Shape-checked field by field, like the rest of the manifest: a bad entry
 * loses the plugin rather than being coerced into something else. The value
 * comes back complete and sorted, so two spellings of one grant hash alike.
 */
export function validateSandbox(raw: unknown): SandboxResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "sandbox must be an object" };
  const b = raw as Record<string, unknown>;
  // A misspelt key would grant nothing and say so nowhere.
  for (const k of Object.keys(b)) if (!KEYS.has(k)) return { ok: false, error: `sandbox has no "${k}": it takes network, read, write and programs` };
  if (b.network !== undefined && b.network !== "agentglass" && b.network !== "internet") {
    return { ok: false, error: "sandbox.network must be agentglass or internet" };
  }
  const read = pathList(b.read, "read");
  if ("error" in read) return { ok: false, error: read.error };
  const write = pathList(b.write, "write");
  if ("error" in write) return { ok: false, error: write.error };
  let programs: string[] = [];
  if (b.programs !== undefined) {
    if (!Array.isArray(b.programs) || b.programs.length > MAX_ENTRIES) return { ok: false, error: `sandbox.programs must be a list of at most ${MAX_ENTRIES} command names` };
    for (const p of b.programs) {
      if (typeof p !== "string" || !PROGRAM_RE.test(p) || p === "." || p === "..") return { ok: false, error: "sandbox.programs entries must be bare command names, with no slash" };
    }
    programs = [...new Set(b.programs as string[])].sort();
  }
  return { ok: true, value: { network: b.network === "internet" ? "internet" : "agentglass", read: read.list, write: write.list, programs } };
}

/** Folders whose name alone says what is inside. */
const SECRET_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".pgpass",
  ".git-credentials", ".password-store", ".gnome-keyring", "keyrings",
]);
/** `~/.config/<name>`: tools that keep a login there. */
const SECRET_CONFIG = new Set(["gh", "gcloud", "rclone", "hub", "glab-cli"]);
const SECRET_NAME = /(token|secret|credential|passwd|password|auth\.json|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa|dsa)|keyring|keychain)/i;

/**
 * Why a path looks like it holds a login, or null. A hint for the reviewer,
 * not a fence: the fence is `NEVER_MOUNTABLE`, and a secret this cannot name
 * is still a grant the screen lists in full.
 */
export function secretGrant(path: string): string | null {
  const segs = segments(path);
  const i = segs.indexOf(".config");
  if (i >= 0 && SECRET_CONFIG.has(segs[i + 1] ?? "")) return `keeps a login for ${segs[i + 1]}`;
  for (const s of segs) {
    if (SECRET_SEGMENTS.has(s)) return `${s} holds credentials`;
    if (SECRET_NAME.test(s)) return "the name says it holds a secret";
  }
  return null;
}

export interface SandboxGrant { path: string; secret: string | null }

/** What the approval screen draws, decided here so it can be tested without a renderer. */
export function describeSandbox(s: PluginSandbox): {
  internet: boolean; reads: SandboxGrant[]; writes: SandboxGrant[]; programs: string[]; secretCount: number;
} {
  const grant = (path: string): SandboxGrant => ({ path, secret: secretGrant(path) });
  const reads = s.read.map(grant);
  const writes = s.write.map(grant);
  return {
    internet: s.network === "internet", reads, writes, programs: s.programs,
    secretCount: [...reads, ...writes].filter((g) => g.secret).length,
  };
}

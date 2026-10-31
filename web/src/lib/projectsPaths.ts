// Paths, names and URLs for the Open projects modal, as pure functions.
//
// There is no renderer in this project, so everything the modal decides about
// text lives here where a test can ask it, instead of inside the JSX.

// Mirrors isAbsoluteLike() in server/src/fsbrowse.ts: POSIX absolute (`/...`)
// or a Windows drive-letter root. Kept local: this is the client bundle.
const DRIVE_LETTER_ROOT = /^[a-zA-Z]:[\\/]/;
export const isAbsoluteLike = (p: string): boolean => p.startsWith("/") || DRIVE_LETTER_ROOT.test(p);

export const parentOf = (p: string): string => p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

/** The home directory a path sits under, read from the path itself. The client
 *  does not know it, and `~/code/acme` is how a person says a path. */
export function tildify(p: string): string {
  const m = p.match(/^(\/home\/[^/]+|\/Users\/[^/]+)(\/.*)?$/);
  return m ? "~" + (m[2] ?? "") : p;
}

/** A path split so the END stays visible: everything before the last two
 *  segments can be cut with an ellipsis, the last two never are. Three folders
 *  that differ only in the middle must still read as three folders. */
export function middleSplit(p: string): { head: string; tail: string } {
  const parts = p.split("/");
  if (parts.length <= 3) return { head: "", tail: p };
  const tail = "/" + parts.slice(-2).join("/");
  return { head: p.slice(0, p.length - tail.length), tail };
}

/** A folder for the rail: the front is cut, the folder's own name is kept
 *  (`…/old-company-projects`). The full path rides in the tooltip. */
export function railLabel(p: string, max = 26): string {
  const t = tildify(p);
  if (t.length <= max) return t;
  const last = t.split("/").filter(Boolean).pop() ?? t;
  return "…/" + last;
}

/** Where a new project should go, guessed from where the existing ones live:
 *  the commonest parent beats any hardcoded `~/code`. */
export function likelyParent(repos: readonly { root: string }[] | null, workspace: string | null | undefined): string {
  if (workspace) return parentOf(workspace);
  const count = new Map<string, number>();
  for (const r of repos ?? []) {
    const p = parentOf(r.root);
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  let best = "", n = 0;
  for (const [p, c] of count) if (c > n) { best = p; n = c; }
  return best || "~";
}

/** "2h ago", "yesterday", "3d ago", "2w ago", "5mo ago"; "" when unknown. */
export function relTime(ms: number, now: number): string {
  if (!ms || ms <= 0) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** 0:21, 1:05 — an elapsed clock for a step with no honest percentage. */
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/* ------------------------------------------------------------- names */

/** Mirrors validProjectName() in server/src/projectadd.ts. */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const validName = (n: string): boolean => SAFE_NAME.test(n) && n !== "." && n !== "..";

/** What is wrong with a project name as it is typed — no server call needed to
 *  know. null when it is fine, or still empty (nothing to complain about yet). */
export function nameError(raw: string): { message: string; suggestion: string } | null {
  const n = raw.trim();
  if (!n) return null;
  if (validName(n)) return null;
  const suggestion = n.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  const bad = Array.from(new Set(n.split("").filter((c) => !/[A-Za-z0-9._-]/.test(c)))).map((c) => (c === " " ? "spaces" : `“${c}”`));
  const message = n === "." || n === ".."
    ? "That is not a name a folder can have."
    : bad.length ? `Only letters, digits, “-”, “_” and “.”. ${bad.join(" and ")} ${bad.length === 1 && bad[0] !== "spaces" ? "is" : "are"} not allowed.` : "That name is too long (100 characters at most).";
  return { message, suggestion: validName(suggestion) ? suggestion : "" };
}

/* -------------------------------------------------------------- urls */

const URL_SCHEME = /^(https?|ssh|git):\/\/[^\s]+$/i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;

/** Mirrors cloneUrlError() in server/src/projectadd.ts, so the field can say
 *  "not a repository URL" before anything is sent. null when it can be cloned;
 *  "" while nothing is typed. */
export function cloneUrlError(url: string): string | null {
  const u = url.trim();
  if (!u) return "";
  if (u.length > 2048) return "That URL is too long";
  if (/[\s\u0000-\u001f\u007f]/.test(u)) return "That URL contains characters a repository address cannot have";
  if (u.startsWith("-")) return "A URL cannot start with “-”";
  if (/^ext::/i.test(u) || /^file:/i.test(u) || u.includes("::")) return "That transport is not allowed — use https, ssh or git@host:path";
  if (!URL_SCHEME.test(u) && !SCP_LIKE.test(u)) return "That does not look like a repository URL (https://…, ssh://… or git@host:path)";
  return null;
}

/** Mirrors cloneTargetName(): git's rule, held to the same closed character set. */
export function cloneTargetName(url: string): string | null {
  let rest = url.trim().split(/[?#]/)[0]!.replace(/\/+$/, "");
  const scheme = rest.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    rest = slash >= 0 ? rest.slice(slash + 1) : "";
  } else {
    const colon = rest.indexOf(":");
    rest = colon >= 0 ? rest.slice(colon + 1) : rest;
  }
  const name = (rest.split("/").pop() ?? "").replace(/\.git$/i, "");
  return validName(name) ? name : null;
}

/** Where a clone or a new project will land, or null while the input cannot
 *  name a place (an invalid URL or name must not draw a made-up path). */
export function targetPreview(kind: "clone" | "new", input: string, parent: string): string | null {
  const base = parent.trim().replace(/\/+$/, "");
  if (!base) return null;
  if (kind === "clone") {
    if (cloneUrlError(input) !== null) return null;
    const name = cloneTargetName(input);
    return name ? `${base}/${name}` : null;
  }
  const n = input.trim();
  return n && validName(n) ? `${base}/${n}` : null;
}

/** The folder a clone or a new project should join, so that two actions do not
 *  leave two near-identical entries in the rail. Nothing when the project is
 *  already inside a listed folder; otherwise its parent; the project itself
 *  only when the parent was refused as too broad (see `fallback`). */
export function folderToJoin(project: string, parent: string, roots: readonly string[], fallback = false): string | null {
  const inside = (dir: string) => project === dir || project.startsWith(dir.replace(/\/+$/, "") + "/");
  if (roots.some(inside)) return null;
  return fallback ? project : parent.replace(/\/+$/, "") || project;
}

/* ------------------------------------------------------------ folders */

export type FolderState = "empty" | "checking" | "missing" | "ok" | "zero" | "already";
export interface FolderVerdict {
  state: FolderState;
  /** One sentence for under the field. */
  help: string;
  /** Projects this would add (new ones only). */
  fresh: number;
  /** The primary button's label. */
  label: string;
  /** Why the button is off, when it is. */
  reason?: string;
  canAdd: boolean;
}

/** What the folder pane says about the text in its field, from the server's
 *  read-only check. `listedUnder` is how many of its projects the list shows
 *  already; `isListed` is whether the folder itself is one of the added ones. */
export function folderVerdict(text: string, pre: { exists: boolean; repos: number; path: string } | null, listedUnder: number, isListed: boolean): FolderVerdict {
  const off = (state: FolderState, reason: string, help = ""): FolderVerdict => ({ state, help, fresh: 0, label: "Add folder", reason, canAdd: false });
  if (!text.trim()) return off("empty", "Type an existing folder first");
  if (!pre) return off("checking", "Checking the folder…", "Checking…");
  if (!pre.exists) return off("missing", "Type an existing folder first", `No such folder: ${pre.path || text.trim()}`);
  if (isListed) return off("already", "That folder is already on your list", `${tildify(pre.path)} is already on your list.`);
  const fresh = Math.max(0, pre.repos - listedUnder);
  if (pre.repos === 0) return { state: "zero", help: "No git repositories in it (looked 4 levels deep).", fresh: 0, label: "Add anyway", canAdd: true };
  const already = listedUnder ? ` ${listedUnder} ${listedUnder === 1 ? "is" : "are"} already on your list.` : "";
  return { state: "ok", help: `Found ${pre.repos} git ${pre.repos === 1 ? "repository" : "repositories"}.${already}`, fresh, label: fresh ? `Add ${fresh} project${fresh === 1 ? "" : "s"}` : "Add folder", canAdd: true };
}

/** A project name split so its END stays visible (`…orbit-billing-v2`): the
 *  head may be cut with an ellipsis, the last `keep` characters never are.
 *  Names that differ only at the end must still read as different projects. */
export function nameSplit(name: string, keep = 14): { head: string; tail: string } {
  if (name.length <= keep * 2) return { head: "", tail: name };
  return { head: name.slice(0, name.length - keep), tail: name.slice(-keep) };
}

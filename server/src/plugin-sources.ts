/**
 * Where a plugin came from, and what is safe to copy off a stranger's
 * repository onto this disk.
 *
 * `plugins.ts` already answers "install = copy, nothing runs". This file
 * answers the question underneath it: which strings are even a repository
 * address, and once cloned, how much of the tree is this willing to trust
 * enough to read.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * "Where did this come from" as a closed set of shapes rather than a free
 * string, so the question stays answerable after the fact instead of
 * degrading into "some text a person typed once."
 *
 * A marketplace install carries BOTH the catalogue it was found in and the
 * plugin entry inside that catalogue — either alone cannot answer "where did
 * this come from": the catalogue without the entry can't say which plugin,
 * the entry without the catalogue can't say who vouched for it.
 */
export type InstallSource =
  | { kind: "local-path"; path: string }
  | { kind: "git"; url: string; ref: string | null }
  | {
      kind: "marketplace";
      marketplace: { url: string; ref: string | null; resolvedCommit: string | null };
      plugin: { url: string; ref: string | null };
    };

/** `https://…` with no `user:pass@` — a URL that carries a credential is a
 *  credential this would copy into a JSON file on disk — or an ssh URL, or
 *  the scp-like `user@host:path` every git host prints on its own page. */
const HTTPS_NO_AUTH = /^https:\/\/(?!.*@)[^\s]+$/i;
const SSH_URL = /^ssh:\/\/[^\s]+$/i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;

/** Why this cannot be a plugin's git source, or null when it can. Stricter
 *  than `projectadd.ts`'s `cloneUrlError`: that one accepts plain `http://`
 *  and a URL with embedded credentials because it clones a project the
 *  person already trusts by having typed its address themselves. A plugin
 *  address is typed once and then re-used to auto-update from — an embedded
 *  password would sit in `plugins.json` from then on, and plain `http://`
 *  hands that password to whoever is on the wire. */
export function pluginGitUrlError(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "Provide a git URL";
  const u = url.trim();
  if (u.length > 2048) return "That URL is too long";
  if (/[\s\x00-\x1f\x7f]/.test(u)) return "That URL contains characters a repository address cannot have";
  if (u.startsWith("-")) return "A URL cannot start with “-”";
  if (HTTPS_NO_AUTH.test(u) || SSH_URL.test(u) || SCP_LIKE.test(u)) return null;
  if (/^https:\/\//i.test(u)) return "That https URL has a username or password in it — plugin sources may not carry credentials";
  return "That does not look like a plugin URL (https://… with no credentials, ssh://…, or git@host:path)";
}

/** A catalogue is a plain file over HTTPS, not a git remote — same reasons
 *  as `pluginGitUrlError` (no embedded credentials, so nothing worth stealing
 *  ends up saved in `plugins.json`), minus the ssh/scp forms that only make
 *  sense for cloning. */
export function catalogueUrlError(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "Provide a catalogue URL";
  const u = url.trim();
  if (u.length > 2048) return "That URL is too long";
  if (/[\s\x00-\x1f\x7f]/.test(u)) return "That URL contains characters an address cannot have";
  if (!HTTPS_NO_AUTH.test(u)) return "That does not look like a catalogue URL (https://… with no credentials)";
  return null;
}

/** A ref name: a branch, tag or commit — never a flag. `git` reads an
 *  argument starting with `-` as an option the same way `projectadd.ts`
 *  already guards against for the URL itself. */
export function pluginRefError(ref: unknown): string | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref !== "string" || !ref.trim()) return "ref must be a non-empty string, or omitted";
  const r = ref.trim();
  if (r.length > 200 || r.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(r)) return "That does not look like a git ref";
  return null;
}

/** What one plugin folder may cost to install, mirroring the numbers of the
 *  shipping implementation this task's shape was measured from — 2000 files,
 *  50MB total for the whole plugin, and a smaller ceiling per artifact so
 *  one huge file can't spend the whole budget alone. */
export const MAX_FILES = 2000;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface WalkResult {
  ok: boolean;
  error: string | null;
  files: string[];
  totalBytes: number;
}

/**
 * Walk a plugin directory once, for two reasons at the same time: containment
 * and content identity share the same tree traversal, and doing it twice
 * would mean the two could disagree about what "the plugin" is.
 *
 * `.git` is skipped — a clone's history is not part of what runs or what was
 * reviewed, and it can be large enough on its own to blow the byte cap for
 * no reason a reviewer would recognise as the plugin's fault.
 *
 * Every path is resolved with `realpathSync` and refused if it points
 * outside `dir` — a symlink inside the copied tree pointing at `/etc/passwd`
 * or back out to the host filesystem is the obvious way a "small, harmless"
 * plugin folder stops being either.
 */
export function walkPluginDir(dir: string): WalkResult {
  const root = realpathSync(dir);
  const files: string[] = [];
  let totalBytes = 0;

  function walk(abs: string): string | null {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    for (const ent of entries) {
      if (ent.name === ".git") continue;
      const child = join(abs, ent.name);
      let real: string;
      try { real = realpathSync(child); } catch { return `could not resolve ${relative(root, child)}`; }
      if (real !== root && !real.startsWith(root + sep)) {
        return `${relative(root, child)} resolves outside the plugin directory`;
      }
      if (ent.isDirectory()) {
        const err = walk(child);
        if (err) return err;
        continue;
      }
      if (!ent.isFile()) continue;
      files.push(relative(root, child));
      if (files.length > MAX_FILES) return `more than ${MAX_FILES} files`;
      const size = statSync(real).size;
      if (size > MAX_ARTIFACT_BYTES) return `${relative(root, child)} is larger than ${MAX_ARTIFACT_BYTES / (1024 * 1024)}MB`;
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_BYTES) return `plugin is larger than ${MAX_TOTAL_BYTES / (1024 * 1024)}MB in total`;
    }
    return null;
  }

  const err = walk(root);
  if (err) return { ok: false, error: err, files, totalBytes };
  return { ok: true, error: null, files, totalBytes };
}

/**
 * A content identity for the parts an update could quietly rewrite without
 * touching the manifest at all — the entrypoint script, whatever it loads.
 * File paths are sorted first so the hash does not depend on directory
 * iteration order, which readdir makes no promise about.
 */
export function contentHash(dir: string, files: string[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

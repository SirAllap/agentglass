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
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

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
      /** `sha256` is the content hash the catalogue listed, kept so an
       *  update of a pinned install is held to it as the install was. */
      plugin: { url: string; ref: string | null; sha256?: string };
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

/** A full commit id — the only ref that names bytes rather than a pointer
 *  somebody can move. A catalogue pins one, and it is fetched by id rather
 *  than cloned by name, because `git clone --branch` takes a branch or a tag
 *  and refuses a commit. */
export const FULL_COMMIT = /^[0-9a-f]{40}$/;

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
  /** Every entry `contentHash` reads: the files, and the links as links. */
  files: string[];
  totalBytes: number;
}

/**
 * A path inside a plugin as its hash spells it: `/` between the parts on
 * every platform. Windows' `\` made a Windows install hash every pinned
 * tree to something no catalogue listed, since the catalogue's hash is made
 * on Linux.
 */
export const hashPath = (rel: string, separator: string = sep): string => rel.split(separator).join("/");

/**
 * A link's target as its hash reads it. Git for Windows writes a link's
 * target with `\` where the same link reads `/` everywhere else, so on
 * Windows it is read back with `/`. Where git makes no links at all, the
 * default there, a link arrives as a file holding its target: that hashes as
 * a file, and a pinned plugin that ships a link is refused on that machine
 * rather than installed with a script that is only a path.
 */
export function linkText(raw: Buffer, platform: NodeJS.Platform = process.platform): Buffer {
  return platform === "win32" ? Buffer.from(raw.toString("latin1").replaceAll("\\", "/"), "latin1") : raw;
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
 *
 * A link that stays inside is one of the plugin's entries, never followed:
 * `contentHash` reads what it says, because which script an entrypoint
 * reaches is as much the plugin as the script. It is also judged by that
 * text, not only by where it lands today — this runs on a staging folder
 * and the plugin is copied somewhere else afterwards. An absolute link names
 * the staging folder and dangles in the copy, and one that climbs out and
 * back in by the folder's own name finds another folder once the plugin is
 * installed under a different one. So a link is relative, and read from the
 * folder's root it never climbs above it. That is a reading of the text: a
 * link through another link (`up -> .`, then `up/up/../<name>/x`) can still
 * spell its way out and back in. What stops that one is the physical check
 * above, run on a staging folder whose name nobody can guess; a check that
 * walks a folder with a fixed name, as the catalogue's do, does not see it,
 * and the app then refuses the listing at install.
 */
export function walkPluginDir(dir: string): WalkResult {
  const root = realpathSync(dir);
  const files: string[] = [];
  let totalBytes = 0;

  function walk(abs: string): string | null {
    let entries: Buffer[];
    // Bun hands these back as plain Uint8Arrays, so each is made a Buffer.
    try { entries = readdirSync(abs, { encoding: "buffer" }).map((b) => Buffer.from(b)); } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    for (const raw of entries) {
      // Names as bytes, because a name that is not UTF-8 arrives as a string
      // with U+FFFD in place of the bad byte: with a file of that U+FFFD name
      // beside it, the walk read the decoy twice and the real file never, and
      // the real file could change under an approval. A backslash is a
      // separator to this runtime's resolver on every platform. The CLI
      // refuses both names too, so the two walks never see different trees.
      const name = raw.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(raw)) return `${hashPath(relative(root, abs)) || "the plugin folder"} holds a name that is not UTF-8`;
      if (name.includes("\\")) return `${hashPath(relative(root, join(abs, name)))} has a backslash in its name`;
      if (name === ".git") continue;
      const child = join(abs, name);
      // The entry's own type, never its target's (Bun's Dirent carries no
      // name when names are read as bytes).
      let ent;
      try { ent = lstatSync(child); } catch { return `could not read ${relative(root, child)}`; }
      let real: string;
      try { real = realpathSync(child); } catch { return `could not resolve ${relative(root, child)}`; }
      if (real !== root && !real.startsWith(root + sep)) {
        return `${relative(root, child)} resolves outside the plugin directory`;
      }
      if (ent.isSymbolicLink()) {
        const rel = hashPath(relative(root, child));
        const target = readlinkSync(child);
        if (isAbsolute(target)) return `${rel} is a link to an absolute path; a plugin's links are relative`;
        const read = normalize(join(dirname(rel), target));
        if (read === ".." || read.startsWith(".." + sep)) return `${rel} is a link that climbs outside the plugin directory`;
        files.push(rel);
        if (files.length > MAX_FILES) return `more than ${MAX_FILES} files`;
        continue;
      }
      if (ent.isDirectory()) {
        const err = walk(child);
        if (err) return err;
        continue;
      }
      if (!ent.isFile()) continue;
      files.push(hashPath(relative(root, child)));
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
 * touching the manifest at all — the entrypoint script, whatever it loads,
 * and the links that decide which of them runs.
 *
 * Each entry is its path, a NUL, `f` for a file, `x` for a file that may be
 * run or `l` for a link, the sha256 of the file's bytes or of the link's
 * text, and a newline. A path
 * holds no NUL and the digest is fixed-length, so no entry can be read as
 * the end of one and the start of the next. The layout before this ran raw
 * bytes together with NULs between them, and a file carrying a NUL and the
 * next entry inside it hashed exactly like the two files it spelled out.
 *
 * Paths are sorted by their UTF-8 bytes, which is the order Python's
 * `sorted` gives the CLI's copy of this; readdir makes no promise about
 * order at all, and sorting by UTF-16 unit disagreed with the CLI about
 * names past the BMP.
 */
export function contentHash(dir: string, files: string[], platform: NodeJS.Platform = process.platform): string {
  const h = createHash("sha256");
  const indexed = indexExecutables(dir);
  for (const f of [...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const p = join(dir, f);
    const st = lstatSync(p);
    const link = st.isSymbolicLink();
    const bytes = link ? linkText(readlinkSync(p, { encoding: "buffer" })) : readFileSync(p);
    h.update(f);
    h.update("\0");
    h.update(link ? "l" : indexed.has(f) || (platform !== "win32" && (st.mode & 0o100) !== 0) ? "x" : "f");
    h.update(createHash("sha256").update(bytes).digest("hex"));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * The files git's index records as executable (mode 100755), when `dir` is
 * itself a checkout; empty otherwise.
 *
 * Windows keeps no executable bit on disk, and Git for Windows keeps the
 * committed one in its index, so a pinned install there reaches the hash
 * the catalogue took on Linux only by reading it here. Elsewhere a checkout's
 * disk says the same as its index; the disk is read as well, so a local
 * folder with a bit set and not yet staged hashes as what runs.
 *
 * Only a `.git` at the folder's own root, named explicitly: a plugin in a
 * subfolder of a checkout is judged by its own folder, as the copy the app
 * installs from carries no `.git`, and no `GIT_*` variable from this
 * process's environment picks another index. A `.git` git cannot read is
 * the same as none, and the disk decides.
 */
function indexExecutables(dir: string): Set<string> {
  const found = new Set<string>();
  if (!existsSync(join(dir, ".git"))) return found;
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  try {
    const p = Bun.spawnSync(
      ["git", "-c", "core.fsmonitor=false", "--git-dir", join(dir, ".git"), "--work-tree", dir, "ls-files", "--stage", "-z"],
      { cwd: dir, env, stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    if (p.exitCode !== 0) return found;
    for (const entry of p.stdout.toString("utf8").split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab > 0 && entry.startsWith("100755 ")) found.add(entry.slice(tab + 1));
    }
  } catch { /* no git: the disk decides */ }
  return found;
}

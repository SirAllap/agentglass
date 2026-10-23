/*
 * Open With: the applications that can open a file, and starting one.
 *
 * The list comes from the desktop entries the machine already has (the same
 * `applications/` folders every launcher reads) and from `mimeapps.list`, which
 * says what the person chose before. Starting one never takes a command from the
 * caller: the caller names an entry by its id, the command is the one the entry
 * itself declares, and the files are separate arguments after it. Nothing goes
 * through a shell.
 *
 * Ceilings: the Exec field codes %f %F %u %U %i %c are expanded and the rest are
 * dropped (the spec's deprecated ones); a type is matched by its exact name, not
 * through the shared-mime-info alias and parent tables; Terminal=true entries use
 * xdg-terminal-exec or $TERMINAL and nothing else.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { browseReal } from "./browse.ts";
import { runTool } from "./volumes.ts";

type Run = (argv: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>;

export interface DesktopEntry { id: string; name: string; comment: string; icon: string; exec: string; mimeTypes: string[]; shown: boolean; terminal: boolean; tryExec: string }
export interface AppRow { id: string; name: string; comment: string; icon: string }

const ID = /^[A-Za-z0-9._+-]+\.desktop$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/** Only the `[Desktop Entry]` group: its actions and other groups are not the application itself. */
export function parseDesktop(id: string, text: string): DesktopEntry | null {
  let inMain = false;
  const kv: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { inMain = line === "[Desktop Entry]"; continue; }
    if (!inMain) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (key in kv || key.includes("[")) continue; // a translated key is not the name, and the first wins
    kv[key] = line.slice(eq + 1).trim();
  }
  if (kv.Type !== "Application" || !kv.Exec || !kv.Name) return null;
  return {
    id, name: kv.Name, comment: kv.Comment ?? "", icon: kv.Icon ?? "", exec: kv.Exec,
    mimeTypes: (kv.MimeType ?? "").split(";").map((m) => m.trim()).filter(Boolean),
    shown: kv.NoDisplay !== "true" && kv.Hidden !== "true",
    terminal: kv.Terminal === "true", tryExec: kv.TryExec ?? "",
  };
}

const dataHome = () => process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const dataDirs = () => [dataHome(), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean)];
const configHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const pathEnv = () => process.env.PATH ?? "";

function installed(e: DesktopEntry): boolean {
  const probe = (p: string) => (p.startsWith("/") ? existsSync(p) : !!Bun.which(p, { PATH: pathEnv() }));
  if (e.tryExec && !probe(e.tryExec)) return false;
  const first = splitExec(e.exec)[0];
  return !!first && probe(first);
}

/** Every entry on the machine by id; the person's own folder wins over the system's. */
function allEntries(): Map<string, DesktopEntry> {
  const out = new Map<string, DesktopEntry>();
  const walk = (root: string, rel: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (n.endsWith(".desktop")) {
        const id = r.replace(/\//g, "-");
        if (!ID.test(id) || out.has(id)) continue;
        try { const e = parseDesktop(id, readFileSync(join(root, r), "utf8")); if (e) out.set(id, e); } catch { /* unreadable: not an entry */ }
      } else if (depth < 2 && !n.includes(".")) walk(root, r, depth + 1);
    }
  };
  for (const d of dataDirs()) walk(join(d, "applications"), "", 0);
  return out;
}

interface MimeApps { defaults: Record<string, string[]>; added: Record<string, string[]>; removed: Record<string, string[]> }
function readMimeApps(): MimeApps {
  const m: MimeApps = { defaults: {}, added: {}, removed: {} };
  for (const f of [join(configHome(), "mimeapps.list"), join(dataHome(), "applications", "mimeapps.list")]) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    let into: Record<string, string[]> | null = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) { into = line === "[Default Applications]" ? m.defaults : line === "[Added Associations]" ? m.added : line === "[Removed Associations]" ? m.removed : null; continue; }
      const eq = line.indexOf("=");
      if (!into || eq < 1 || line.startsWith("#")) continue;
      const mime = line.slice(0, eq), ids = line.slice(eq + 1).split(";").map((s) => s.trim()).filter(Boolean);
      into[mime] = [...(into[mime] ?? []), ...ids];
    }
  }
  return m;
}

const row = (e: DesktopEntry): AppRow => ({ id: e.id, name: e.name, comment: e.comment, icon: e.icon });
const byName = (a: DesktopEntry, b: DesktopEntry) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Who opens `mime`: the person's default first, then the others that declare it, then everything else that can be shown. */
export function appsFor(mime: string): { mime: string; defaultId: string | null; recommended: AppRow[]; other: AppRow[] } {
  const entries = allEntries(), ma = readMimeApps();
  const shown = [...entries.values()].filter((e) => e.shown && installed(e));
  const removed = new Set(ma.removed[mime] ?? []);
  const declares = (e: DesktopEntry) => !removed.has(e.id) && (e.mimeTypes.includes(mime) || (ma.added[mime] ?? []).includes(e.id));
  const rec = shown.filter(declares).sort(byName);
  const first = [...(ma.defaults[mime] ?? []), ...(ma.added[mime] ?? [])];
  rec.sort((a, b) => { const ia = first.indexOf(a.id), ib = first.indexOf(b.id); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || byName(a, b); });
  const defaultId = (ma.defaults[mime] ?? []).find((id) => rec.some((e) => e.id === id)) ?? null;
  const other = shown.filter((e) => !rec.includes(e)).sort(byName);
  return { mime, defaultId, recommended: rec.map(row), other: other.map(row) };
}

/** The applications every chosen file's type has in common, and Strata's sentence when there are none. */
export function appsForAll(mimes: string[]): { mimes: string[]; defaultId: string | null; recommended: AppRow[]; other: AppRow[]; empty?: string } {
  const uniq = [...new Set(mimes)];
  if (!uniq.length) return { mimes: [], defaultId: null, recommended: [], other: [], empty: "No compatible applications were found" };
  const each = uniq.map(appsFor);
  const common = each[0]!.recommended.filter((a) => each.every((r) => r.recommended.some((b) => b.id === a.id)));
  const ids = new Set(common.map((a) => a.id));
  const other = [...each[0]!.recommended, ...each[0]!.other].filter((a) => !ids.has(a.id));
  const defaultId = each.every((r) => r.defaultId === each[0]!.defaultId) ? each[0]!.defaultId : null;
  const empty = common.length || other.length ? undefined : uniq.length > 1 ? "No application can open all selected file types" : "No compatible applications were found";
  return { mimes: uniq, defaultId, recommended: common, other, ...(empty ? { empty } : {}) };
}

/** The desktop spec's quoting: double quotes group, a backslash escapes the next character; a shell is never involved. */
export function splitExec(exec: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false, any = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]!;
    if (c === "\\" && i + 1 < exec.length) { cur += exec[++i]; any = true; }
    else if (c === '"') { inQ = !inQ; any = true; }
    else if (!inQ && (c === " " || c === "\t")) { if (any) { out.push(cur); cur = ""; any = false; } }
    else { cur += c; any = true; }
  }
  if (any) out.push(cur);
  return out;
}

const fileUri = (p: string) => "file://" + p.split("/").map(encodeURIComponent).join("/");
/** Field codes are expanded inside one argument and never split it, so a file name is always one argument. */
export function expandExec(tokens: string[], files: string[], name: string, icon: string): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t === "%F") { out.push(...files); continue; }
    if (t === "%U") { out.push(...files.map(fileUri)); continue; }
    if (t === "%i") { if (icon) out.push("--icon", icon); continue; }
    let had = false;
    const s = t.replace(/%(.)/g, (_m, c: string) => {
      if (c === "%") return "%";
      had = true;
      if (c === "f") return files[0] ?? "";
      if (c === "u") return files[0] ? fileUri(files[0]) : "";
      if (c === "c") return name;
      return ""; // %k %d %D %n %N %v %m, and the list forms inside a larger string
    });
    if (had && s === "") continue;
    out.push(s);
  }
  return out;
}

const SINGLE = /(^|[^%])%[fu]/;
const terminal = (): string[] | null => {
  const x = Bun.which("xdg-terminal-exec", { PATH: pathEnv() });
  if (x) return [x];
  const t = process.env.TERMINAL && Bun.which(process.env.TERMINAL, { PATH: pathEnv() });
  return t ? [t, "-e"] : null;
};

/** Start the entry `id` on the files, each judged by the finder's boundary first. */
export async function launchApp(id: unknown, paths: unknown, opts: { local: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, error: "no such application" };
  const e = allEntries().get(id);
  if (!e || !e.shown || !installed(e)) return { ok: false, error: "no such application" };
  if (!Array.isArray(paths) || !paths.length || paths.length > 500) return { ok: false, error: "nothing selected" };
  const files: string[] = [];
  for (const p of paths) {
    const real = browseReal(p, opts.local);
    if (!real) return { ok: false, error: `${typeof p === "string" ? basename(p) : "that"}: outside what this may open` };
    try { statSync(real); } catch { return { ok: false, error: `${basename(real)}: no such file` }; }
    files.push(real);
  }
  const tokens = splitExec(e.exec);
  // %f and %u take one file, so several files are several starts, as the spec says.
  const batches = tokens.some((t) => SINGLE.test(t)) && files.length > 1 ? files.map((f) => [f]) : [files];
  let wrap: string[] = [];
  if (e.terminal) { const t = terminal(); if (!t) return { ok: false, error: `${e.name} needs a terminal and none was found (xdg-terminal-exec or $TERMINAL)` }; wrap = t; }
  for (const batch of batches) {
    const argv = [...wrap, ...expandExec(tokens, batch, e.name, e.icon)];
    const bin = argv[0]!.startsWith("/") ? argv[0]! : Bun.which(argv[0]!, { PATH: pathEnv() });
    if (!bin) return { ok: false, error: `${e.name} is not installed` };
    try {
      // Detached and with its output thrown away, like handing a file to the desktop: the application outlives this request.
      const p = Bun.spawn([bin, ...argv.slice(1)], { stdout: "ignore", stderr: "ignore", stdin: "ignore", cwd: homedir() });
      p.unref();
    } catch { return { ok: false, error: `${e.name} could not be started` }; }
  }
  return { ok: true };
}

/** "Always use for this file type": the one change this module makes to the person's settings, written by xdg-mime. */
export async function setDefaultApp(id: unknown, mime: unknown, run: Run = runTool): Promise<{ ok: boolean; error?: string }> {
  if (typeof id !== "string" || !ID.test(id) || !allEntries().has(id)) return { ok: false, error: "no such application" };
  if (typeof mime !== "string" || !MIME.test(mime)) return { ok: false, error: "not a file type" };
  const r = await run(["xdg-mime", "default", id, mime]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.code === 127 ? "xdg-mime is not installed" : "the default could not be saved" };
}

/** The type of a file, from the system's own database. */
export async function mimeOf(path: string, run: Run = runTool): Promise<string | null> {
  for (const argv of [["xdg-mime", "query", "filetype", path], ["file", "--brief", "--mime-type", path]]) {
    const r = await run(argv);
    const t = r.out.trim();
    if (r.code === 0 && MIME.test(t)) return t;
  }
  return null;
}

/*
 * The person's own actions in the finder: scripts and commands they define, shown
 * in the context menu for the files they apply to, run on the selection.
 *
 * Modelled on Strata's custom actions (docs/custom-actions.md there): one folder
 * per action holding `action.toml` and, for a script, the script beside it. They
 * are ordinary programs with the person's permissions and there is no sandbox.
 * What this module guarantees is the rest:
 *   - only a request with the desk key starts one (an agent may list them);
 *   - nothing is handed to a shell: the interpreter or program gets an argv, and
 *     every path in it is absolute, so a file name is never read as an option;
 *   - a definition is judged strictly before it is stored or run, and one that
 *     cannot load is reported as a problem rather than silently dropped;
 *   - the files are owner-only, and a linked folder or entrypoint is refused.
 *
 * Ceilings, named: no import/export of an action folder from the UI, no library of
 * recipes, no Strata-style `{parent}`-free MIME database (a type is the one `xdg-mime`
 * guesses), a command with no token in its arguments gets the selection after `--`
 * (Strata passes none), and cancelling signals the process group once, then kills it
 * after three seconds.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { browseReal } from "./browse.ts";
import { agentglassConfigDirs } from "./config.ts";
import { startExternalJob, listJobs, type JobView } from "./fsops.ts";
import { mimeOf } from "./openwith.ts";

export type Runtime = "python" | "bash" | "command";
export interface ActionManifest {
  schema_version: 1; id: string; name: string; description: string; icon: string; enabled: boolean; menu: "submenu" | "top";
  when: { kinds: ("file" | "folder")[]; extensions: string[]; mime_types: string[]; min_items: number; max_items: number | null };
  run: { runtime: Runtime; entrypoint: string; program: string; args: string[]; mode: "whole-selection" | "per-item"; on_error: "continue" | "stop"; working_directory: "parent" | "home" | "action"; confirm: boolean };
}
export interface Selected { name: string; kind: "file" | "folder"; mime?: string }
type R<T> = ({ ok: true } & T) | { ok: false; error: string };

export const actionsDir = (): string => join(resolve(agentglassConfigDirs()[0]!), "finder-actions");

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOP = new Set(["schema_version", "id", "name", "description", "icon", "enabled", "menu", "when", "run"]);
const WHEN = new Set(["kinds", "extensions", "mime_types", "min_items", "max_items"]);
const RUN = new Set(["runtime", "entrypoint", "program", "args", "mode", "on_error", "working_directory", "confirm"]);
const TOKENS = new Set(["{path}", "{paths}", "{parent}"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A definition as the file says it, judged. `dirId` is the folder's name, which is the id and cannot differ. */
export function parseManifest(dirId: string, text: string): R<{ action: ActionManifest }> {
  let t: Record<string, unknown>;
  try { t = Bun.TOML.parse(text) as Record<string, unknown>; } catch (e) { return { ok: false, error: `not valid TOML: ${String((e as Error).message).split("\n")[0]}` }; }
  const unknown = (o: Record<string, unknown>, allowed: Set<string>, where: string) => { const k = Object.keys(o).find((x) => !allowed.has(x)); return k ? `unknown key "${k}"${where}` : null; };
  const bad = (m: string): { ok: false; error: string } => ({ ok: false, error: m });
  const u = unknown(t, TOP, ""); if (u) return bad(u);
  if (t.schema_version !== 1) return bad(typeof t.schema_version === "number" && t.schema_version > 1 ? "this action needs a newer version of the finder (schema_version)" : "schema_version must be 1");
  if (typeof t.id !== "string" || !ID.test(t.id)) return bad("id: lowercase letters, digits, . - _ (1-64)");
  if (t.id !== dirId) return bad(`id "${t.id}" is not the folder's name "${dirId}"`);
  if (typeof t.name !== "string" || !t.name.trim() || t.name.length > 64) return bad("name must be 1-64 characters");
  if (t.description !== undefined && (typeof t.description !== "string" || t.description.length > 300)) return bad("description must be text of at most 300 characters");
  if (t.icon !== undefined && (typeof t.icon !== "string" || !/^[a-z0-9-]{1,40}$/.test(t.icon))) return bad("icon must be an icon name");
  if (t.enabled !== undefined && typeof t.enabled !== "boolean") return bad("enabled must be true or false");
  if (t.menu !== undefined && t.menu !== "submenu" && t.menu !== "top") return bad("menu must be submenu or top");
  const w = t.when === undefined ? {} : t.when;
  if (!isObj(w)) return bad("[when] must be a table");
  const uw = unknown(w, WHEN, " in [when]"); if (uw) return bad(uw);
  if (w.kinds !== undefined && (!strs(w.kinds) || w.kinds.some((k) => k !== "file" && k !== "folder"))) return bad("when.kinds: file, folder or both");
  if (w.extensions !== undefined && (!strs(w.extensions) || w.extensions.some((e) => !/^[a-z0-9][a-z0-9_+-]{0,15}$/.test(e)))) return bad("when.extensions: lowercase, without dots");
  if (w.mime_types !== undefined && (!strs(w.mime_types) || w.mime_types.some((m) => !/^[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+)$/.test(m)))) return bad("when.mime_types: like image/* or image/png");
  for (const k of ["min_items", "max_items"] as const) if (w[k] !== undefined && (!Number.isInteger(w[k]) || (w[k] as number) < 0 || (w[k] as number) > 100_000)) return bad(`when.${k} must be a whole number`);
  if (typeof w.min_items === "number" && typeof w.max_items === "number" && w.min_items > w.max_items) return bad("when.min_items is larger than max_items");
  if (!isObj(t.run)) return bad("[run] is required");
  const r = t.run;
  const ur = unknown(r, RUN, " in [run]"); if (ur) return bad(ur);
  if (r.runtime !== "python" && r.runtime !== "bash" && r.runtime !== "command") return bad("run.runtime: python, bash or command");
  const mode = r.mode === undefined ? "whole-selection" : r.mode;
  if (mode !== "whole-selection" && mode !== "per-item") return bad("run.mode: whole-selection or per-item");
  if (r.on_error !== undefined && r.on_error !== "continue" && r.on_error !== "stop") return bad("run.on_error: continue or stop");
  if (r.working_directory !== undefined && !["parent", "home", "action"].includes(r.working_directory as string)) return bad("run.working_directory: parent, home or action");
  if (r.confirm !== undefined && typeof r.confirm !== "boolean") return bad("run.confirm must be true or false");
  let entrypoint = "", program = "", args: string[] = [];
  if (r.runtime === "command") {
    if (r.entrypoint !== undefined) return bad("a command has no entrypoint");
    if (typeof r.program !== "string" || !r.program || /[\0\n]/.test(r.program)) return bad("run.program is required for a command");
    program = r.program;
    if (r.args !== undefined && !strs(r.args)) return bad("run.args must be a list of text");
    args = (r.args as string[] | undefined) ?? [];
    for (const a of args) {
      if (a.includes("\0")) return bad("an argument cannot hold a NUL");
      if (/\{(path|paths|parent)\}/.test(a) && !TOKENS.has(a)) return bad(`"${a}": a token must be a whole argument, so nothing is interpolated`);
      if (a === "{path}" && mode !== "per-item") return bad("{path} is for per-item runs; use {paths}");
      if (a === "{paths}" && mode !== "whole-selection") return bad("{paths} is for whole-selection runs; use {path}");
    }
  } else {
    if (r.program !== undefined || r.args !== undefined) return bad("run.program and run.args are for a command");
    if (typeof r.entrypoint !== "string" || !FILE.test(r.entrypoint) || r.entrypoint === "action.toml") return bad("run.entrypoint must be a plain file name beside the action");
    entrypoint = r.entrypoint;
  }
  return {
    ok: true,
    action: {
      schema_version: 1, id: t.id, name: t.name.trim(), description: (t.description as string | undefined) ?? "", icon: (t.icon as string | undefined) ?? "play",
      enabled: (t.enabled as boolean | undefined) ?? true, menu: (t.menu as "submenu" | "top" | undefined) ?? "submenu",
      when: { kinds: (w.kinds as ("file" | "folder")[] | undefined) ?? [], extensions: (w.extensions as string[] | undefined) ?? [], mime_types: (w.mime_types as string[] | undefined) ?? [], min_items: (w.min_items as number | undefined) ?? 1, max_items: (w.max_items as number | undefined) ?? null },
      run: { runtime: r.runtime, entrypoint, program, args, mode, on_error: (r.on_error as "continue" | "stop" | undefined) ?? "continue", working_directory: (r.working_directory as "parent" | "home" | "action" | undefined) ?? "parent", confirm: (r.confirm as boolean | undefined) ?? false },
    },
  };
}

const q = (v: unknown): string => Array.isArray(v) ? `[${v.map(q).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : String(v);
/** The file for a definition: the same keys Strata writes, with the empty ones left out. */
export function toToml(a: ActionManifest): string {
  const out = [`schema_version = 1`, `id = ${q(a.id)}`, `name = ${q(a.name)}`];
  if (a.description) out.push(`description = ${q(a.description)}`);
  out.push(`icon = ${q(a.icon)}`, `enabled = ${a.enabled}`, `menu = ${q(a.menu)}`, "", "[when]");
  if (a.when.kinds.length) out.push(`kinds = ${q(a.when.kinds)}`);
  if (a.when.extensions.length) out.push(`extensions = ${q(a.when.extensions)}`);
  if (a.when.mime_types.length) out.push(`mime_types = ${q(a.when.mime_types)}`);
  out.push(`min_items = ${a.when.min_items}`);
  if (a.when.max_items !== null) out.push(`max_items = ${a.when.max_items}`);
  out.push("", "[run]", `runtime = ${q(a.run.runtime)}`);
  if (a.run.runtime === "command") out.push(`program = ${q(a.run.program)}`, `args = ${q(a.run.args)}`); else out.push(`entrypoint = ${q(a.run.entrypoint)}`);
  out.push(`mode = ${q(a.run.mode)}`, `on_error = ${q(a.run.on_error)}`, `working_directory = ${q(a.run.working_directory)}`, `confirm = ${a.run.confirm}`, "");
  return out.join("\n");
}

const extOf = (name: string) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; };
const mimeOk = (pattern: string, mime: string) => pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern;

/** Offered only when EVERY selected entry satisfies it, so a mixed selection never runs on a subset the author did not mean. */
export function matchesSelection(a: ActionManifest, sel: readonly Selected[]): boolean {
  if (sel.length < a.when.min_items || sel.length === 0) return false;
  if (a.when.max_items !== null && sel.length > a.when.max_items) return false;
  return sel.every((s) =>
    (!a.when.kinds.length || a.when.kinds.includes(s.kind))
    && (!a.when.extensions.length || (s.kind === "file" && a.when.extensions.includes(extOf(s.name))))
    && (!a.when.mime_types.length || (!!s.mime && a.when.mime_types.some((p) => mimeOk(p, s.mime!)))));
}

/* ---- storing them ------------------------------------------------------ */

export interface ActionView extends ActionManifest { unavailable?: string; script?: string }
const pathEnv = () => process.env.PATH ?? "";
const which = (n: string) => (n.startsWith("/") ? (existsSync(n) ? n : null) : Bun.which(n, { PATH: pathEnv() }));

function unavailable(a: ActionManifest, dir: string): string | undefined {
  if (a.run.runtime === "command") return which(a.run.program) ? undefined : `${a.run.program} was not found`;
  const interp = a.run.runtime === "python" ? "python3" : "bash";
  if (!which(interp)) return `${interp} was not found`;
  try { const st = lstatSync(join(dir, a.run.entrypoint)); if (!st.isFile()) return `${a.run.entrypoint} is not a plain file`; } catch { return `${a.run.entrypoint} is missing`; }
  return undefined;
}

function load(id: string): R<{ action: ActionView; dir: string }> {
  if (!ID.test(id)) return { ok: false, error: "no such action" };
  const dir = join(actionsDir(), id);
  let st;
  try { st = lstatSync(dir); } catch { return { ok: false, error: "no such action" }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: "the action's folder is a link, which is not followed" };
  const f = join(dir, "action.toml");
  let ft;
  try { ft = lstatSync(f); } catch { return { ok: false, error: "action.toml is missing" }; }
  if (!ft.isFile()) return { ok: false, error: "action.toml is not a plain file" };
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch { return { ok: false, error: "action.toml could not be read" }; }
  const m = parseManifest(id, text);
  if (!m.ok) return m;
  const un = unavailable(m.action, dir);
  return { ok: true, dir, action: { ...m.action, ...(un ? { unavailable: un } : {}) } };
}

export function listActions(): { actions: ActionView[]; problems: { id: string; error: string }[] } {
  const actions: ActionView[] = [], problems: { id: string; error: string }[] = [];
  let names: string[] = [];
  try { names = readdirSync(actionsDir()); } catch { return { actions, problems }; }
  for (const n of names.sort()) {
    const r = load(n);
    if (r.ok) actions.push(r.action); else problems.push({ id: n, error: r.error });
  }
  return { actions, problems };
}

/** The actions the menu offers for these paths: enabled, loadable, and matching every one of them. */
export async function actionsFor(pathsIn: unknown, source: unknown, local: boolean): Promise<ActionView[]> {
  if (!Array.isArray(pathsIn) || !pathsIn.length || pathsIn.length > 1000 || (source !== "selection" && source !== "background")) return [];
  const sel: Selected[] = [];
  for (const p of pathsIn) {
    const real = browseReal(p, local);
    if (!real) return [];
    let st; try { st = statSync(real); } catch { return []; }
    sel.push({ name: basename(real), kind: st.isDirectory() ? "folder" : "file" });
  }
  const { actions } = listActions();
  const ready = actions.filter((a) => a.enabled && !a.unavailable);
  // The type of a file is looked up only when some action asks for one.
  if (ready.some((a) => a.when.mime_types.length)) for (let i = 0; i < sel.length; i++) sel[i]!.mime = (await mimeOf(browseReal(pathsIn[i], local)!)) ?? undefined;
  return ready.filter((a) => matchesSelection(a, sel));
}

/** One action with its script, for the editor. */
export function readAction(id: string): R<{ action: ActionView }> {
  const r = load(id);
  if (!r.ok) return r;
  let script: string | undefined;
  if (r.action.run.runtime !== "command") { try { script = readFileSync(join(r.dir, r.action.run.entrypoint), "utf8"); } catch { script = ""; } }
  return { ok: true, action: { ...r.action, ...(script !== undefined ? { script } : {}) } };
}

const writeOwnerOnly = (file: string, text: string) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
};

/** Create or change one. `create` never replaces a folder that exists; an edit never creates one. */
export function saveAction(input: { manifest: string | Record<string, unknown>; script?: string }, o: { create: boolean }): R<{ id: string }> {
  const text = typeof input.manifest === "string" ? input.manifest : null;
  let parsed: R<{ action: ActionManifest }>;
  if (text !== null) {
    const idm = /^\s*id\s*=\s*"([^"\n]*)"/m.exec(text);
    parsed = parseManifest(idm?.[1] ?? "", text);
  } else {
    const obj = input.manifest as Record<string, unknown>;
    try { parsed = parseManifest(typeof obj.id === "string" ? obj.id : "", toToml(obj as unknown as ActionManifest)); } catch { return { ok: false, error: "that is not an action definition" }; }
  }
  if (!parsed.ok) return parsed;
  const a = parsed.action;
  if (input.script !== undefined && (typeof input.script !== "string" || input.script.length > 256 * 1024 || input.script.includes("\0"))) return { ok: false, error: "the script is too large or holds a NUL" };
  const dir = join(actionsDir(), a.id);
  try {
    let st; try { st = lstatSync(dir); } catch { st = null; }
    if (o.create && st) return { ok: false, error: `an action called ${a.id} already exists` };
    if (!o.create && (!st || st.isSymbolicLink() || !st.isDirectory())) return { ok: false, error: "no such action" };
    if (!st) { mkdirSync(actionsDir(), { recursive: true, mode: 0o700 }); mkdirSync(dir, { mode: 0o700 }); }
    chmodSync(dir, 0o700);
    if (a.run.runtime !== "command" && input.script !== undefined) {
      try { if (lstatSync(join(dir, a.run.entrypoint)).isSymbolicLink()) return { ok: false, error: "the entrypoint is a link, which is not followed" }; } catch { /* new file */ }
      writeOwnerOnly(join(dir, a.run.entrypoint), input.script);
    }
    writeOwnerOnly(join(dir, "action.toml"), text ?? toToml(a));
  } catch (e) { return { ok: false, error: `could not be saved: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  return { ok: true, id: a.id };
}

export function deleteAction(id: unknown): R<object> {
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, error: "no such action" };
  const dir = join(actionsDir(), id);
  let st; try { st = lstatSync(dir); } catch { return { ok: false, error: "no such action" }; }
  if (st.isSymbolicLink()) { rmSync(dir, { force: true }); return { ok: true }; } // the link goes; what it pointed at stays
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/* ---- running them ------------------------------------------------------ */

/** The two or three values a script sees, so a script can be written without the docs open. */
const PY_HELPER = `# agentglass finder actions: the helper a Python action imports (stdlib only).
import json, os, sys

class Context:
    def __init__(self):
        e = os.environ
        with open(e["AGENTGLASS_ACTION_PATHS"], "rb") as f:
            raw = f.read()
        self._bytes = [p for p in raw.split(b"\\0") if p]
        self.paths = [os.fsdecode(p) for p in self._bytes]
        self.count = len(self.paths)
        self.single = self.paths[0] if self.count == 1 else None
        self.action_id = e.get("AGENTGLASS_ACTION_ID", "")
        self.version = e.get("AGENTGLASS_ACTION_VERSION", "1")
        self.mode = e.get("AGENTGLASS_ACTION_MODE", "")
        self.source = e.get("AGENTGLASS_ACTION_SOURCE", "")
        with open(e["AGENTGLASS_ACTION_PARENT"], "rb") as f:
            self.parent = os.fsdecode(f.read())
        self.directory = e.get("AGENTGLASS_ACTION_DIR", "")
        self.run_directory = e.get("AGENTGLASS_ACTION_RUN_DIR", "")
        self.position = int(e["AGENTGLASS_ACTION_POSITION"]) if e.get("AGENTGLASS_ACTION_POSITION") else None
        self._progress = e.get("AGENTGLASS_ACTION_PROGRESS")

    def paths_bytes(self):
        return list(self._bytes)

    def log(self, message):
        sys.stdout.write(str(message).encode("utf-8", "backslashreplace").decode("utf-8") + "\\n")
        sys.stdout.flush()

    def _emit(self, obj):
        if self._progress:
            with open(self._progress, "a", encoding="utf-8") as f:
                f.write(json.dumps(obj) + "\\n")

    def progress(self, processed, total=None, message=None):
        o = {"event": "progress", "processed": int(processed)}
        if total is not None: o["total"] = int(total)
        if message: o["message"] = str(message)
        self._emit(o)

    def output(self, path):
        self._emit({"event": "output", "path": str(path)})

def context():
    return Context()
`;

const OUTPUT_CAP = 64 * 1024;
const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CACHE_HOME"];

export function argvFor(a: ActionManifest, dir: string, paths: readonly string[], parent: string): string[] | null {
  if (a.run.runtime === "bash") { const b = which("bash"); return b ? [b, join(dir, a.run.entrypoint)] : null; }
  if (a.run.runtime === "python") { const p = which("python3"); return p ? [p, join(dir, a.run.entrypoint)] : null; }
  const prog = which(a.run.program);
  if (!prog) return null;
  const out: string[] = [];
  let used = false;
  for (const x of a.run.args) {
    if (x === "{paths}" || x === "{path}") { out.push(...paths); used = true; }
    else if (x === "{parent}") { out.push(parent); used = true; }
    else out.push(x);
  }
  // No token: the selection still has to reach the program, and after `--` a name can never be read as an option.
  if (!used) out.push("--", ...paths);
  return [prog, ...out];
}

const cleanEnv = (extra: Record<string, string>): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) e[k] = process.env[k]!;
  return { ...e, ...extra };
};

async function readCapped(stream: ReadableStream<Uint8Array> | null, into: { text: string; cut: boolean }) {
  if (!stream) return;
  const dec = new TextDecoder();
  for await (const chunk of stream) {
    if (into.text.length < OUTPUT_CAP) into.text += dec.decode(chunk, { stream: true });
    else into.cut = true;
  }
  if (into.text.length > OUTPUT_CAP) { into.text = into.text.slice(0, OUTPUT_CAP); into.cut = true; }
}

function readProgress(file: string): { done: number; total: number | null } | null {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  let last: { done: number; total: number | null } | null = null;
  for (const line of text.split("\n").slice(0, 2000)) {
    try {
      const o = JSON.parse(line) as { event?: string; processed?: number; total?: number };
      if (o.event === "progress" && Number.isInteger(o.processed) && o.processed! >= 0 && o.processed! < 1e12) last = { done: o.processed!, total: Number.isInteger(o.total) && o.total! > 0 ? o.total! : null };
    } catch { /* a malformed line is ignored */ }
  }
  return last;
}

export async function runAction(id: unknown, pathsIn: unknown, source: unknown, o: { local: boolean; deskProven: boolean; confirmed?: boolean }): Promise<{ ok: true; job: JobView } | { ok: false; error: string; confirm?: boolean }> {
  if (!o.deskProven) return { ok: false, error: "only the desktop app runs an action for a person: it is their program, started with their permissions" };
  if (typeof id !== "string") return { ok: false, error: "no such action" };
  const l = load(id);
  if (!l.ok) return l;
  const a = l.action;
  if (!a.enabled) return { ok: false, error: "that action is turned off" };
  if (a.unavailable) return { ok: false, error: a.unavailable };
  if (source !== "selection" && source !== "background") return { ok: false, error: "source must be selection or background" };
  if (!Array.isArray(pathsIn) || !pathsIn.length || pathsIn.length > 1000) return { ok: false, error: "nothing selected" };
  if (source === "background" && pathsIn.length !== 1) return { ok: false, error: "the folder background is one folder" };
  const paths: string[] = [], sel: Selected[] = [];
  for (const p of pathsIn) {
    const real = browseReal(p, o.local);
    if (!real) return { ok: false, error: `${typeof p === "string" ? basename(p) : "that"}: outside what this may touch` };
    let st; try { st = statSync(real); } catch { return { ok: false, error: `${basename(real)}: no such file` }; }
    if (source === "background" && !st.isDirectory()) return { ok: false, error: "the background of a folder is a folder" };
    paths.push(real);
    sel.push({ name: basename(real), kind: st.isDirectory() ? "folder" : "file" });
  }
  if (a.when.mime_types.length) for (let i = 0; i < paths.length; i++) sel[i]!.mime = (await mimeOf(paths[i]!)) ?? undefined;
  if (!matchesSelection(a, sel)) return { ok: false, error: "that action is not for this selection" };
  if (a.run.confirm && !o.confirmed) return { ok: false, confirm: true, error: `${a.name} asks for confirmation before it runs` };

  const jobs = a.run.mode === "per-item" ? paths.map((p) => [p]) : [paths];
  const job = startExternalJob("action", a.name, jobs.length);
  const parentOf = (ps: string[]) => (source === "background" ? ps[0]! : dirname(ps[0]!));
  void (async () => {
    let failed = 0, ran = 0, cancelled = false, output = "";
    let sizeNote = false;
    for (let i = 0; i < jobs.length; i++) {
      if (job.stopped()) { cancelled = true; break; }
      const ps = jobs[i]!, parent = parentOf(ps);
      const run = mkdtempSync(join(tmpdir(), "agx-action-"));
      try {
        const pathsFile = join(run, "paths"), parentFile = join(run, "parent"), progress = join(run, "progress.jsonl");
        writeFileSync(pathsFile, ps.map((p) => p + "\0").join(""), { mode: 0o600 });
        writeFileSync(parentFile, parent, { mode: 0o600 });
        writeFileSync(progress, "", { mode: 0o600 });
        writeFileSync(join(run, "context.json"), JSON.stringify({ id: a.id, name: a.name, mode: a.run.mode, source, paths: ps, parent }), { mode: 0o600 });
        if (a.run.runtime === "python") writeFileSync(join(run, "agentglass_actions.py"), PY_HELPER, { mode: 0o600 });
        const argv = argvFor(a, l.dir, ps, parent);
        if (!argv) { failed++; output += `${a.name}: its program was not found\n`; if (a.run.on_error === "stop") break; continue; }
        const cwd = a.run.working_directory === "home" ? homedir() : a.run.working_directory === "action" ? l.dir : parent;
        const env = cleanEnv({
          AGENTGLASS_ACTION_VERSION: "1", AGENTGLASS_ACTION_ID: a.id, AGENTGLASS_ACTION_MODE: a.run.mode, AGENTGLASS_ACTION_SOURCE: source,
          AGENTGLASS_ACTION_COUNT: String(ps.length), ...(a.run.mode === "per-item" ? { AGENTGLASS_ACTION_POSITION: String(i + 1) } : {}),
          AGENTGLASS_ACTION_PATHS: pathsFile, AGENTGLASS_ACTION_PARENT: parentFile, AGENTGLASS_ACTION_PROGRESS: progress,
          AGENTGLASS_ACTION_CONTEXT: join(run, "context.json"), AGENTGLASS_ACTION_RUN_DIR: run, AGENTGLASS_ACTION_DIR: l.dir,
          ...(a.run.runtime === "python" ? { PYTHONPATH: run, PYTHONDONTWRITEBYTECODE: "1" } : {}),
        });
        const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
        const pid = proc.pid;
        job.onCancel(() => { try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 3000).unref?.(); });
        const out = { text: "", cut: false };
        const tick = setInterval(() => { const p = readProgress(progress); if (p) job.progress(p.done, p.total); }, 400);
        await Promise.all([readCapped(proc.stdout as ReadableStream<Uint8Array>, out), readCapped(proc.stderr as ReadableStream<Uint8Array>, out)]);
        const code = await proc.exited;
        clearInterval(tick);
        const p = readProgress(progress);
        if (p) job.progress(p.done, p.total); else if (jobs.length > 1) job.progress(i + 1, jobs.length);
        ran++;
        if (output.length < OUTPUT_CAP) output += (jobs.length > 1 ? `[${i + 1}/${jobs.length}] ` : "") + out.text + (out.text.endsWith("\n") || !out.text ? "" : "\n");
        if (out.cut && !sizeNote) { output += "(output cut)\n"; sizeNote = true; }
        if (job.stopped()) { cancelled = true; break; }
        if (code !== 0) { failed++; output += `exit ${code}\n`; if (a.run.on_error === "stop") break; }
      } finally { rmSync(run, { recursive: true, force: true }); }
    }
    const text = output.slice(0, OUTPUT_CAP);
    if (cancelled) job.end("cancelled", undefined, text);
    else if (failed) job.end("error", jobs.length > 1 ? `${failed} of ${jobs.length} failed` : "it exited with an error", text);
    else job.end("done", undefined, text);
    void ran;
  })();
  return { ok: true, job: listJobs().find((j) => j.id === job.id)! };
}

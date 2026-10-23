/*
 * The one door the finder's file operations come through: the web UI, the
 * agent door (agentglass-ui) and the tests all send the same JSON and get the
 * same answer. index.ts judges WHO may call (trusted caller, loopback socket);
 * this judges WHAT is asked, then hands it to fsops.ts, which judges WHERE.
 */
import {
  cancelJob, clearFinishedJobs, fsChmod, fsCompress, fsCopy, fsDelete, fsEmptyTrash, fsFolderWith, fsMkdir, fsNewFile, fsProps, fsRename,
  fsRedo, fsRestore, fsTrash, fsUndo, listJobs, redoState, trashList, undoState,
} from "./fsops.ts";

export const FS_OPS = ["mkdir", "newfile", "folder-with", "rename", "trash", "restore", "empty-trash", "delete", "copy", "move", "duplicate", "compress", "chmod", "undo", "redo"] as const;
export type FsOp = (typeof FS_OPS)[number];
/** The ones nobody can take back: an agent needs the person's say-so for these. */
export const FS_IRREVERSIBLE: readonly FsOp[] = ["delete", "empty-trash"];

/**
 * Who may do the ones nobody can take back. `deskProven` is index.ts's answer to
 * "does this request carry the desktop app's desk key" and nothing weaker: not the
 * machine token (every agent shell holds it), not an Origin header (any page on the
 * private network can send one). An agent is left with the trash, which is reversible.
 */
export function fsGate(op: string, deskProven: boolean): { status: number; body: unknown } | null {
  if (!deskProven && (FS_IRREVERSIBLE as readonly string[]).includes(op)) {
    return { status: 403, body: { ok: false, error: "That cannot be taken back, so only the desktop app can do it for a person. Move it to the trash instead." } };
  }
  return null;
}

/** A write is a JSON post. A page on another origin can send text/plain without a preflight, so anything else is not read. */
export function fsWantsJson(contentType: string | null): boolean {
  return !!contentType && /^application\/json\b/i.test(contentType.trim());
}

/** Every path an op names, so a caller held to one project can be judged on all of them. */
export function fsPathsOf(b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["path", "parent", "dest"]) if (typeof b[k] === "string") out.push(b[k] as string);
  if (Array.isArray(b.paths)) for (const p of b.paths) if (typeof p === "string") out.push(p);
  return out;
}

export async function fsRun(b: Record<string, unknown>, local: boolean): Promise<{ status: number; body: unknown }> {
  if (!local) return { status: 403, body: { ok: false, error: "file operations are for the machine they run on" } };
  const op = b.op as FsOp;
  const paths = b.paths ?? (typeof b.path === "string" ? [b.path] : undefined);
  const conflict = b.conflict === "keep-both" ? "keep-both" as const : "fail" as const;
  let r: { ok: boolean; error?: string };
  switch (op) {
    case "mkdir": r = fsMkdir(b.parent, b.name, local); break;
    case "newfile": r = fsNewFile(b.parent, b.name, local); break;
    case "folder-with": r = fsFolderWith(paths, b.name, local); break;
    case "rename": r = fsRename(b.path, b.name, local); break;
    case "trash": r = fsTrash(paths, local); break;
    case "restore": r = fsRestore(b.ids, local); break;
    case "empty-trash": r = await fsEmptyTrash(b.ids, b.confirm); break;
    case "delete": r = await fsDelete(paths, b.confirm, local); break;
    case "copy": r = await fsCopy(paths, b.dest, { conflict }, local); break;
    case "move": r = await fsCopy(paths, b.dest, { move: true, conflict }, local); break;
    case "duplicate": r = await fsCopy(paths, null, { duplicate: true }, local); break;
    case "compress": r = await fsCompress(paths, b.name, b.format, b.password, local); break;
    case "chmod": r = fsChmod(b.path, b.mode, local); break;
    case "undo": r = fsUndo(local); break;
    case "redo": r = fsRedo(local); break;
    default: return { status: 400, body: { ok: false, error: `unknown op (${FS_OPS.join(", ")})` } };
  }
  return { status: r.ok ? 200 : 400, body: { ...r, undo: undoState(), redo: redoState() } };
}

export function fsReadOp(what: string, q: URLSearchParams, local: boolean): { status: number; body: unknown } {
  if (!local) return { status: 403, body: { ok: false, error: "file operations are for the machine they run on" } };
  if (what === "jobs") return { status: 200, body: { jobs: listJobs() } };
  if (what === "trash") return { status: 200, body: { ok: true, entries: trashList() } };
  if (what === "undo") return { status: 200, body: { ok: true, ...undoState(), redo: redoState() } };
  if (what === "props") { const r = fsProps(q.get("path"), local); return { status: r.ok ? 200 : 400, body: r }; }
  return { status: 404, body: { ok: false, error: "no such read" } };
}

export function fsJobs(op: "cancel" | "clear", id: unknown): { status: number; body: unknown } {
  if (op === "clear") { clearFinishedJobs(); return { status: 200, body: { ok: true } }; }
  const ok = cancelJob(id);
  return { status: ok ? 200 : 400, body: { ok, ...(ok ? {} : { error: "no such running job" }) } };
}

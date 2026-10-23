/*
 * What a staged Finder operation says and what it runs, decided apart from the
 * dialog that draws it. The words are the whole of what the person reads before
 * pressing the button, so every path the operation touches is named in them;
 * the body is the same one the menu sends for the same act (useFinderOps `run`),
 * so a staged operation is not a second way to write.
 */
import type { UiArgs } from "../../../shared/uiActions.ts";
import type { FsBody } from "../../../shared/types.ts";

export type FinderStageArgs = UiArgs<"finder.op.stage">;

const base = (p: string): string => p.split("/").filter(Boolean).pop() || p;
const parent = (p: string): string => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "/"; };

/** The sentence after "<caller> wants to". */
export function stageSentence(a: FinderStageArgs): string {
  const n = base(a.path);
  switch (a.op) {
    case "trash": return `move ${n} to the trash`;
    case "duplicate": return `duplicate ${n}`;
    case "move": return `move ${n} to ${base(a.dest!)}`;
    case "copy": return `copy ${n} to ${base(a.dest!)}`;
    case "rename": return `rename ${n} to ${a.name}`;
    case "new-folder": return `create a folder called ${a.name} in ${n}`;
  }
}

/** The label of the button that runs it. */
export function stageConfirm(op: FinderStageArgs["op"]): string {
  return { trash: "Move to Trash", duplicate: "Duplicate", move: "Move", copy: "Copy", rename: "Rename", "new-folder": "Create folder" }[op];
}

/** One line per path involved, in full, for the body of the dialog. */
export function stagePaths(a: FinderStageArgs): string[] {
  const lines = [a.op === "new-folder" ? `In: ${a.path}` : `Item: ${a.path}`];
  if (a.dest) lines.push(`Into: ${a.dest}`);
  if (a.name) lines.push(`Name: ${a.name}`);
  return lines;
}

/** What `run` is called with: the request body, the folders to reload, and the name the note says. */
export function stageRun(a: FinderStageArgs): { body: FsBody; dirs: string[]; name: string } {
  switch (a.op) {
    case "trash": return { body: { op: "trash", paths: [a.path] }, dirs: [parent(a.path)], name: base(a.path) };
    case "duplicate": return { body: { op: "duplicate", paths: [a.path] }, dirs: [parent(a.path)], name: base(a.path) };
    case "move": case "copy": return { body: { op: a.op, paths: [a.path], dest: a.dest, conflict: "keep-both" }, dirs: [parent(a.path), a.dest!], name: base(a.path) };
    case "rename": return { body: { op: "rename", path: a.path, name: a.name }, dirs: [parent(a.path)], name: a.name! };
    case "new-folder": return { body: { op: "mkdir", parent: a.path, name: a.name }, dirs: [a.path], name: a.name! };
  }
}

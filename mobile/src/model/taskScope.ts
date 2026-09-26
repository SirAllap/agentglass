/*
 * Which of the machine's local tasks are this project's.
 *
 * The server holds one open project (`workspaces` in `/projects`) and the
 * pull-request and issue lists follow it. `/tasks/list` is the tracker's whole
 * store, so the Cards tab drew every project on the machine under a phone
 * paired for one. A task's `project` is a word the tracker keeps and a
 * checkout is a directory, so the two meet by name: the checkout's last folder
 * is the project, and a dotted sub-project (`orbit.billing`) belongs to it.
 *
 * The smaller thing cannot do: a task filed under a project whose name is not
 * its checkout's folder is out of scope here, which is why the tab offers
 * "Everything" beside it rather than hiding the rest.
 */
import type { LocalTask } from "../../../shared/types.ts";

/** The project names the open checkouts answer to, lower-cased. */
export function projectNames(workspaces: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const w of workspaces ?? []) {
    const last = w.split("/").filter(Boolean).pop();
    if (last) out.push(last.toLowerCase());
  }
  return out;
}

/**
 * Keep the tasks of the named projects. With no names there is no project to
 * be inside of (an unscoped server), and that is every task, not none.
 */
export function scopeLocal(tasks: LocalTask[] | null, names: readonly string[]): LocalTask[] {
  if (!tasks) return [];
  if (!names.length) return tasks;
  return tasks.filter((t) => {
    const p = t.project?.toLowerCase();
    return !!p && names.some((n) => p === n || p.startsWith(`${n}.`));
  });
}

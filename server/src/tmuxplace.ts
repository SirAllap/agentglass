/**
 * Where a tab the app opens lands in an existing session.
 *
 * `new-window` with no `-a` takes the first free index, which is the END of
 * the bar. With tabs grouped by name (`pr-1042`, `pr-1043`, then `orbit-a`),
 * a new `pr-1044` appeared after `orbit-b`, away from the tabs it belongs with.
 *
 * The group is the text before the first `-`, or before the trailing digits
 * (`pr-1042` and `pr1042` are both `pr`). A new window goes right after the
 * last window of its group; no match falls back to the window it was opened
 * from, and then to the end as before.
 *
 * Only for windows the app creates live. Restore (tmuxrestore.ts) replays a
 * saved order and must not reorder it.
 */

export interface PlaceWindow { id: string; name: string; index: number }

/** `list-windows -F` format that `parsePlaceWindows` reads. Tab-separated: a name may hold spaces. */
export const PLACE_FORMAT = "#{window_id}\t#{window_index}\t#{window_name}";

export function parsePlaceWindows(out: string): PlaceWindow[] {
  const rows: PlaceWindow[] = [];
  for (const line of out.split("\n")) {
    const [id = "", index = "", ...name] = line.replace(/\r$/, "").split("\t");
    if (/^@\d+$/.test(id) && /^\d+$/.test(index)) rows.push({ id, index: Number(index), name: name.join("\t") });
  }
  return rows;
}

/** "" when the name has no group (empty, or only digits). */
export function groupOf(name: string): string {
  return name.replace(/-[\s\S]*$/, "").replace(/\d+$/, "");
}

/** The window id to pass to `new-window -a -t`, or null for "at the end". */
export function placeAfter(windows: PlaceWindow[], name: string, from?: string): string | null {
  const group = groupOf(name);
  if (group) {
    let last: PlaceWindow | null = null;
    for (const w of windows) if (groupOf(w.name) === group && (!last || w.index > last.index)) last = w;
    if (last) return last.id;
  }
  return from && windows.some((w) => w.id === from) ? from : null;
}

/** Arguments that put a new window there: `["-a", "-t", "@7"]`, or `["-t", target]` for the end. */
export function placeArgs(windows: PlaceWindow[], name: string, endTarget: string, from?: string): string[] {
  const after = placeAfter(windows, name, from);
  return after ? ["-a", "-t", after] : ["-t", endTarget];
}

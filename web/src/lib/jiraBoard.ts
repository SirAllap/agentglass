/*
 * Jira as a source for the Tasks board (see boardSource.ts).
 *
 * The board body is one component for every tracker: it draws the rail, the
 * chips, the table and the card pane from what a source hands it. This file is
 * Jira's half of that. It reads the site's boards and filters through
 * `api.jira*`, and puts the answer in the shape the body already draws:
 *
 *   views      the saved views and the projects that hold boards. A project is
 *              its own heading, so the "space" its folder carries (the project
 *              name again) is dropped, or the rail would draw every project twice.
 *   read       one view. The statuses are the view's own, in its own order, with
 *              the ones no card wears; a read kept on disk before the server
 *              sent them has them rebuilt from its cards so an old answer still
 *              groups.
 *   write gate the one switch for writing to Jira, a local read.
 *
 * A board also has its context (quick filters, sprint, epics) and can be ranked by
 * a drop; both are optional parts of the source (`boardContext`, `rank`) that the
 * body draws only when they are there.
 *
 * What Jira does not have yet is stated in `caps`, and a control it cannot
 * honour is left out of the screen: no sprint or field editing, no workspace
 * search, no list of a list's own views, no new address for a saved board.
 * `search` and `find` are the site's own routes, ready for the slice that
 * gives the search box a Jira answer.
 */
import { api } from "./api.ts";
import { boardStorageKey, type BoardSource, type BoardViews } from "./boardSource.ts";
import { JiraAddView } from "../components/jira/AddBar.tsx";
import { JiraCardPane } from "../components/JiraTasks.tsx";
import type { JiraViewRead, ListStatus, ProviderTask, ViewTasksResponse } from "../../../shared/providers.ts";

const NOT_HERE = { ok: false, error: "Jira has no such thing" } as const;

/** The statuses a view's cards wear, open first then the rest, each once. For a read kept before the server drew its own. */
export function statusesOfCards(tasks: readonly ProviderTask[]): ListStatus[] {
  const seen = new Map<string, ListStatus>();
  const rank = { open: 0, other: 1, done: 2 } as const;
  for (const t of [...tasks].sort((a, b) => rank[a.statusKind] - rank[b.statusKind])) {
    const name = t.status || "No status";
    if (!seen.has(name)) seen.set(name, { status: name, type: t.statusKind === "done" ? "done" : "open", orderindex: seen.size, ...(t.statusColor ? { color: t.statusColor } : {}) });
  }
  return [...seen.values()];
}

/** A Jira read as the board draws one. A failed read keeps whatever rows the server last held. */
export function boardOf(r: JiraViewRead): ViewTasksResponse {
  return {
    tasks: r.tasks,
    statuses: r.statuses ?? statusesOfCards(r.tasks),
    fields: [],
    // Where it sits, as the breadcrumb over the board reads it: the project, then the board. The built-in view has none.
    ...(r.view && !r.view.builtin ? { place: { ...(r.view.folderName ? { folder: r.view.folderName } : {}), list: r.view.name } } : {}),
    ...(r.view ? { view: r.view } : {}),
    ...(r.ok ? {} : { error: r.error || "Jira did not answer", ...(r.throttled ? { throttled: true } : {}), ...(r.unauthorised ? { unauthorised: true } : {}) }),
    ...(r.truncated ? { truncated: true } : {}),
    at: r.at,
  };
}

async function views(): Promise<BoardViews> {
  const [v, s] = await Promise.all([api.jiraViews(), api.jiraStatus().catch(() => null)]);
  return {
    views: v.views.map(({ spaceName: _drop, ...rest }) => rest),
    folders: v.folders.map((f) => ({ ...f, spaceName: "" })),
    connected: v.connected,
    ...(v.current ? { current: v.current } : {}),
    writeEnabled: !!s?.writes,
  };
}

/*
 * The first read of a view in this window paints what the machine kept from the
 * last one, then reads Jira. The server's own minute is memory, so after a
 * restart the board would otherwise be a spinner until Jira answered, seconds
 * on a slow site. The body already has the mechanism for it: a read that says
 * `revalidating` is followed up by a second read of the same view, and that
 * second read is handed the live one that was started behind the first. Later
 * reads, and Refresh, go straight to Jira (the server holds the minute), so a
 * poll never paints an older copy over a newer one.
 */
const live = new Set<string>();
const behind = new Map<string, Promise<ViewTasksResponse>>();

async function read(id?: string, force?: boolean, quick?: readonly string[]): Promise<ViewTasksResponse> {
  const key = id ?? "";
  // A narrowed board is a question of the moment: it neither paints from, nor waits behind, the whole board's kept copy.
  if (quick?.length) return api.jiraView(key, { ...(force ? { force: true } : {}), filters: quick }).then(boardOf);
  const asked = behind.get(key);
  if (asked && !force) return asked;
  const fresh = () => api.jiraView(key, force ? { force: true } : undefined).then(boardOf);
  if (!force && key && !live.has(key)) {
    const kept = await api.jiraView(key, { cached: true }).catch(() => null);
    const run = fresh().finally(() => { behind.delete(key); live.add(key); });
    if (kept?.ok && kept.at > 0 && kept.tasks.length) {
      behind.set(key, run);
      run.catch(() => {}); // the follow-up read awaits it and says what went wrong
      return { ...boardOf(kept), revalidating: true };
    }
    return run;
  }
  const r = await fresh();
  live.add(key);
  return r;
}

/** Test seam: forget which views were read live. */
export const __forgetJiraReads = (): void => { live.clear(); behind.clear(); };

export const JIRA_BOARD: BoardSource = {
  id: "jira",
  nouns: {
    tracker: "Jira", space: "site", folder: "project", list: "board", board: "board", openIn: "Open in Jira",
    searchTip: "Searches the title, description and comments of the cards in the projects you can see, and a card key exactly.",
    addHint: "Add a board, a filter or a project",
    assignedHint: "Every open card assigned to you, on the site you connected.",
  },
  caps: {
    sprintEdit: false, multiAssignee: false, fieldEdits: false, listViews: false, workspaceSearch: true, stream: false,
    listMeta: false, editAddress: false, slowAssigned: false, context: true,
  },
  shortKeys: true,
  storageKey: (name) => boardStorageKey("jira", name),

  views,
  read,
  boardContext: (viewId) => api.jiraBoardContext(viewId),
  boardAreas: (viewId) => api.jiraBoardAreas(viewId),
  rank: (key, ask) => api.jiraRank(key, ask),
  list: async () => NOT_HERE,
  listViews: async () => ({ ok: true, views: [], links: [] }),
  setWrites: (on) => api.jiraWrites(on),

  addView: async () => NOT_HERE,
  replaceView: async () => NOT_HERE,
  removeView: (id) => api.jiraRemoveView(id),
  addFolder: async () => NOT_HERE,
  removeFolder: (id) => api.jiraRemoveFolder(id),

  where: async () => ({ ok: false }),
  find: (ref, signal) => api.jiraFind(ref, signal),
  search: async (q, _force, signal) => api.jiraSearch(q, signal),
  searchStream: async (q, _force, onSome, signal) => {
    const r = await api.jiraSearch(q, signal);
    if (r.ok && r.tasks?.length) onSome(r.tasks);
    return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  },

  openAddress: (data) => data?.view?.url || undefined,
  AddView: JiraAddView,
  CardPane: JiraCardPane,
};

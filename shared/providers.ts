/*
 * The outside services agentglass can be connected to, by service rather than
 * by binary.
 *
 * `deps.ts` already answers "is this tool installed", and answers it well. It
 * is the wrong axis for this question. Somebody connecting GitHub is not
 * thinking about a binary called `gh`; somebody connecting ClickUp has no
 * binary to think about at all, only a token. Grouping by the SERVICE puts
 * those two next to each other, which is where they belong — they are the same
 * act — and it is the only grouping in which "not connected" and "not
 * installed" can sit in one list without one of them looking like an error.
 *
 * So this is a second view over the same probes plus a new one for credentials,
 * not a second copy of them. Nothing here re-implements a capability check:
 * `dep` names a row in the dependency catalogue and the answer is taken from
 * there.
 */

/** Which half of the app a provider feeds. The two are genuinely different
 *  jobs, and Orca's split is the right one: code you review, and work you owe. */
export type ProviderKind = "review" | "task";

/**
 * How a provider is authenticated, which decides what the card can offer.
 *
 * `cli` means a tool owns the credential and we never see it — `gh` keeps its
 * token in the system keyring, and the honest card says "signed in as X" with
 * no field to type into. `token` means we hold it, which brings an obligation
 * the `cli` case does not have: it has to be stored somewhere with the right
 * mode, and it must never travel back to the browser.
 * `none` is for a provider with nothing to authenticate against — a local
 * store on this machine.
 */
export type AuthKind = "cli" | "token" | "none";

export type ProviderId = "github" | "gitlab" | "taskwarrior" | "clickup";

export interface ProviderSpec {
  id: ProviderId;
  title: string;
  kind: ProviderKind;
  auth: AuthKind;
  /** What connecting this actually gets you, as a consequence rather than a
   *  category — the same rule `deps.ts` writes its `what` by. */
  what: string;
  /** The row in the dependency catalogue this provider's tool lives at, when it
   *  has one. Absent for anything that is only a credential. */
  dep?: "gh" | "glab" | "task";
  /** Where a person goes to get the credential, when they have to fetch one. */
  help?: string;
  /** Said on the card before anything is typed. The place to be honest about
   *  what will be stored and where. */
  note?: string;
}

/**
 * The catalogue. Order is reading order: what is most likely already working
 * first, so the page opens on a green row rather than a list of chores.
 */
export const PROVIDERS: ProviderSpec[] = [
  {
    id: "github", title: "GitHub", kind: "review", auth: "cli", dep: "gh",
    what: "Pull requests, issues, checks and reviews.",
    note: "The `gh` CLI owns this credential — it lives in your system keyring and agentglass never reads or stores it.",
  },
  {
    id: "gitlab", title: "GitLab", kind: "review", auth: "cli", dep: "glab",
    what: "Merge requests and pipelines, once there is a GitLab remote to read them from.",
    note: "Reported here so its absence is visible. Reading merge requests is not built yet — this row tells you whether the tool is ready for when it is.",
  },
  {
    id: "taskwarrior", title: "Taskwarrior", kind: "task", auth: "none", dep: "task",
    what: "Your local task list, read from the store you already write to from your editor.",
  },
  {
    id: "clickup", title: "ClickUp", kind: "task", auth: "token",
    what: "The tasks assigned to you, alongside your local ones.",
    help: "https://developer.clickup.com/docs/authentication",
    note: "A personal API token, from ClickUp's Settings → Apps. It starts with `pk_` and does not expire. Stored on this machine in a file only you can read, and never sent to the browser.",
  },
];

/** What a provider is doing right now, as one of four answers a person can act
 *  on. Deliberately not a boolean: "installed but not logged in" and "not
 *  installed" need different sentences and different buttons. */
export type ProviderState =
  /** Working. `detail` says who you are, where that could be answered. */
  | "connected"
  /** The tool is here and has no credential yet — or ours is missing. */
  | "needs-auth"
  /** The tool this provider needs is not on PATH. */
  | "missing-tool"
  /** We have a credential and the service refused it, or could not be reached. */
  | "error";

export interface ProviderStatus {
  id: ProviderId;
  state: ProviderState;
  /** One line under the badge: who you are signed in as, what is wrong, or what
   *  is left to do. Written for the person, never a raw error body. */
  detail?: string;
  /** Set when the answer came from a cache rather than a live check, so the
   *  page can say "as of" instead of implying it just asked. */
  at?: number;
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
}

// ---------------------------------------------------------------------------
// what a remote provider's task looks like
// ---------------------------------------------------------------------------

/**
 * A task from a service, as the panel needs it.
 *
 * Deliberately NOT `LocalTask`. Taskwarrior's shape is a local store's — a uuid,
 * a priority of H/M/L, annotations — and forcing a remote task through it would
 * either lose things it has (a URL, a workspace status, an assignee list) or
 * invent things it has not (a uuid). Two shapes, one list on screen.
 */
export interface ProviderTask {
  /** The provider's own id, as a string. Never parsed. */
  id: string;
  title: string;
  /** Where to open it in the service's own UI. Empty when it has none. */
  url: string;
  /** The status as the workspace spells it — "In progress", "Blocked". Shown
   *  verbatim, because renaming somebody's workflow is not ours to do. */
  status: string;
  /**
   * The only portable thing about a status.
   *
   * Status NAMES are per-list and a workspace may have four words for "doing",
   * so nothing may branch on them. The provider's own classification is what
   * decides whether a row is work you still owe.
   */
  statusKind: "open" | "done" | "other";
  priority: "urgent" | "high" | "normal" | "low" | null;
  /** Local calendar date, `YYYY-MM-DD`, converted from the provider's epoch. */
  due: string | null;
  updated: number;
  tags: string[];
  /** The list, board or project it sits in. */
  list: string | null;
  listId?: string;
  assignees: string[];
  /** Whether YOU are on it — resolved server-side against the connected
   *  account, because the client has no business knowing your user id. */
  mine?: boolean;
  /** Sprint points, ClickUp's own numeric field. Null when unset. */
  points?: number | null;
  /** Custom field values worth showing, already resolved from ids to names. */
  custom?: { id: string; name: string; value: string }[];
}

export interface ClickUpUser { id: string; name: string; email: string }
export interface ClickUpWorkspace { id: string; name: string }

export interface ProviderTasksResponse {
  tasks: ProviderTask[];
  /** The provider had more than it would give in one page, and said so. */
  more: boolean;
  /** When the last attempt failed. `tasks` is then the last good answer, not an
   *  empty list — an empty list reads as "nothing to do" and gets acted on. */
  error?: string;
  /** The one error that means "reconnect" rather than "try later". */
  unauthorised?: boolean;
  at: number;
}

// ---------------------------------------------------------------------------
// saved views
// ---------------------------------------------------------------------------

/**
 * A ClickUp view, saved by pasting its address.
 *
 * The alternative was walking the hierarchy — spaces, then folders, then lists
 * — which is several calls deep, needs a picker of its own, and lands you in a
 * *list* rather than the *view* you actually work in. Pasting the address you
 * are already looking at skips all of it, and it turns out to be better on
 * every axis that matters:
 *
 *   asking the workspace for "assigned to me"   12.5s
 *   asking a view for its tasks                  1.4s
 *
 * …because a view is already scoped, and because it applies its OWN filters
 * server-side. Measured on a real board: the list holds 36 tasks and the view
 * returns 30, which is the same 30 the browser shows. So what arrives is what
 * you would have seen, and it arrives nine times faster.
 */
export interface SavedView {
  /** ClickUp's own view id, taken from the address. */
  id: string;
  /** What the view is called, read from ClickUp rather than typed. */
  name: string;
  /**
   * The list behind it, when the address had one.
   *
   * Worth keeping because a LIST knows things a view does not: its valid
   * statuses and its custom fields. Without it, a status picker would be
   * guessing at what this board accepts.
   */
  listId?: string;
  listName?: string;
  /** Where it came from, so a stale entry can be re-resolved. */
  url: string;
  addedAt: number;
}

/** The statuses a list accepts, in the workspace's own order and words. */
export interface ListStatus {
  status: string;
  /** `open` | `custom` | `done` | `closed` — the only portable part. */
  type: string;
  orderindex: number;
  color?: string;
}

/** A custom field on a list, and its options when it has them. */
export interface ListField {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string }[];
  /**
   * Some fields are marked off-limits by their own name — "(DO NOT EDIT!!!)"
   * is a real one on a real board. It is somebody telling every reader
   * something the API cannot express, and a tool that ignores it is a tool that
   * breaks a convention its user relies on.
   */
  readOnly: boolean;
}

export interface ViewTasksResponse {
  tasks: ProviderTask[];
  /** Every status the list behind this view accepts. Empty when the address
   *  gave no list — the picker then has nothing to offer, and says so. */
  statuses: ListStatus[];
  fields: ListField[];
  view?: SavedView;
  error?: string;
  unauthorised?: boolean;
  at: number;
}

export interface TaskDetail {
  task: ProviderTask;
  /** Markdown, as the workspace wrote it. */
  description: string;
  subtasks: ProviderTask[];
  checklists: { name: string; items: { name: string; done: boolean }[] }[];
  comments: { id: string; who: string; text: string; at: number }[];
}

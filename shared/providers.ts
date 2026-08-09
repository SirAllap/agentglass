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
  /**
   * Something this provider does is degraded, said beside the main verdict
   * rather than instead of it.
   *
   * A provider is not one thing. ClickUp answers a task list AND drives the
   * card bell, and those fail separately: the panel can be showing a list it
   * read four minutes ago while the watcher has been 401ing for a week. A
   * second field rather than prose inside `detail`, because sniffing your own
   * sentences is how a copy edit becomes a bug — the same reason `pending` is
   * a field and not an ellipsis.
   */
  notice?: string;
  /** Set when the answer came from a cache rather than a live check, so the
   *  page can say "as of" instead of implying it just asked. */
  at?: number;
  /** This answer is complete enough to act on, but a slower part of it is still
   *  arriving — ClickUp's task count takes ten seconds of ClickUp's own time.
   *  The page polls again while any provider says so, rather than leaving an
   *  ellipsis on screen that never resolves. A field and not a "…" in `detail`,
   *  because sniffing your own prose is how a copy edit becomes a bug. */
  pending?: boolean;
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
  /**
   * How many comments the card has, when it has been counted.
   *
   * `undefined` means not known — the workspace does not report it on a task,
   * so it costs a call per card and one may not have landed yet. Zero is a real
   * answer and must stay distinguishable from it: "no comments" is a fact,
   * "we could not ask" is not.
   */
  comments?: number;
  /** The provider's own id, as a string. Never parsed. */
  id: string;
  /**
   * The id a HUMAN uses for this card, when the workspace has them switched on.
   *
   * ClickUp keeps two: an internal one nobody recognises, and a custom one that
   * appears in the address bar, in commit messages and in the prompts people
   * have already written. Skills written against this workspace ask for the
   * second. Passing the first to one of them fails in the least helpful way
   * available — the card exists, the tool cannot find it.
   */
  customId?: string;
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
  /** The colour the workspace gave this status. Used as-is rather than mapped
   *  to a palette of ours: a board's colours are how its people read it at a
   *  glance, and inventing our own would make agentglass disagree with the tool
   *  it is showing. */
  statusColor?: string;
  priority: "urgent" | "high" | "normal" | "low" | null;
  /** Local calendar date, `YYYY-MM-DD`, converted from the provider's epoch. */
  due: string | null;
  updated: number;
  tags: string[];
  /** The list, board or project it sits in. */
  list: string | null;
  listId?: string;
  assignees: string[];
  /**
   * Who is on it, with what a row needs to draw them.
   *
   * Initials alone are not enough, and that is not hypothetical: on a real
   * board two people share `AG`. The avatar tells them apart, and the colour —
   * the workspace's own, one per person — does it when there is no photo.
   */
  people?: {
    /** ClickUp's own id. Names are not identity — this board has two people
     *  sharing initials — and a picker that toggles by name is a picker that
     *  eventually removes the wrong person. */
    id?: number;
    name: string;
    initials: string;
    /** The colour ClickUp assigned this person. */
    color?: string;
    /** Their picture, when they have uploaded one. */
    avatar?: string;
    /** True for the connected account. */
    me?: boolean;
  }[];
  /**
   * The sprint this card is in, when it is in one.
   *
   * ClickUp has no sprint FIELD: a sprint is a list, and a card in one is a
   * card living in two lists at once — which arrives as `locations`. Checked
   * against a real board where nothing had been sprinted yet: every card came
   * back with an empty one, which is why the column only appears once some card
   * actually has a sprint.
   */
  sprint?: string | null;
  /** Whether YOU are on it — resolved server-side against the connected
   *  account, because the client has no business knowing your user id. */
  mine?: boolean;
  /** Sprint points, ClickUp's own numeric field. Null when unset. */
  points?: number | null;
  /** Estimate, in hours. The API answers milliseconds; nobody plans in those. */
  estimateHours?: number | null;
  /** Logged against it, in hours. */
  spentHours?: number | null;
  /** When it was created, and when it last moved. `updated` is the precondition
   *  for writes; this is the same number as a local day, for reading. */
  created?: number;
  /** Its own start date, where the board uses them. */
  start?: string | null;
  /**
   * What has to finish before this can, and what is waiting on it.
   *
   * The single most actionable thing on an engineering board and the one the
   * panel was not showing: 28 of 30 cards on a real one have dependencies. Held
   * as ids here and resolved against the board's own rows, so no extra call is
   * made to say "blocked by T12".
   */
  waitsOn?: string[];
  blocks?: string[];
  /** How many subtasks it has, so a card with hidden work says so. */
  subtasks?: number;
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
  /** This one ships with the app rather than being pasted — see
   *  `ASSIGNED_VIEW_ID`. It cannot be removed and has no address. */
  builtin?: boolean;
}

/**
 * The board that is not a board: everything assigned to you.
 *
 * Pasting an address is the right way to open a *board*, and it is the wrong
 * way to open the one list every person already has. "Assigned to me" lives at
 * `/{workspace}/my-work/tasks`, which names no view and no list — there is
 * nothing in that address to resolve, which is why pasting it could only ever
 * be refused. So it is not resolved: it is a query we already know how to ask,
 * given a token, and it is always on the bar.
 *
 * Kept as a reserved id rather than a flag on the response so that everything
 * downstream — the cache on disk, "which board was I on", the chip you click —
 * keeps working with no special case. The `me:` prefix cannot collide: ClickUp's
 * view ids are digits and hyphens.
 *
 * It is the slow one, and knowingly: about twelve seconds against a real
 * workspace versus one and a half for a view, because it filters an entire
 * organisation by assignee rather than reading something already scoped. That
 * is what the disk cache is for — it opens on what you last saw and corrects
 * itself behind you.
 */
export const ASSIGNED_VIEW_ID = "me:assigned";
export const ASSIGNED_VIEW_NAME = "Assigned to me";

/**
 * Where a list sits in the workspace, as ClickUp's own breadcrumb reads it.
 *
 * Space → Folder → List. It arrives on `GET /list/{id}`, which is already
 * fetched for the statuses, so this costs nothing extra — which is the only
 * reason it is worth having: "which board is this card even on" is a question
 * a list of thirteen cards from eight lists asks constantly, and one that used
 * to need a trip to the browser to answer.
 */
export interface ListPlace {
  space?: string;
  /**
   * Absent for a folderless list.
   *
   * ClickUp answers for those with a placeholder folder marked `hidden`, whose
   * name is an id-like string nobody has ever seen in their own workspace.
   * Showing it would invent a level of hierarchy that does not exist, so it is
   * dropped — the same thing ClickUp's own breadcrumb does.
   */
  folder?: string;
  list: string;
}

/**
 * What this machine's ClickUp is set up with — the boards, and how they are
 * allowed to be touched.
 *
 * Cheap on purpose: every field is read from the local store, so a surface that
 * only wants to know "is there a ClickUp here at all" can ask without spending
 * anything against a workspace's rate budget.
 */
export interface ClickUpBoards {
  views: SavedView[];
  /**
   * Whether there is a ClickUp token on this machine at all.
   *
   * Stated rather than inferred, and that is the whole reason it exists. The
   * obvious inference — "are there any boards" — cannot answer it: `views`
   * always carries the built-in `ASSIGNED_VIEW_ID`, which ships with the app
   * and is not stored, so its length is never zero and a reader counting it
   * concludes ClickUp is set up on a machine that has never seen a token. That
   * is how a Jira shop ended up with ClickUp marks on its pull requests.
   *
   * Surfaces that are not the ClickUp board — the pull-request masthead, the
   * triage chip — must gate on THIS.
   */
  connected: boolean;
  /** The board on screen when you last looked. */
  current?: string;
  /**
   * What this workspace's card ids look like — `ORBIT-`, hyphen included.
   *
   * Derived from cards already read, so it is EMPTY until a board has loaded
   * once. Empty means "unknown", not "no prefix": a reader may not use it to
   * decide that some id is not one of ours.
   */
  prefix?: string;
  writeEnabled: boolean;
  /** Forced on by the environment rather than chosen here, so the UI says so
   *  instead of offering a switch that will not stay off. */
  writeForced?: boolean;
}

/** The statuses a list accepts, in the workspace's own order and words. */
export interface ListStatus {
  status: string;
  /** `open` | `custom` | `done` | `closed` — the only portable part. */
  type: string;
  orderindex: number;
  color?: string;
}

/** Somebody who can be put on a card: the members of the list it lives in.
 *  Same shape as an assignee, because they become one. */
export interface ListMember {
  id: number;
  name: string;
  initials: string;
  color?: string;
  avatar?: string;
  /** The connected account, which the picker floats to the top. */
  me?: boolean;
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
  /** Where the board's own list sits — Space / Folder / List. Absent for the
   *  built-in board, whose rows come from many lists; those carry their own. */
  place?: ListPlace;
  view?: SavedView;
  error?: string;
  unauthorised?: boolean;
  /** There was more behind this than we were willing to follow. Said out loud,
   *  because a list that silently stops reads as "that is all of them". */
  truncated?: boolean;
  /** These rows are what we had; a fresh read is running behind them. The panel
   *  murmurs rather than blocks — see readView. */
  revalidating?: boolean;
  at: number;
}

export interface TaskDetail {
  task: ProviderTask;
  /** Markdown, as the workspace wrote it. */
  description: string;
  subtasks: ProviderTask[];
  checklists: { name: string; items: { name: string; done: boolean }[] }[];
  comments: {
    id: string; who: string; text: string; at: number;
    /** How many replies the thread has, from the workspace's own count. */
    replies?: number;
    /**
     * The replies themselves, fetched with the card rather than on demand.
     *
     * On demand was the obvious design and it is the wrong one here: the row
     * shows the faces of whoever answered BEFORE anything is expanded, which is
     * most of what the count is for — "did the person I asked reply, or was it
     * the bot again". Fetching on click would leave that unanswerable until
     * after the click that the faces exist to make unnecessary.
     */
    replyList?: TaskReply[];
  }[];
}

/** One reply in a comment thread. */
export interface TaskReply {
  id: string;
  who: string;
  text: string;
  at: number;
  /** For the face on the row. Initials are the fallback the workspace itself
   *  uses when somebody has no picture. */
  avatar?: string;
  initials?: string;
  color?: string;
}

/*
 * Whether this machine tracks work anywhere, which tracker the Tasks tab
 * reads, and which sources its pill offers.
 *
 * ── the question is not "is ClickUp connected" ───────────────────────────
 * ClickUp is one task provider of several. `shared/providers.ts` already lists
 * them with a `kind`, and two of them — Taskwarrior and ClickUp — are tasks
 * today, with nothing stopping a third. So the question this asks is the
 * general one: does the person on the other end of this phone track work in
 * SOMETHING. A check spelled `clickup` would be the app deciding that one
 * workspace's tool is what a task is.
 *
 * ── the answer no longer moves the bar ───────────────────────────────────
 * It used to: a machine tracking work nowhere lost the Cards destination. It
 * cannot lose Tasks now, because Tasks also reads GitHub issues, and a
 * repository needs no provider. What the answer decides is narrower and
 * stated in `taskSources`: whether the tracker is one of the pill's sources,
 * and which tracker the tab reads when it is. `tracksWork` still answers for
 * the pull-request screens, which draw a linked tracker card only on a machine
 * that has one.
 *
 * ── and the phone is stricter than the desk ──────────────────────────────
 * `web/src/lib/taskConnected.ts` shows every task source on a fresh install,
 * because an unconnected tab at the desk LINKS to the pane that connects it.
 * That route does not exist here: a phone cannot set a provider up (the same
 * refusal that makes Troubleshooting print an install line rather than run
 * one), so a tracker source on a machine without one is an advertisement for
 * something this device cannot do.
 *
 * ── a broken provider still counts ───────────────────────────────────────
 * Taken from the desk verbatim, because it is right there too: "ClickUp
 * refused this token" is not the same as "you do not use ClickUp", and hiding
 * the source would remove the one surface that was going to say so.
 */
import { PROVIDERS, type ProviderId, type ProviderSpec, type ProviderState, type ProviderStatus } from "../../../shared/providers.ts";

/** The ids that feed the work-you-owe half, read from the catalogue rather
 *  than listed — a list here would be wrong the first time somebody adds a
 *  provider, and wrong silently. Jira is in it since Phase 4: the phone reads
 *  its board and its cards (src/jira/*), so a Jira machine has a Tasks tab. */
const TASK_IDS = new Set(PROVIDERS.filter((p) => p.kind === "task").map((p) => p.id));

/**
 * Whether a provider counts as "this person uses this".
 *
 * `connected` is the plain yes. `error` counts too: a refused token or a
 * workspace that timed out is something you set up and that is failing.
 *
 * The two that mean no are the two that mean nobody ever did anything —
 * `missing-tool` (the CLI is not installed) and `needs-auth` (installed, never
 * signed in).
 */
export const setUp = (state: ProviderState): boolean => state === "connected" || state === "error";

/**
 * Does this machine track work anywhere?
 *
 * `null` when it cannot be told — no answer yet, or an answer with no task
 * provider mentioned in it at all. Null is NOT "no": a provider the server did
 * not name is unknown rather than absent, and dropping the linked-card row on
 * a missing answer is the failure with no way back from the device looking at
 * it.
 */
export function tracksWork(statuses: ProviderStatus[] | null | undefined): boolean | null {
  if (!statuses) return null;
  const known = statuses.filter((p) => TASK_IDS.has(p.id));
  if (!known.length) return null;
  return known.some((p) => setUp(p.state));
}

/**
 * Which task provider the Tasks tab reads from, and what it is called.
 *
 * The tab used to read `/clickup/views` and `/clickup/view` whoever you were,
 * and print "Open in ClickUp" on every card — a phone paired to a machine that
 * tracks work in Taskwarrior got an empty board titled after somebody else's
 * product. The rule here is the one the tab wanted all along:
 *
 *   ClickUp connected            → the board, its saved views, its cards
 *   another tracker set up       → `/tasks/list`, the provider-neutral route
 *   Jira set up                  → its own source, `jira`: four lanes, its own
 *                                  card screen, and no `/tasks/list`
 *   nothing set up               → `null`, and no tracker is offered
 *   no answer                    → `undefined`, and the pill waits
 *
 * ClickUp beats the rest whenever it is set up at all, `error` included — it
 * is the one with views to choose from, and a person with both wants the board
 * on the phone and the local list where the editor is. `error` still counts as
 * set up, for the reason `tracksWork` gives: a refused token is something you
 * configured, and the screen that reads it is where you find out. Ranking by
 * state FIRST used to let a connected Taskwarrior outrank a ClickUp that was
 * merely erroring (one bad notification poll) — the board a person set up
 * disappeared behind a tracker they never touched. ClickUp's identity is
 * ranked ahead of state so a set-up ClickUp never loses to another provider's
 * state; connected-vs-error only breaks a tie between two non-ClickUp
 * providers.
 */
export function taskProvider(statuses: ProviderStatus[] | null | undefined): ProviderSpec | null | undefined {
  if (!statuses) return undefined;
  if (!statuses.some((p) => TASK_IDS.has(p.id))) return undefined;
  const best = bestSetUp(statuses);
  return best ? PROVIDERS.find((p) => p.id === best.id) ?? null : null;
}

/** The set-up task provider the phone would read, if there is one. ClickUp
 *  beats the rest whenever it is set up at all; state only breaks a tie between
 *  two non-ClickUp trackers. See `taskProvider` for why.
 *
 *  Jira is ranked last here rather than first: its source is its own row in the
 *  pill (a board, not a list) and `taskSources` places it; this is only the
 *  fallback for a machine whose only tracker is Jira. */
function bestSetUp(statuses: ProviderStatus[]): ProviderStatus | undefined {
  const known = statuses.filter((p) => TASK_IDS.has(p.id) && setUp(p.state));
  const rank = (p: ProviderStatus): number =>
    (p.id === "clickup" ? 0 : p.id === "jira" ? 3 : 2) + (p.state === "connected" ? 0 : 1);
  return [...known].sort((a, b) => rank(a) - rank(b))[0];
}

/** One source the Tasks tab can read, as the pill names it. */
export type TaskSourceId = "jira" | "tracker" | "issues";

export interface TaskSource {
  id: TaskSourceId;
  /** The pill's word: the tracker's own name, or "GitHub issues". */
  title: string;
  /** Which tracker, when this is the tracker source. Jira's own source is
   *  `jira`, because the phone draws a board for it and a list for the rest. */
  provider?: ProviderId;
}

/** GitHub issues needs no provider: it is read from each checkout's remote, so
 *  every machine with a repository has it. */
export const ISSUES_SOURCE: TaskSource = { id: "issues", title: "GitHub issues" };

/** The board source. Its own id rather than `tracker` with a provider, because
 *  what the tab draws and reads is different: four lanes from a Jira view, not
 *  `/tasks/list`. */
export const JIRA_SOURCE: TaskSource = { id: "jira", title: "Jira", provider: "jira" };

/**
 * The sources the Tasks tab offers, in the order the pill lists them.
 *
 * `undefined` is not "no": before the provider list answers, the pill has
 * nothing to offer and the tab waits. `[]` never happens — GitHub issues is
 * always there — which is why an empty Tasks tab is a read failure to explain
 * rather than a machine with nothing to do.
 *
 * Jira first when it is set up, because it is the one source with a board; then
 * the other tracker, named after itself; then issues. A machine with both
 * ClickUp and Jira is offered both: the pill switches between them, and neither
 * silently wins the tab.
 */
export function taskSources(statuses: ProviderStatus[] | null | undefined): TaskSource[] | undefined {
  if (!statuses) return undefined;
  const jira = statuses.find((p) => p.id === "jira" && TASK_IDS.has(p.id) && setUp(p.state));
  const other = bestSetUp(statuses.filter((p) => p.id !== "jira"));
  return [
    ...(jira ? [JIRA_SOURCE] : []),
    ...(other ? [{ id: "tracker" as const, title: providerTitle(other.id), provider: other.id }] : []),
    ISSUES_SOURCE,
  ];
}

/** "ClickUp", "Taskwarrior" — the catalogue's spelling, for "Open in …" and
 *  the like. Falls back to a neutral word rather than an id: `clickup` in a
 *  button is a code, and nobody should read a code on a phone. */
export function providerTitle(id: ProviderId | null | undefined): string {
  return PROVIDERS.find((p) => p.id === id)?.title ?? "the tracker";
}

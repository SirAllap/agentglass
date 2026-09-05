/*
 * Whether this machine tracks work anywhere, and what that costs the bar.
 *
 * ── the question is not "is ClickUp connected" ───────────────────────────
 * ClickUp is one task provider of several. `shared/providers.ts` already lists
 * them with a `kind`, and two of them — Taskwarrior and ClickUp — are tasks
 * today, with nothing stopping a third. So the question this asks is the
 * general one: does the person on the other end of this phone track work in
 * SOMETHING. A check spelled `clickup` would be the app deciding that one
 * workspace's tool is what a task is.
 *
 * ── and the answer changes the bar, which the desk's does not ────────────
 * `web/src/lib/taskConnected.ts` answers the same question and reaches a
 * different conclusion on purpose, so the difference is worth stating rather
 * than looking like drift. Its rule is:
 *
 *   nothing set up   show every task source — this is a fresh install, and
 *                    the bar is the only advertisement the feature has
 *
 * That argument holds at a desk because an unconnected tab there LINKS to the
 * pane that connects it. It does not hold here, and the reason is a rule this
 * app spends its scope on elsewhere: a phone cannot set a provider up. There
 * is no Integrations pane on it, deliberately — the same refusal that makes
 * Troubleshooting print an install line rather than run it. So an empty Cards
 * tab on a phone advertises something you cannot act on from the device you
 * are holding, and it spends a fifth of a five-item bar doing it.
 *
 * ── a broken provider still counts ───────────────────────────────────────
 * Taken from the desk verbatim, because it is right there too: "ClickUp
 * refused this token" is not the same as "you do not use ClickUp", and hiding
 * the tab would remove the one surface that was going to say so.
 */
import { PROVIDERS, type ProviderId, type ProviderSpec, type ProviderState, type ProviderStatus } from "../../../shared/providers.ts";

/** The ids that feed the work-you-owe half, read from the catalogue rather
 *  than listed — a list here would be wrong the first time somebody adds a
 *  provider, and wrong silently. */
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
const setUp = (state: ProviderState): boolean => state === "connected" || state === "error";

/**
 * Does this machine track work anywhere?
 *
 * `null` when it cannot be told — no answer yet, or an answer with no task
 * provider mentioned in it at all. Null is NOT "no": a provider the server did
 * not name is unknown rather than absent, and taking somebody's tab away on a
 * missing answer is the one failure here with no way back from the device
 * looking at it.
 */
export function tracksWork(statuses: ProviderStatus[] | null | undefined): boolean | null {
  if (!statuses) return null;
  const known = statuses.filter((p) => TASK_IDS.has(p.id));
  if (!known.length) return null;
  return known.some((p) => setUp(p.state));
}

/**
 * Which task provider the Cards tab reads from, and what it is called.
 *
 * The tab used to read `/clickup/views` and `/clickup/view` whoever you were,
 * and print "Open in ClickUp" on every card — a phone paired to a machine that
 * tracks work in Taskwarrior got an empty board titled after somebody else's
 * product. The rule here is the one the tab wanted all along:
 *
 *   ClickUp connected            → the board, its saved views, its cards
 *   another tracker set up       → `/tasks/list`, the provider-neutral route
 *   nothing set up               → `null`, and the tab says so
 *   no answer                    → `undefined`, and the tab waits
 *
 * `connected` beats `error` and, at equal state, ClickUp beats the rest — it
 * is the one with views to choose from, and a person with both wants the board
 * on the phone and the local list where the editor is. `error` still counts as
 * set up, for the reason `tracksWork` gives: a refused token is something you
 * configured, and the screen that reads it is where you find out.
 */
export function taskProvider(statuses: ProviderStatus[] | null | undefined): ProviderSpec | null | undefined {
  if (!statuses) return undefined;
  const known = statuses.filter((p) => TASK_IDS.has(p.id) && setUp(p.state));
  if (!statuses.some((p) => TASK_IDS.has(p.id))) return undefined;
  if (!known.length) return null;
  const rank = (p: ProviderStatus): number =>
    (p.state === "connected" ? 0 : 2) + (p.id === "clickup" ? 0 : 1);
  const best = [...known].sort((a, b) => rank(a) - rank(b))[0]!;
  return PROVIDERS.find((p) => p.id === best.id) ?? null;
}

/** "ClickUp", "Taskwarrior" — the catalogue's spelling, for "Open in …" and
 *  the like. Falls back to a neutral word rather than an id: `clickup` in a
 *  button is a code, and nobody should read a code on a phone. */
export function providerTitle(id: ProviderId | null | undefined): string {
  return PROVIDERS.find((p) => p.id === id)?.title ?? "the tracker";
}

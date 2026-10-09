/*
 * What a notification IS, said once.
 *
 * Every surface that interrupts somebody — the desktop popup, the toast card,
 * the banner for a thing they asked to be told about, the bell row — used to be
 * handed a title and a body and, at best, a pane id on the side. The result was
 * "All CI passed" with nothing to press: you read that something happened and
 * then went looking for where.
 *
 * So the payload carries the place it is about. A producer that knows the target
 * (the PR watch knows repo and number; the needs-you path knows the pane) builds
 * one of these, and every surface draws the same thing: the verdict and the
 * object as the title, the one fact that matters as the line, and a way to land
 * on the target in one press.
 *
 * Pure on purpose: no DOM, no store. The decision of what a notification says
 * and where it leads is testable here without a renderer.
 *
 * Ceiling: at most two actions, and the secondary exists only where it saves a
 * trip. A "Re-run failed" on a red CI would be the obvious second one and is not
 * here, because it needs a server route that writes to GitHub and nothing in
 * this change should hold that.
 */

export type NotifyTarget =
  | { kind: "pr"; repo: string; number: number; /** The checkout, for the actions that write to the PR. */ root?: string }
  | { kind: "pane"; pane: string }
  | { kind: "file"; root: string; path: string }
  | { kind: "url"; url: string }
  | { kind: "card"; id: string; label: string };

/** Go to a target, or do the one thing that saves the trip there. */
export type NotifyAction =
  | { label: string; target: NotifyTarget }
  | { label: string; run: "rerun-failed"; root: string; number: number };

export type NotifyPayload = {
  /** Verdict first, then the object: "CI passed · acme/orbit #1042". */
  title: string;
  /** The one fact that matters. Never the title again. */
  line: string;
  /** Short facts under the line, each a few words: "49 passed", "took 12m". */
  facts?: string[];
  target?: NotifyTarget;
  /** The first is the primary and is what pressing the notification itself does. */
  actions?: [NotifyAction] | [NotifyAction, NotifyAction];
};

/** The words on the button that goes to a target. Says where, not "Open". */
export const targetLabel = (t: NotifyTarget): string => {
  switch (t.kind) {
    case "pr": return "Open PR";
    case "pane": return "Open terminal";
    case "file": return "Open file";
    case "url": return "Open link";
    case "card": return "Open card";
  }
};

/** What pressing the notification does: its first action, or its target. */
export const primaryAction = (p: NotifyPayload): NotifyAction | null => {
  if (p.actions?.[0]) return p.actions[0];
  return p.target ? { label: targetLabel(p.target), target: p.target } : null;
};

/** The destination an action leads to, when it is a trip rather than a deed. */
export const actionTarget = (a: NotifyAction): NotifyTarget | null => ("target" in a ? a.target : null);

/** The secondary, when the producer gave one. */
export const secondaryAction = (p: NotifyPayload): NotifyAction | null => p.actions?.[1] ?? null;

/** One line, no markup noise, cut with an ellipsis instead of mid-word nonsense. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

const LINE_MAX = 90;

/** "12m", "45s", "1h 5m": how long a run took, in the two units a person reads. */
export function tookLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** What the checks said, as facts: how many passed, skipped and failed, and how long the longest run took. */
export function checkFacts(
  checks: { success: number; failure: number; skipped: number } | undefined,
  all: { startedAt?: string; completedAt?: string }[] | undefined,
): string[] {
  const facts: string[] = [];
  if (checks) {
    facts.push(`${checks.success} passed`);
    if (checks.skipped) facts.push(`${checks.skipped} skipped`);
    if (checks.failure) facts.push(`${checks.failure} failed`);
  }
  const starts = (all ?? []).map((c) => Date.parse(c.startedAt ?? "")).filter(Number.isFinite);
  const ends = (all ?? []).map((c) => Date.parse(c.completedAt ?? "")).filter(Number.isFinite);
  if (starts.length && ends.length && Math.max(...ends) > Math.min(...starts)) facts.push(`took ${tookLabel(Math.max(...ends) - Math.min(...starts))}`);
  return facts;
}

/**
 * A PR watch that fired, as a notification.
 *
 * The server's `summary` is already the verdict ("CI passed", "CI failed",
 * "evals failed", "New comment"); its `detail` is the one fact when there is one
 * (which checks failed, what was said). With no detail — CI passing has nothing
 * more to say — the line is the PR's own title, so the notification still tells
 * you WHICH change without repeating the verdict.
 *
 * `read` is what the watch saw when it fired: the counts and runs behind the
 * verdict, which become the facts line. A failure also offers the one deed that
 * saves a trip, re-running what failed, when it knows the checkout to do it in.
 * Ceiling: no "Merge" action. Merging is the person's, by hand, in the PR view.
 */
export function watchPayload(
  f: { repo: string; number: number; title: string; summary: string; detail: string; ok?: boolean },
  read: { root?: string; checks?: { success: number; failure: number; skipped: number }; all?: { startedAt?: string; completedAt?: string }[] } = {},
): NotifyPayload {
  const target: NotifyTarget = { kind: "pr", repo: f.repo, number: f.number, ...(read.root ? { root: read.root } : {}) };
  const detail = oneLine(f.detail, LINE_MAX);
  const counted = f.summary === "CI failed" && read.checks && read.checks.failure > 0 && detail;
  const line = counted ? `${read.checks!.failure} failed: ${detail}` : detail || oneLine(f.title, LINE_MAX);
  const facts = checkFacts(read.checks, read.all);
  const failed = f.ok === false;
  const first: NotifyAction = { label: failed ? "Open checks" : targetLabel(target), target };
  const actions: NotifyPayload["actions"] = failed && read.root
    ? [first, { label: "Re-run failed", run: "rerun-failed", root: read.root, number: f.number }]
    : [first];
  return { title: `${f.summary} · ${f.repo} #${f.number}`, line, ...(facts.length ? { facts } : {}), target, actions };
}

/** An agent's alert (blocked, needs you, a tool error): the pane is the target. */
export function alertPayload(a: { title: string; body: string; pane?: string }): NotifyPayload {
  const line = a.body.trim() === a.title.trim() ? "" : oneLine(a.body, LINE_MAX);
  if (!a.pane) return { title: a.title, line };
  const target: NotifyTarget = { kind: "pane", pane: a.pane };
  return { title: a.title, line, target, actions: [{ label: targetLabel(target), target }] };
}

/**
 * A notification the person ASKED for (a PR watch they armed), kept until they
 * act on it.
 *
 * One of these is one EVENT, not one poll: the key is what the event is, so a
 * re-poll of the same head, or a second window reading the same feed, finds the
 * alert already there instead of raising it twice.
 */
export type AskedAlert = {
  id: string;
  key: string;
  ok: boolean;
  payload: NotifyPayload;
  firedAt: number;
  /** A client drew it. */
  seenAt: number | null;
  /** The person pressed its action. */
  actedAt: number | null;
  /** Gone from every window: acted on, or closed. Null while it is waiting. */
  closedAt: number | null;
  /** Why the OS popup could not be shown, when it could not. The in-app banner is there regardless. */
  osError: string | null;
};

/** What makes two fires the same event: the PR, the commit it was read at, and the verdict. */
export const askedAlertKey = (e: { repo: string; number: number; sha: string; verdict: string }): string =>
  `${e.repo}#${e.number}@${e.sha || "?"}:${e.verdict}`;

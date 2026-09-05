/*
 * Where the loop looks for work.
 *
 * Separate from the loop itself on purpose. His answer to "where does work come
 * from" was, correctly, "it depends": at work it is ClickUp and Slack threads,
 * on personal projects it is issues or things he decides himself. A loop that
 * knew about exactly one of those would be useful on one day of the week, so
 * finding work is a list of small readers and choosing between them is
 * somebody else's job.
 *
 * EVERY SOURCE IS READ-ONLY, and one of them is read-only twice over. His rule
 * about the task tracker is absolute and predates this feature: read it, never
 * write to it, not even a test comment. Nothing here posts, comments, moves a
 * card or changes a state — they list what exists and stop.
 */
import { db } from "./db.ts";
import { raiseHand } from "./understudy-help.ts";
import { listPrs } from "./prs.ts";
import { changedForMe } from "./clickup.ts";
import { proposeScope } from "./understudy.ts";
import { addSource, alreadyTaken, MAX_ATTEMPTS, type WorkItem } from "./understudy-work.ts";

/* Re-exported rather than re-declared: `alreadyTaken` now applies this same
   ceiling to an abandoned run's own ceiling, and one number for "how many
   unattended goes before a person is asked" is the point — see the
   definition in understudy-work.ts. */
export { MAX_ATTEMPTS };

/* ── work he hands it directly ──────────────────────────────────────────────
 *
 * The first source that exists, because it is the only one that can answer the
 * question the others cannot: WHICH CHECKOUT.
 *
 * A card says what to do and never says where. A pull request knows its
 * repository. Between those two, the loop found its first live task on a real
 * machine and had nowhere to put it — the fix was to refuse, which is correct
 * and leaves somebody with a loop that declines everything on a quiet Saturday.
 *
 * So: a queue he fills himself. One row, a title, a repository, and the loop
 * has unambiguous work. It is also the honest first way to watch the thing run
 * — give it something small, read what came back, decide whether to give it
 * something bigger. Nobody should hand an hour of autonomy to a machine they
 * have not yet watched do ten minutes.
 */
/* The table lives in db.ts with every other one — see the note there for why
   a schema that depends on import order is not a schema. */

const askedQ = db.query<{ id: number; title: string; detail: string; repo: string; deliverable: string | null; attempts: number }, []>(
  "SELECT id, title, detail, repo, deliverable, attempts FROM understudy_asked WHERE taken_at IS NULL ORDER BY id ASC",
);
const addAskedQ = db.query<{ id: number }, [string, string, string, number, string | null]>(
  "INSERT INTO understudy_asked (title, detail, repo, at, deliverable) VALUES (?, ?, ?, ?, ?) RETURNING id",
);
const dropAskedQ = db.query<never, [number]>("DELETE FROM understudy_asked WHERE id = ?");
/* Same title, same checkout, still pending: `taken_at IS NULL` is exactly the
   "in the queue" reading `asked()` itself uses for a fresh row (see the note
   below). A row he already closed (`taken_at` set) is done work, not a
   duplicate — if it is needed again he can ask again. A match in a different
   repo is a different task that happens to share a name. */
const pendingDupeQ = db.query<{ id: number }, [string, string]>(
  "SELECT id FROM understudy_asked WHERE title = ? AND repo = ? AND taken_at IS NULL LIMIT 1",
);
/* Put an unfinished task back at the FRONT of the queue: `taken_at` cleared so
   the source offers it again, and the attempt counted so this cannot loop for
   ever. Deliberately an UPDATE of the original row rather than a new one — the
   row is the record of what he asked for in his own words, and a copy would
   lose the detail underneath the title. */
const retryAskedQ = db.query<never, [number]>(
  "UPDATE understudy_asked SET taken_at = NULL, attempts = attempts + 1 WHERE id = ?",
);
const attemptsQ = db.query<{ attempts: number; title: string; detail: string; repo: string }, [number]>(
  "SELECT attempts, title, detail, repo FROM understudy_asked WHERE id = ?",
);
const takeAskedQ = db.query<never, [number, number]>("UPDATE understudy_asked SET taken_at = ? WHERE id = ?");

/**
 * The pending row this title already has in this checkout, if any — so a
 * caller can refuse a second one before writing it, and say which row it
 * already has. `taken_at IS NULL` only: a closed row is done work, not a
 * duplicate, and a different repo is a different task that shares a name.
 */
export function pendingDuplicate(title: string, repo: string): number | null {
  try {
    return pendingDupeQ.get(title.slice(0, 300), repo)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Put something in front of it. Returns the row id.
 *
 * Does NOT check for a duplicate itself — this is the write primitive, and
 * every existing caller (tests included) relies on it writing the row it was
 * given and nothing more. Refusing with a reason is a caller decision, made
 * once, at the one place that has to answer a person: the route. See
 * `pendingDuplicate` and `/understudy/work/ask`.
 */
export function ask(p: { title: string; detail?: string; repo: string; deliverable?: string }): number | null {
  try {
    return addAskedQ.get(
      p.title.slice(0, 300), (p.detail ?? "").slice(0, 8000), p.repo, Date.now(),
      p.deliverable?.slice(0, 1000) || null,
    )?.id ?? null;
  } catch {
    return null;
  }
}

/** What he has queued up and it has not started. */
export function asked(): { id: number; title: string; detail: string; repo: string; deliverable: string | null }[] {
  try {
    /*
     * Two records of the same fact, and BOTH are consulted. `taken_at` is this
     * queue's own; the run table is the loop's. Either alone leaves a hole —
     * the rows written before `taken_at` was ever set have no mark on them, and
     * a source could always be told after a run row already exists.
     *
     * Cheap, and the alternative is a hand-written UPDATE against a live
     * database to repair rows that a filter can simply decline to show.
     */
    return askedQ.all().filter((r) => {
      /*
       * A REQUEUED task is exempt from the run-table check, and that exemption
       * is the whole point of requeueing.
       *
       * `alreadyTaken` asks "does a run row exist for this item", which is the
       * right question for work that was done — and the wrong one for work that
       * was interrupted, because the abandoned run row is exactly what proves it
       * was interrupted. Without this, clearing `taken_at` did nothing: the task
       * went back on the queue and the run table hid it again, which is how six
       * restarts turned into six tasks nobody ever picked up.
       *
       * `attempts > 0` is only ever set by `requeue`, so this cannot let a
       * finished task come round again — only one something put back on purpose.
       */
      if (r.attempts > 0) return true;
      return !alreadyTaken("asked", `asked:${r.id}`);
    });
  } catch { return []; }
}

/** Take one back off the list. */
export function unask(id: number): void {
  try { dropAskedQ.run(id); } catch { /* already gone */ }
}

/**
 * Put an unfinished task back, or say it needs a person.
 *
 * Called when a run ended without delivering and nobody chose that — the server
 * went down under it, or a watchdog found it stopped. Returns what it decided,
 * so the caller can log the difference between "it will be picked up again" and
 * "it is now waiting on you".
 *
 * The item id is the queue's own (`asked:<n>`); anything else is a source this
 * cannot put back, and says so rather than pretending.
 */
export function requeue(p: { itemId: string; why: string; runId?: number | null }):
  { requeued: boolean; attempts: number; askedForHelp: boolean } {
  const id = Number(String(p.itemId).replace(/^asked:/, ""));
  if (!Number.isFinite(id) || id <= 0) return { requeued: false, attempts: 0, askedForHelp: false };
  try {
    const row = attemptsQ.get(id);
    if (!row) return { requeued: false, attempts: 0, askedForHelp: false };
    const next = row.attempts + 1;
    if (next > MAX_ATTEMPTS) {
      raiseHand({
        title: row.title,
        question:
          `This task has been started ${next - 1} times and has never finished. ` +
          "It needs a person to look before it is worth trying again.",
        tried: `Last time it stopped because: ${p.why}\n\nWhat was asked for:\n${row.detail}`,
        repo: row.repo,
        runId: p.runId ?? null,
      });
      return { requeued: false, attempts: next - 1, askedForHelp: true };
    }
    retryAskedQ.run(id);
    return { requeued: true, attempts: next, askedForHelp: false };
  } catch {
    return { requeued: false, attempts: 0, askedForHelp: false };
  }
}

/**
 * Off the list, but not deleted.
 *
 * `taken_at` existed from the first version and nothing ever wrote to it, so
 * the filter that reads it was decoration: an item worked start to finish
 * stayed on the queue as pending. Kept rather than deleted because the row is
 * the only record of what he actually asked for, in his words — the run record
 * has the title and none of the detail he wrote underneath it.
 */
function markAskedTaken(id: number): void {
  try { takeAskedQ.run(Date.now(), id); } catch { /* already gone */ }
}

addSource({
  id: "asked",
  label: "What you asked for",
  taken(itemId) {
    const id = Number(itemId.replace(/^asked:/, ""));
    if (Number.isFinite(id) && id > 0) markAskedTaken(id);
  },
  async find({ repos }) {
    return asked()
      // Still inside today's scope. A row he added last week naming a checkout
      // the loop may no longer touch is not work, it is a stale instruction.
      .filter((r) => repos.includes(r.repo))
      .map((r) => ({
        id: `asked:${r.id}`,
        source: "asked",
        title: r.title,
        detail: r.detail,
        repo: r.repo,
        /* The file this task owes, when it owes a file rather than a commit —
           see the note on the column in db.ts. */
        deliverable: r.deliverable || undefined,
        // Above everything else, always. He asked for this one by hand; a card
        // the tracker happens to rank urgent does not outrank that.
        weight: 20,
      }));
  },
});

/*
 * A pull request that is waiting on him.
 *
 * The strongest source there is, because the work is already defined: somebody
 * asked for changes, or CI went red, and what "done" looks like is written down
 * by another person. Nothing has to be guessed about scope.
 */
addSource({
  id: "prs",
  label: "Pull requests waiting on you",
  async find({ repos }) {
    const out: WorkItem[] = [];
    for (const root of repos) {
      try {
        const res = await listPrs(root, "mine", "open");
        for (const pr of res.prs ?? []) {
          /*
           * Changes requested outranks a red build, and both outrank a quiet
           * open PR — which is not offered at all. A pull request nobody has
           * objected to is not work waiting to be done, it is work waiting to
           * be reviewed, and picking it up would be inventing a task.
           */
          const requested = pr.reviewDecision === "CHANGES_REQUESTED";
          const failing = pr.checks.failure > 0;
          if (!requested && !failing) continue;
          out.push({
            id: `${root}#${pr.number}`,
            source: "prs",
            title: `${requested ? "Apply the review on" : "Fix the failing checks on"} #${pr.number}: ${pr.title}`,
            detail: [
              requested ? "A reviewer asked for changes. Read the threads and address them." : "",
              failing ? "The checks are failing. Find out why before changing anything." : "",
            ].filter(Boolean).join("\n"),
            repo: root,
            weight: requested ? 10 : 8,
            url: pr.url,
          });
        }
      } catch {
        // No GitHub credential, no network, not a repository with a remote —
        // all of them mean "this source has nothing right now", not an error.
      }
    }
    return out;
  },
});

/*
 * His own cards.
 *
 * READ ONLY, and this is the one place in the codebase where that is a rule
 * rather than a design choice: he lost a comment to a test once and said, in as
 * many words, that touching the tracker could cost him his job. So this lists
 * and nothing else, and the loop's brief tells the agent the same thing.
 */
addSource({
  id: "clickup",
  label: "Your cards (read only)",
  async find({ repos }) {
    /*
     * OFFERS NOTHING WHILE IT CANNOT PLACE A CARD, and this is a correctness
     * fence rather than tidiness.
     *
     * A card says what to do and never says which checkout it belongs in. Run
     * live on a real machine, the top task this returned was a ticket from his
     * employer's tracker — and with one open-project repository available, the
     * loop's fallback would have cut a worktree in agentglass and set an agent
     * to work on that ticket inside it. Nothing would have reached the
     * employer's repository, so not a leak: just a confident, wrong, wasted
     * run, which erodes trust faster than an outright failure does.
     *
     * Until something can map a card to a checkout, this source stays quiet
     * whenever the loop is scoped to repositories it cannot match a card to.
     * Being silent is the honest state; offering work that cannot be placed is
     * an invitation to place it wrongly.
     */
    if (!repos.length) return [];
    /*
     * SILENT UNLESS HE HAS OPENED THE SCOPE, and this is the fence he asked for
     * in as many words: as long as nothing of the closed side is touched, he
     * is calm.
     *
     * A card names what to do and never names a checkout. While the loop is
     * scoped to the open project, every card in his tracker is work belonging
     * to a repository the loop may not touch — so the only honest answer this
     * source can give is nothing at all.
     *
     * Measured, and that is why this is here rather than left to the route: the
     * first live call with an open-project checkout available picked a card
     * from his employer's tracker as the next task. The route would have
     * refused it for having no repository, so nothing would have run. But a
     * loop whose SELECTION lands on his employer's work is one nobody should
     * have to trust the next fence to catch, and the day somebody teaches cards
     * to carry a repository that last fence stops applying.
     */
    if (proposeScope() !== "everywhere") return [];
    const out: WorkItem[] = [];
    try {
      /*
       * `changedForMe` rather than the raw task fetch: it already knows the
       * token, the workspace and who he is, and asking the lower-level call
       * would mean this file holding credentials it has no business holding.
       *
       * A fortnight back, because a card nobody has touched in a month is not
       * what somebody means by "find me something to work on".
       */
      const res = await changedForMe(Date.now() - 14 * 86_400_000);
      for (const t of res.data?.tasks ?? []) {
        // Open only. A card that is done is not work waiting on him.
        if (t.statusKind !== "open") continue;
        out.push({
          id: `clickup:${t.id}`,
          source: "clickup",
          title: t.title,
          detail: [
            t.list ? `List: ${t.list}` : "",
            t.priority ? `Priority: ${t.priority}` : "",
            t.due ? `Due: ${t.due}` : "",
            t.tags.length ? `Tags: ${t.tags.join(", ")}` : "",
          ].filter(Boolean).join("\n"),
          // Empty: a card does not know which checkout it belongs in, and
          // guessing would point the loop at the wrong repository.
          repo: "",
          // Urgency from the card's own priority, so his triage carries over
          // rather than being re-decided here.
          weight: t.priority === "urgent" ? 9 : t.priority === "high" ? 7 : 5,
          url: t.url,
        });
      }
    } catch {
      // No token, no network, or the workspace is unreachable.
    }
    return out;
  },
});

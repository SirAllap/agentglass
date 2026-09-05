/*
 * SECURITY.md makes three factual claims about what is kept. These pin them.
 *
 * A security policy that has drifted from the code is worse than none: someone
 * reads "nothing in the app deletes it", plans around that, and is wrong. But
 * the claims are exactly the kind that stop being true as a side effect —
 * somebody adds a "clear history" button, or gives the rollup an expiry, and
 * the document says otherwise for as long as nobody rereads it.
 *
 * So this is a tripwire on the prose, not a ban on the feature. If one of these
 * fails because the product genuinely changed, the fix is to update SECURITY.md
 * in the same commit — which is the whole point.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { docContaining } from "./docs.ts";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the promises SECURITY.md makes about retention", () => {
  test("the only rows anything deletes are the ones retention prunes", () => {
    // "there is no route, no button and no menu item that removes recorded
    // data". Every DELETE in the server, and each one has to be the prune.
    const src = read("server/src/db.ts");
    const all: string[] = [];
    for (const f of ["db.ts", "gate.ts", "index.ts", "transcripts.ts", "skills.ts", "insights.ts"]) {
      for (const m of read(`server/src/${f}`).matchAll(/DELETE\s+FROM\s+(\w+)/gi)) all.push(`${f}:${m[1]}`);
    }
    expect(all.sort()).toEqual([
      /* Scheduled agent starts (agentschedule.ts): fired or cancelled rows are
         records and age out; one still waiting is intent and is never swept. */
      "db.ts:agent_schedule",
      // Not recorded data: one row holding the pid and port of whichever server
      // process owns this database file, released on a clean exit so the next
      // one need not prove the previous is dead. Deleting it removes no event,
      // no session and no prompt — which is why it is listed here and not in
      // pruneOldRows below.
      "db.ts:db_claim",
      "db.ts:events",
      "db.ts:events_fts",
      "db.ts:gates",
      /* Ended named agents (agentops.ts): a window that no longer exists. A
         live one is never swept, its pane being the record that it runs. */
      "db.ts:named_agent",
      "db.ts:reminders",
      /* What a session is to the app (the Lantern's chat): a mark that
         outlives its session by ninety days, then nothing needs it. */
      "db.ts:session_role",
      /*
       * Not recorded data either: one row per hooked session saying it is
       * currently stopped on a person — set by a wait-shaped Notification,
       * removed by the next thing the session does. It is a flag about NOW,
       * with no history behind it to lose; the notification itself, when the
       * scanner does not own the session, is still in `events` under the same
       * retention as everything else. Deleting the flag is the session moving
       * on, which is why it sits here beside db_claim and not in pruneOldRows.
       */
      "db.ts:session_wait",
      /* Twice: the session moving on, and the Lantern's own chat, whose
         "waiting for your input" is a person mid-conversation — its flag is
         dropped the moment its hooks say what it is. Same flag, same reason. */
      "db.ts:session_wait",
      "db.ts:sessions",
      // The understudy's own two windows: the bare fact of a write ages out at
      // ninety days, the sealed situation behind a decision at thirty. Both are
      // retention doing its job, so both belong in pruneOldRows with the rest —
      // and the check below holds them to it. What is deliberately NOT here is
      // understudy_ledger's `decision` and `fence` rows, which are the score
      // itself and have no expiry, exactly as daily_rollup has none.
      /*
       * The actuator's three, added when it learned to act and — for a day —
       * added without any window at all. That is how a store grows without
       * bound: not by a decision to keep everything, but by tables appearing on
       * an afternoon when the interesting question was whether it worked.
       *
       * Two carry an exception that is the whole point. A PENDING proposal
       * never expires, because it is the understudy waiting on a person and
       * expiring it answers for them by doing nothing. An act that has NOT been
       * undone is never swept, because the recipe is the only way back from
       * something that happened while they were away.
       */
      "db.ts:understudy_acts",
      /*
       * The work loop's two, and this is the SECOND time the gap was opened
       * the same way. The actuator's three arrived with no window and were
       * given one; then the loop arrived with two more and no window, by the
       * identical route. So the rule stopped being a comment: a test now
       * enumerates every understudy table and fails when one has no expiry.
       *
       * Same shape of exception, for the same reasons. A RUNNING run is never
       * swept, because "started, never finished" is the only record that an
       * agent was killed mid-task. A task still QUEUED never expires, because
       * it is a person waiting to be worked for, and expiring it answers for
       * them by doing nothing.
       */
      "db.ts:understudy_asked",
      /* Answered questions expire; an OPEN one never does, for the same reason
         a queued task never does — it is a person who has not answered yet. */
      "db.ts:understudy_help",
      "db.ts:understudy_ledger",
      "db.ts:understudy_proposals",
      "db.ts:understudy_shifts",
      "db.ts:understudy_snapshots",
      "db.ts:understudy_work",
    ]);
    // …and all eight are inside pruneOldRows, bounded by a cutoff.
    const prune = src.slice(src.indexOf("export function pruneOldRows"));
    const body = prune.slice(0, prune.indexOf("\n}\n"));
    for (const t of ["events_fts", "events", "sessions", "gates", "reminders",
                     "understudy_snapshots", "understudy_ledger",
                     "understudy_proposals", "understudy_shifts", "understudy_acts",
                     "understudy_work", "understudy_asked", "understudy_help", "named_agent", "session_role", "agent_schedule"]) {
      expect(body, `DELETE FROM ${t} escaped pruneOldRows`).toContain(`DELETE FROM ${t}`);
    }

    /*
     * The two understudy sweeps sit ABOVE the `if (!RETENTION_DAYS) return`,
     * and that is the one thing about them worth a tripwire of its own.
     *
     * AGENTGLASS_RETENTION_DAYS is the user's to set and 0 is a legitimate
     * value. If the understudy's expiry were below that early return, somebody
     * turning event pruning off would silently stop the sealed situations
     * expiring too — a store of the material the understudy read, growing
     * without bound, because of a setting about something else. Moving either
     * DELETE below the guard fails here.
     */
    const guard = body.indexOf("if (!RETENTION_DAYS) return");
    expect(guard, "the RETENTION_DAYS guard moved out of pruneOldRows").toBeGreaterThan(-1);
    for (const t of ["understudy_snapshots", "understudy_ledger"]) {
      expect(body.indexOf(`DELETE FROM ${t}`), `${t} now expires only when event retention is on`)
        .toBeLessThan(guard);
    }
  });

  /**
   * The README told the user his raw prompts were kept for ever.
   *
   * It said "the desktop app defaults AGENTGLASS_RETENTION_DAYS=0". Nothing set
   * it — not `electron/main.js`, which builds the sidecar's environment and
   * passes exactly three variables — so the packaged app ran at the eight-day
   * default and pruned hourly. The app itself was honest the whole time (boot
   * log, Settings ▸ Budgets); only the prose was wrong, and it was wrong about
   * how long the most sensitive thing in the database survives.
   *
   * So: if anyone ever does set it, this fails, and the README is corrected in
   * the same commit rather than years later.
   */
  test("nothing sets AGENTGLASS_RETENTION_DAYS, so the README must not claim it does", () => {
    const setters: string[] = [];
    for (const f of ["electron/main.js", "electron/build.mjs", "server/src/index.ts", "server/src/db.ts"]) {
      // An assignment, not a read: `process.env.X ?? 8` has no `=` or `:` after
      // the name, while `X: "0"` in an env object and `env.X = "0"` both do.
      for (const m of read(f).matchAll(/AGENTGLASS_RETENTION_DAYS\s*[:=]\s*["'`0-9]/g)) setters.push(`${f}: ${m[0]}`);
    }
    expect(setters, "someone now sets a retention default — update the retention row in docs/CONFIG.md").toEqual([]);

    // The claim lives wherever the variable table lives — it started in the
    // README and now sits in docs/CONFIG.md. What matters is that the table
    // still states the real default the code applies, not which file holds it.
    const { text: vars } = docContaining("| `AGENTGLASS_RETENTION_DAYS` |", "the retention row of the variable table");
    expect(vars).not.toContain("defaults `AGENTGLASS_RETENTION_DAYS=0`");
    expect(vars).toContain("| `AGENTGLASS_RETENTION_DAYS` | `8` |");
  });

  test("the rollup has no expiry and no removal path", () => {
    // "The rollup has no expiry at all." It is the one table designed to be
    // kept for years, and the one whose contents outlive the rows they came
    // from — so a DELETE against it would silently shorten every long-window
    // number in the product.
    for (const f of ["db.ts", "index.ts"]) {
      expect(read(`server/src/${f}`)).not.toMatch(/DELETE\s+FROM\s+daily_rollup/i);
    }
  });

  test("no route removes recorded data", () => {
    // A DELETE-verb route, or a path that reads like one, would make the
    // "no route" half of the claim false.
    const idx = read("server/src/index.ts");
    const routes = [...idx.matchAll(/pathname === "(\/[^"]*)"/g)].map((m) => m[1]!);
    const suspicious = routes.filter((r) => /delete|purge|clear|wipe|forget|reset/i.test(r) && !REVIEWED.has(r));
    expect(suspicious, "a route now removes data — say so in SECURITY.md").toEqual([]);
  });

  /**
   * The exceptions, and the reason they are not just holes in the rule above.
   *
   * This tripwire matches on the *name* of a route, which is cheap and catches
   * the thing worth catching. It also means an honestly-named route that
   * removes nothing recorded can trip it: `/pair/forget` revokes one paired
   * device's credential, and devices.ts deliberately keeps a revoked row rather
   * than dropping it, precisely so "did I definitely cut that phone off" stays
   * answerable.
   *
   * Renaming it to slip past the regex would leave a heuristic passing for a
   * reason that has nothing to do with what it is checking, which is how a
   * tripwire quietly stops being one. So the exception is listed, and the test
   * below makes it earn its place on every run.
   */
  const REVIEWED = new Set([
    "/pair/forget",
    // Deletes a task in Taskwarrior — the user's own list, in their own store,
    // which agentglass reads and does not record. Nothing of ours is removed,
    // and refusing a task manager the ability to delete a task would be an odd
    // reading of a promise about telemetry. The test below holds it to that.
    "/tasks/write/delete",
    // Throws away the browsing history imported from the user's OWN browser,
    // which lives in its own file (placestore.ts) precisely so it can be
    // deleted without touching a month of fleet telemetry. Nothing recorded by
    // agentglass is removed; the events database is not opened. The check
    // below holds it to that.
    "/browser/places/forget",
    // Puts one entry of the Review menu back to the wording it ships with, by
    // dropping the user's override out of review-prompts.json — a config file
    // of their own edits, next to commands.json. Nothing recorded is removed:
    // it is the same class of write as saving a prompt, and the events
    // database is never opened. The check below holds it to that.
    "/pr-prompts/reset",
    // Kills OUR tmux server and rewrites the generated tmux.conf after a
    // rejected override — the settings panel's self-recovery button. It
    // touches no database and deletes no state: restore captures stay until
    // the user clears them, chat transcripts live elsewhere. The check below
    // holds it to that.
    "/terminal/tmux-reset",
    // Empties a custom field on somebody's ClickUp card — their workspace,
    // their data, and the only way to take a chosen value back (a drop-down set
    // to the empty string is a 400). Nothing recorded by agentglass is removed;
    // no database is opened. The check below holds it to that.
    "/clickup/field/clear",
    // Deletes a ClickUp comment, in ClickUp, by its id. Same reading as the
    // task delete above: refusing a card panel the ability to remove a comment
    // somebody wrote by mistake would be an odd reading of a promise about
    // telemetry. Ours records nothing about it either way.
    "/clickup/comment/delete",
  ]);

  test("the reviewed exceptions still touch no stored data", () => {
    const idx = read("server/src/index.ts");
    for (const route of REVIEWED) {
      const at = idx.indexOf(`pathname === "${route}"`);
      expect(at, `${route} is no longer a route — take it out of REVIEWED`).toBeGreaterThan(-1);
      // To the start of the next route, so the check reads the whole handler
      // and only the handler however long it grows.
      const rest = idx.slice(at + 1);
      const next = rest.indexOf('pathname === "');
      const body = next === -1 ? rest : rest.slice(0, next);
      expect(body, `${route} now reaches the database`).not.toMatch(/DELETE\s+FROM|pruneOldRows|\bdb\.(run|query|exec|prepare)\b/i);
    }
  });

  test("SECURITY.md still says all three, so the tripwire is wired to something", () => {
    // Guards against the other failure: the claims quietly leaving the
    // document while these tests carry on passing about nothing.
    const doc = read("SECURITY.md");
    expect(doc).toContain("nothing in the app deletes it");
    expect(doc).toContain("The rollup has no expiry at all");
    expect(doc).toContain("bounds the raw events, not the history");
  });
});

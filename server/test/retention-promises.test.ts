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
      // Not recorded data: one row holding the pid and port of whichever server
      // process owns this database file, released on a clean exit so the next
      // one need not prove the previous is dead. Deleting it removes no event,
      // no session and no prompt — which is why it is listed here and not in
      // pruneOldRows below.
      "db.ts:db_claim",
      "db.ts:events",
      "db.ts:events_fts",
      "db.ts:gates",
      "db.ts:reminders",
      "db.ts:sessions",
    ]);
    // …and all five are inside pruneOldRows, bounded by the cutoff.
    const prune = src.slice(src.indexOf("export function pruneOldRows"));
    const body = prune.slice(0, prune.indexOf("\n}\n"));
    for (const t of ["events_fts", "events", "sessions", "gates", "reminders"]) {
      expect(body, `DELETE FROM ${t} escaped pruneOldRows`).toContain(`DELETE FROM ${t}`);
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
    expect(setters, "someone now sets a retention default — update README.md's desktop bullet").toEqual([]);

    const readme = read("README.md");
    expect(readme).not.toContain("defaults `AGENTGLASS_RETENTION_DAYS=0`");
    // And the table still states the real default the code applies.
    expect(readme).toContain("| `AGENTGLASS_RETENTION_DAYS` | `8` |");
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

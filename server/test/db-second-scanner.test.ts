// A second server process on one database file silently doubled events, tokens
// and cost: the scanner read `transcript_files.lines_done` outside any
// transaction and wrote it back unconditionally, and scanner events carry
// `event_id: null` so the ingest idempotency index cannot dedupe them. Nothing
// errored; the numbers just grew. Measured on a real 354 MB history: 22
// duplicate groups out of 100,354 scanner events.
//
// Both halves of the fix are proven here the way the bug was proven — with real
// processes, not by reasoning about one. Half one: the progress marker is a
// compare-and-swap inside the batch transaction, so a racing sweep abandons its
// batch instead of re-ingesting. Half two: the database is claimed at boot, so
// the second process never starts a scanner at all, and a claim left behind by
// a SIGKILLed process is taken over rather than honoured for ever.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dir, "..", "src");
const scanUrl = pathToFileURL(join(SRC, "transcripts.ts")).href;
const dbUrl = pathToFileURL(join(SRC, "db.ts")).href;

/** A child that is a *server process*, not a test: NODE_ENV must not be "test"
 *  or db.ts routes it to its own scratch file and the two never share one. */
function spawnServerLike(script: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, NODE_ENV: "production", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}
const out = async (p: ReturnType<typeof spawnServerLike>) => (await new Response(p.stdout).text()).trim();

describe("two server processes, one database", () => {
  test("a racing sweep abandons its batch instead of ingesting the same lines twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-2nd-scanner-"));
    const projects = join(dir, "projects");
    const proj = join(projects, "-second-scanner");
    const cwd = join(dir, "secondproj");
    mkdirSync(proj, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const dbFile = join(dir, "shared.db");
    const jsonl = join(proj, "race.jsonl");

    const sid = "second-scanner";
    let clock = Date.now() - 3_600_000;
    const ts = () => new Date((clock += 1000)).toISOString();
    const prompt = (t: string) =>
      JSON.stringify({ type: "user", cwd, sessionId: sid, timestamp: ts(), message: { role: "user", content: t } });
    // Usage rides on assistant turns, so the appended tail is where the doubled
    // tokens and dollars came from — 1000 input tokens per turn, exactly.
    const reply = (id: string) =>
      JSON.stringify({
        type: "assistant", cwd, sessionId: sid, timestamp: ts(),
        message: {
          id, role: "assistant", model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok " + id }],
          usage: { input_tokens: 1000, output_tokens: 10 },
        },
      });

    const HISTORY = 20;
    // Long enough that the first sweeper is still working its way down the tail
    // when the second one reads the progress marker — which is the whole race.
    // With 8 turns the leader was simply finished before the follower looked,
    // and the test passed against the bug.
    const TURNS = 200;
    writeFileSync(jsonl, Array.from({ length: HISTORY }, (_, i) => prompt(`p${i}`) + "\n").join(""));

    const env = {
      AGENTGLASS_DB: dbFile,
      AGENTGLASS_PROJECTS_DIR: projects,
      AGENTGLASS_ROOT: dir,
      XDG_CONFIG_HOME: join(dir, "cfg"),
      XDG_DATA_HOME: join(dir, "data"),
      // One line per transaction, so the tail takes 200 commits with a yield
      // between each: that is what keeps the leader busy across the skew below.
      AGENTGLASS_SCAN_BATCH_LINES: "1",
    };
    const sweeper = (startAt: number) => `
      process.env.NODE_ENV = "production";
      const t = await import(${JSON.stringify(scanUrl)});
      while (Date.now() < ${startAt}) await new Promise((r) => setTimeout(r, 2));
      process.stdout.write(String(await t.scanOnce(null)));
    `;

    // One process lays down the history, so both racers start from the same
    // durable marker — the live-tail case the finding was measured on.
    const seed = spawnServerLike(sweeper(Date.now()), env);
    await seed.exited;
    expect(await out(seed)).toBe(String(HISTORY));

    appendFileSync(jsonl, Array.from({ length: TURNS }, (_, i) => reply("m" + i) + "\n").join(""));

    // Both wait out the same wall clock, so the only lag between them is this
    // skew — long enough to clear process-start jitter, far shorter than the
    // leader's run down the tail. Pre-fix that lands the follower's read of
    // `lines_done` mid-file and it re-ingests every line from there (measured:
    // 78 extra rows), or its deferred transaction fails to promote and the file
    // is dropped with "database is locked". Both are asserted against below.
    const startAt = Date.now() + 800;
    const a = spawnServerLike(sweeper(startAt), env);
    const b = spawnServerLike(sweeper(startAt + 120), env);
    await Promise.all([a.exited, b.exited]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // The loser abandons its batch and says nothing; it does not log a failed
    // sweep, and it does not give up on the file with an error.
    for (const p of [a, b]) expect(await new Response(p.stderr).text()).not.toContain("[scan]");
    // Exactly one of them ingested the tail — the other found the marker moved.
    expect(Number(await out(a)) + Number(await out(b))).toBe(TURNS);

    const read = new Database(dbFile, { readonly: true });
    // Scanner rows have no event_id, so "the same line twice" has to be spotted
    // by its content — which is precisely why the idempotency index misses it.
    const dupes = read
      .query<{ groups: number; extra: number | null }, []>(
        `SELECT COUNT(*) groups, SUM(n - 1) extra FROM (
           SELECT COUNT(*) n FROM events WHERE event_id IS NULL
           GROUP BY session_id, hook_event_type, timestamp, payload HAVING COUNT(*) > 1)`
      )
      .get()!;
    expect({ groups: dupes.groups, extra: dupes.extra ?? 0 }).toEqual({ groups: 0, extra: 0 });

    const session = read
      .query<{ event_count: number; input_tokens: number }, [string]>(
        "SELECT event_count, input_tokens FROM sessions WHERE session_id = ?"
      )
      .get(sid)!;
    expect(session.event_count).toBe(HISTORY + TURNS);
    expect(session.input_tokens).toBe(TURNS * 1000);
    expect(
      read.query<{ lines_done: number }, [string]>("SELECT lines_done FROM transcript_files WHERE path = ?").get(jsonl)
        ?.lines_done
    ).toBe(HISTORY + TURNS);
    read.close();
  }, 30_000);

  test("the second process finds the file claimed and does not scan; a killed holder's claim is taken over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-db-claim-"));
    const dbFile = join(dir, "claimed.db");
    const env = { AGENTGLASS_DB: dbFile, XDG_CONFIG_HOME: join(dir, "cfg"), XDG_DATA_HOME: join(dir, "data") };

    // The holder: claims the file and then stays alive, so its pid is a live one
    // and `holderAlive` has something real to answer about.
    const holder = spawnServerLike(
      `
      process.env.NODE_ENV = "production";
      const d = await import(${JSON.stringify(dbUrl)});
      d.claimDatabase(4711);
      process.stdout.write("claimed");
      await new Promise(() => {});
      `,
      env
    );
    const claimedPid = holder.pid;
    // Wait for the row, rather than guessing at a sleep long enough for it.
    const claimRow = () => {
      try {
        const r = new Database(dbFile, { readonly: true });
        const row = r.query<{ pid: number }, []>("SELECT pid FROM db_claim WHERE id = 1").get();
        r.close();
        return row;
      } catch { return null; } // the file/table may not exist yet
    };
    for (let i = 0; i < 100 && claimRow()?.pid !== claimedPid; i++) await Bun.sleep(50);
    expect(claimRow()?.pid).toBe(claimedPid);

    const second = spawnServerLike(
      `
      process.env.NODE_ENV = "production";
      const d = await import(${JSON.stringify(dbUrl)});
      const t = await import(${JSON.stringify(scanUrl)});
      const r = d.claimDatabase(4712);
      process.stdout.write(JSON.stringify({ ok: r.ok, holderPid: r.holder?.pid ?? null, holderPort: r.holder?.port ?? null, scanning: t.scanningEnabled() }));
      `,
      env
    );
    await second.exited;
    expect(JSON.parse(await out(second))).toEqual({ ok: false, holderPid: claimedPid, holderPort: 4711, scanning: false });

    // SIGKILL, which is how this app usually dies — the row outlives the
    // process and must not lock the next one out.
    holder.kill("SIGKILL");
    await holder.exited;

    const third = spawnServerLike(
      `
      process.env.NODE_ENV = "production";
      const d = await import(${JSON.stringify(dbUrl)});
      const t = await import(${JSON.stringify(scanUrl)});
      const r = d.claimDatabase(4713);
      process.stdout.write(JSON.stringify({ ok: r.ok, tookOver: r.tookOver?.pid ?? null, scanning: t.scanningEnabled() }));
      `,
      env
    );
    await third.exited;
    expect(JSON.parse(await out(third))).toEqual({ ok: true, tookOver: claimedPid, scanning: true });
  }, 30_000);
});

/*
 * The universal net, through a real server.
 *
 * The net is one line in the request pipeline, and the reason it needs an
 * end-to-end test rather than a unit test is that everything interesting about
 * it is WHERE it sits. `openStub` called with the right arguments proves
 * nothing: the questions are whether it runs before any route can answer,
 * whether the status it eventually records is the status the caller actually
 * saw, and whether a request body can reach a column. None of those is a
 * property of the function. All of them are properties of the placement.
 *
 * So a canary goes through the routes whose body is a credential, and then
 * EVERY column of both tables is read back and searched for it. Not the columns
 * a body might plausibly land in — every one, including the ones that hold
 * hashes and timestamps, because the failure this is guarding against is
 * somebody in a year adding a field "just for debugging" and the test still
 * passing because it only looked where the secret used to not be.
 *
 * The database is opened directly with `bun:sqlite` rather than through
 * `../src/db.ts`. `bun test` shares one module registry across files, so the
 * second file to import db.ts gets the FIRST file's database — measured by the
 * agent that wrote the schema tests. Reading the spawned server's file with a
 * second connection has no such trap, and it is also the more honest read: it
 * is what the row looks like to anything that is not this process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-the-net-test";

/**
 * The string that must not travel.
 *
 * Distinctive enough that a substring match cannot hit it by accident, and
 * invented rather than taken from anything real — this repository is public and
 * a test fixture is a published document.
 */
const CANARY = "orbit-canary-9f3ac1-nothing-may-copy-this";

let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-understudy-net-"));
  dbFile = join(dir, "net.db");

  /*
   * Switch the understudy on the way a user would, by writing the file it
   * reads, and NOT by calling `setEnabled` in this process — the server is a
   * separate process and would not see it. `POST /understudy/enable` is the
   * other door and it is deliberately shut here: it is desktop-only, so a test
   * that used it would be asserting against a forged Origin instead of against
   * the stored preference the feature actually runs on.
   */
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "understudy.json"), JSON.stringify({ enabled: true, modes: {} }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // Named, never `...process.env`: a leaked variable here would be a server
    // reading a developer's real config — and this one is deciding whether to
    // record everything that happens.
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: dbFile,
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) {
    throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
  }
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });

/** Every row of a table, as plain objects. Opened fresh each time: the server
 *  is still writing, and a connection held across the file would be reading a
 *  snapshot older than the request that just returned. */
function all(table: string): Record<string, unknown>[] {
  const db = new Database(dbFile);
  try {
    return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const ledgerFor = (route: string) => all("understudy_ledger").filter((r) => r.route === route);

describe("what the net records", () => {
  test("an ordinary write leaves exactly one row, with the status the caller really saw", async () => {
    // `/notifications/open` is chosen for being dull: it is a POST, it is not on
    // the blind list, it spawns nothing, and it answers through the `json`
    // helper — which is the whole of what "the status is real" depends on.
    const res = await post("/notifications/open", { id: "no-such-notification" });
    const rows = ledgerFor("/notifications/open");
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("stub");
    expect(rows[0]!.method).toBe("POST");
    // Not "some number": the status the HTTP client got. If the settle moved
    // above the answer, or a later error path overwrote it, these diverge.
    expect(rows[0]!.status).toBe(res.status);
    // Loopback is `local` rather than an address — the same rule the action log
    // uses, so the two records name the same actor for the same request.
    expect(rows[0]!.actor).toBe("local");
  });

  test("a route that answers outside the json helper leaves the status NULL, and that is the record saying so", async () => {
    /*
     * `/chat/send` returns a Response built inside chat.ts — a stream on the
     * happy path, and on this one a refusal from `planTurn`, which never
     * touches the per-request `json` helper. So its stub is opened and never
     * settled.
     *
     * This is asserted rather than papered over because the alternative is
     * worse in both directions: settling it here would require the net to guess
     * a status it does not have, and leaving it undocumented would let somebody
     * read NULL as "the row was lost". NULL means "answered outside the json
     * helper", and the most consequential POST in the app is one of those.
     */
    const res = await post("/chat/send", {});
    expect(res.ok).toBe(false);
    const rows = ledgerFor("/chat/send");
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe(null);
  });

  test("a read is not a write", async () => {
    // The net is POST-only. A ledger with the dashboard's own polling in it is
    // a ledger nobody ever scrolls to the bottom of.
    await fetch(base + "/health", { headers });
    await fetch(base + "/stats", { headers });
    expect(ledgerFor("/health")).toEqual([]);
    expect(ledgerFor("/stats")).toEqual([]);
  });
});

describe("what the net refuses to touch", () => {
  test("a route whose body is a credential leaves no row at all", async () => {
    // Both shapes of the blind list: an exact path and a prefix.
    await post("/pair/claim", { code: CANARY, name: "Pixel 9" });
    await post("/providers/connect", { id: "clickup", token: CANARY });
    await post("/control", { cmd: "view", to: "dash", secret: CANARY });

    expect(ledgerFor("/pair/claim")).toEqual([]);
    expect(ledgerFor("/providers/connect")).toEqual([]);
    expect(ledgerFor("/control")).toEqual([]);
  });

  test("every column of every understudy table, for the secret that went through", () => {
    /*
     * The grep the whole feature is judged by.
     *
     * It runs over the tables as they are, not over a list of column names
     * written when this was drafted — `SELECT *` is what makes a column added
     * next year part of the assertion without anybody remembering to add it.
     */
    const tables = ["understudy_ledger", "understudy_snapshots", "understudy_quarantine", "understudy_precedents"];
    for (const table of tables) {
      for (const row of all(table)) {
        for (const [column, value] of Object.entries(row)) {
          expect(String(value ?? ""), `${table}.${column} carried the canary`).not.toContain(CANARY);
        }
      }
    }
  });

  test("and the grep above was not searching an empty table", () => {
    // The failure mode of a negative assertion: it passes beautifully when
    // nothing was recorded at all. The rows from the tests above have to be
    // there, or "no canary anywhere" is a statement about an empty database.
    expect(all("understudy_ledger").length).toBeGreaterThan(0);
  });
});

/*
 * The one refusal that is not about a body.
 *
 * A second server, deliberately without a token, because the thing being tested
 * is a state the first one cannot be in. `resolveToken` returns null on the
 * zero-config loopback path; with AUTH_TOKEN null the whole caller block in the
 * request pipeline never runs, so no principal is ever resolved and
 * `understudyAllows` — every limit this feature has — is never consulted.
 *
 * Enabling the understudy there would give it a fence that exists only in a
 * comment. The route refuses, and it refuses with 409 rather than 403 because
 * nothing about the request is wrong: the server is in a state that cannot hold
 * the promise. That distinction is worth a test, because the temptation on the
 * day somebody hits this is to "just let it through on loopback".
 */
describe("switching it on where the fences cannot hold", () => {
  let tdir = "", tbase = "";
  let tproc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    tdir = mkdtempSync(join(tmpdir(), "agx-understudy-notoken-"));
    const port = await freePort();
    tbase = `http://127.0.0.1:${port}`;
    tproc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "",
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: tdir,
        XDG_CONFIG_HOME: tdir,
        // State (audit log, ledgers, engine conf) jailed too: without this a booted
        // server writes into the developer's real ~/.local/state/agentglass.
        AGENTGLASS_STATE_DIR: `${tdir}/state`,
        AGENTGLASS_ROOT: tdir,
        AGENTGLASS_DB: join(tdir, "notoken.db"),
        // No AGENTGLASS_TOKEN. That is the whole fixture.
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(tbase + "/health")).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    if (!(await fetch(tbase + "/health").then((r) => r.ok).catch(() => false))) {
      throw new Error("the tokenless server did not come up: " + (await new Response(tproc.stderr as ReadableStream).text()).slice(0, 400));
    }
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { tproc?.kill(); } catch { /* already gone */ }
    try { rmSync(tdir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("a tokenless server refuses to enable the understudy, and says which variable fixes it", async () => {
    const res = await fetch(tbase + "/understudy/enable", {
      method: "POST",
      // The packaged shell's own scheme: the route is desktop-only, so a
      // browser cannot reach it at all and this is the only caller that can.
      headers: { "content-type": "application/json", origin: "agentglass://app" },
      body: JSON.stringify({ on: true }),
    });
    expect(res.status).toBe(409);
    const b = await res.json() as Record<string, any>;
    expect(b.ok).toBe(false);
    // Naming the variable is the difference between a refusal and a dead end.
    expect(String(b.error)).toContain("AGENTGLASS_TOKEN");
  });

  test("and it stayed off — a refusal that half-applied would be the worst outcome here", async () => {
    const card = await fetch(tbase + "/understudy/scorecard").then((r) => r.json() as Promise<Record<string, any>>);
    expect(card.enabled).toBe(false);
  });
});

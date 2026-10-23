/*
 * Moving a Jira card by transition, against the stand-in site, as Cloud (REST
 * v3) and as Data Center (REST v2, a bearer token).
 *
 * What a mistake here costs: a card moved on a stale view of it, a move that
 * needs a field going out anyway and coming back as a 400, a missing permission
 * read as "this workflow has no statuses", a workflow's own words (a status or a
 * move named by a team) turned into ours, and a "done" that was only the answer
 * to a read of the card from before the write. Each request count below is the
 * user's action.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-move-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_WRITE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");

const credFile = join(dir, "creds.json");
J.__setJiraSettingsPath(join(dir, "jira-settings.json"));

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`moving a card, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    let proxy: ReturnType<typeof Bun.serve> | null = null;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      // The priority list is remembered after the first card read, as it is in a real session.
      expect((await J.withStored((c) => J.readIssue(c, "ORBIT-1042"))).ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => {
      for (const a of added.splice(0)) {
        const list = fake.state.workflow.transitions[a.from]!;
        list.splice(list.findIndex((t) => t.id === a.id), 1);
      }
      delete process.env.AGENTGLASS_JIRA_WRITE;
      J.__setJiraBase(null);
      proxy?.stop(true);
      proxy = null;
    });

    // The stand-in shares its workflow between sites in one process: what a test adds, it takes out.
    const added: { from: string; id: string }[] = [];
    const addMove = (from: string, t: { id: string; name: string; toStatusId: string; requiredFields?: string[] }) => {
      fake.state.workflow.transitions[from]!.push({ requiredFields: [], ...t, acceptsAssignee: false });
      added.push({ from, id: t.id });
    };
    const upd = (k: string) => Date.parse(fake.state.issues[k]!.updated);
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);
    const posts = () => fake.requests.filter((r) => r.method !== "GET");
    const move = (k: string, id: string, updated = upd(k)) => J.moveStored(k, id, updated);

    describe("the list", () => {
      test("only the moves valid from here, labelled by the status they lead to, in one request", async () => {
        const r = await J.movesStored("ORBIT-1042");
        expect(r.ok).toBe(true);
        expect(r.data!.cannot).toBeUndefined();
        expect(r.data!.options).toEqual([
          { id: "21", name: "Request review", label: "In Review", toStatus: "In Review", toId: "3", toKind: "open", color: "#ffab00" },
          { id: "22", name: "Back to To Do", label: "To Do", toStatus: "To Do", toId: "1", toKind: "open", color: "#42526e" },
        ]);
        expect(wire()).toEqual(["GET /issue/ORBIT-1042/transitions"]);
        expect(fake.requests[0]!.query.expand).toBe("transitions.fields");
      });

      test("a move that needs a field says which, and a finished status says it is done", async () => {
        const r = await J.movesStored("ORBIT-1044");
        expect(r.data!.options.map((o) => [o.id, o.label, o.toKind, o.needs])).toEqual([
          ["41", "Done", "done", ["resolution"]],
          ["42", "In Progress", "open", undefined],
        ]);
      });

      test("an empty list is a sentence about the person, never 'no statuses'", async () => {
        fake.state.deny.transition.push("ORBIT-1042");
        const r = await J.movesStored("ORBIT-1042");
        expect(r).toEqual({ ok: true, data: { options: [], cannot: "You cannot move ORBIT-1042" } });
      });

      test("two moves into one status are told apart by the move's name", async () => {
        addMove("2", { id: "23", name: "Skip review", toStatusId: "3" });
        const r = await J.movesStored("ORBIT-1042");
        expect(r.data!.options.map((o) => o.label)).toEqual(["In Review (Request review)", "To Do", "In Review (Skip review)"]);
      });

      test("a failed read is an error, not an empty list", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/transitions", status: 500 });
        const r = await J.movesStored("ORBIT-1042");
        expect(r.ok).toBe(false);
        expect(r.error).toBe("Could not reach Jira");
      });

      test("a bad key sends nothing; not connected sends nothing", async () => {
        expect((await J.movesStored("not a key")).ok).toBe(false);
        C.__clearAll();
        expect(await J.movesStored("ORBIT-1042")).toEqual({ ok: false, error: "Jira is not connected" });
        expect(await J.moveStored("ORBIT-1042", "21", 1)).toEqual({ ok: false, error: "Jira is not connected" });
        expect(fake.requests.length).toBe(0);
      });
    });

    describe("the move", () => {
      test("success: check, moves, move, read back; the card comes back moved", async () => {
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(true);
        expect(r.task).toMatchObject({ customId: "ORBIT-1042", status: "In Review", statusKind: "open" });
        // The status the card left, so the watch can tell the person's own move from news.
        expect(r.was).toBeTruthy();
        expect(r.was).not.toBe(r.task!.status);
        expect(r.task!.updated).toBeGreaterThan(upd("ORBIT-1042") - 1);
        // Four requests the first time (the moves of this status are not known yet).
        expect(wire()).toEqual([
          "GET /issue/ORBIT-1042",
          "GET /issue/ORBIT-1042/transitions",
          "POST /issue/ORBIT-1042/transitions",
          "GET /issue/ORBIT-1042",
        ]);
        expect(posts()[0]!.body).toEqual({ transition: { id: "21" } });
        expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("3");
      });

      test("the second card in the same status costs three: the moves are remembered", async () => {
        fake.state.issues["ORBIT-1050"]!.statusId = "2";
        expect((await move("ORBIT-1042", "21")).ok).toBe(true);
        fake.requests.length = 0;
        const r = await move("ORBIT-1050", "21");
        expect(r.ok).toBe(true);
        expect(wire()).toEqual(["GET /issue/ORBIT-1050", "POST /issue/ORBIT-1050/transitions", "GET /issue/ORBIT-1050"]);
      });

      test("the moves are remembered per status: a move of the same id elsewhere is not taken for this one", async () => {
        // Workflows reuse a move's id across statuses, with a screen of their own.
        addMove("1", { id: "22", name: "Back to To Do", toStatusId: "1", requiredFields: ["resolution"] });
        expect((await move("ORBIT-1042", "22")).ok).toBe(true);
        fake.requests.length = 0;
        const r = await move("ORBIT-1050", "22");
        expect(r.error).toBe("That move needs Resolution, which cannot be filled in here yet");
        expect(posts().length).toBe(0);
      });

      test("writes switched off: one sentence, nothing sent", async () => {
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect(await move("ORBIT-1042", "21")).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests.length).toBe(0);
      });

      test("a card that changed since it was looked at is a conflict, and nothing is written", async () => {
        const r = await move("ORBIT-1042", "21", upd("ORBIT-1042") - 5000);
        expect(r.ok).toBe(false);
        expect(r.conflict).toBe(true);
        expect(wire()).toEqual(["GET /issue/ORBIT-1042"]);
        expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
      });

      test("a card whose updated cannot be read is refused, and nothing is written", async () => {
        const at = upd("ORBIT-1042");
        fake.state.issues["ORBIT-1042"]!.updated = "not a date";
        const r = await move("ORBIT-1042", "21", at);
        expect(r.ok).toBe(false);
        expect(r.conflict).toBeUndefined();
        expect(wire()).toEqual(["GET /issue/ORBIT-1042"]);
        expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
      });

      test("no stamp to compare with is refused before anything is sent", async () => {
        for (const bad of [0, -1, Number.NaN]) {
          const r = await move("ORBIT-1042", "21", bad);
          expect(r.ok).toBe(false);
          expect(r.error).toContain("reload the card");
        }
        expect(fake.requests.length).toBe(0);
      });

      test("inputs that are not a card or a move are refused before anything is sent", async () => {
        for (const [k, id] of [["../x", "21"], ["ORBIT-1042", "21/../x"], ["ORBIT-1042", ""], ["ORBIT-1042", "abc"]] as const) {
          expect((await move(k, id, 1)).ok).toBe(false);
        }
        expect(fake.requests.length).toBe(0);
      });

      test("a move that needs a field is refused here, with no POST", async () => {
        const r = await move("ORBIT-1044", "41");
        expect(r.ok).toBe(false);
        expect(r.error).toBe("That move needs Resolution, which cannot be filled in here yet");
        expect(posts().length).toBe(0);
        expect(fake.state.issues["ORBIT-1044"]!.statusId).toBe("4");
      });

      test("a missing permission: 'You cannot move', and no POST", async () => {
        fake.state.deny.transition.push("ORBIT-1042");
        const r = await move("ORBIT-1042", "21");
        expect(r).toEqual({ ok: false, error: "You cannot move ORBIT-1042" });
        expect(posts().length).toBe(0);
      });

      test("a missing permission is not remembered for ten minutes", async () => {
        fake.state.deny.transition.push("ORBIT-1042");
        expect((await move("ORBIT-1042", "21")).ok).toBe(false);
        fake.state.deny.transition.length = 0;
        expect((await move("ORBIT-1042", "21")).ok).toBe(true);
      });

      test("a move the workflow does not offer from here: asked again once, then refused with no POST", async () => {
        const r = await move("ORBIT-1042", "31");
        expect(r.ok).toBe(false);
        expect(r.error).toBe("That move is not available any more: reload the card");
        // Once from memory (cold, so a read), once more fresh before it says no.
        expect(wire().filter((w) => w.endsWith("/transitions")).length).toBe(2);
        expect(posts().length).toBe(0);
        // Remembered now: a second wrong id re-reads once more, a right one does not.
        fake.requests.length = 0;
        expect((await move("ORBIT-1042", "21")).ok).toBe(true);
        expect(wire().filter((w) => w.endsWith("/transitions") && w.startsWith("GET")).length).toBe(0);
      });

      test("a stale remembered list does not block a move that exists now", async () => {
        expect((await move("ORBIT-1042", "21")).ok).toBe(true);
        fake.state.issues["ORBIT-1050"]!.statusId = "2";
        addMove("2", { id: "29", name: "Park", toStatusId: "1" });
        const r = await move("ORBIT-1050", "29");
        expect(r.ok).toBe(true);
        expect(r.task!.status).toBe("To Do");
      });

      test("a 409 from the POST is a conflict", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 409 });
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(false);
        expect(r.conflict).toBe(true);
        expect(posts().length).toBe(1);
      });

      test("a 400 from the POST is a sentence, never Jira's body", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 400 });
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(false);
        expect(r.conflict).toBeUndefined();
        expect(r.error).toBe("Jira did not accept that move. The card may have moved on, or you cannot move it");
        expect(JSON.stringify(r)).not.toContain("not valid");
      });

      test("a per-issue limit is a sentence and the write is not retried", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 429, retryAfter: 1, reason: "jira-per-issue-on-write" });
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(false);
        // The per-issue write limit, and its reason, are Cloud's; Data Center sends Retry-After alone.
        expect(r.error).toBe(dc ? "Jira is limiting requests, try again in 1s" : "Jira is limiting writes to ORBIT-1042, try again in 1s");
        expect(posts().length).toBe(1);
      });

      test("a refused token on the write says reconnect", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 401 });
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(false);
        expect(r.unauthorised).toBe(true);
      });

      test("a check that could not be made is neither a conflict nor a go", async () => {
        fake.fail({ path: "/issue/ORBIT-1042", method: "GET", status: 500, times: 1 });
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(false);
        expect(r.conflict).toBeUndefined();
        expect(r.error).toStartWith("Nothing was changed: could not check the card first.");
        expect(posts().length).toBe(0);
      });

      test("a move that landed but could not be read back says so", async () => {
        // The first read of the card (the check) passes; the second (the read-back) fails.
        fake.fail({ path: "/issue/ORBIT-1042", method: "GET", times: 1 });
        fake.fail({ path: "/issue/ORBIT-1042", method: "GET", status: 500, times: 1 });
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(false);
        expect(r.error).toStartWith("The card was moved, but could not be read back. Reload it.");
        expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("3");
      });

      // A read of this card held open on its way back, answering with the card as it was.
      const holdFirst = (match: (u: URL) => boolean): void => {
        let held = false;
        proxy = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(req) {
            const u = new URL(req.url);
            const headers = new Headers(req.headers);
            headers.delete("host");
            const body = req.method === "GET" ? undefined : await req.text();
            const res = await fetch(fake.base + u.pathname + u.search, { method: req.method, headers, body });
            const text = await res.text();
            if (req.method === "GET" && match(u) && !held) { held = true; await Bun.sleep(600); }
            return new Response(text, { status: res.status, headers: res.headers });
          },
        });
        J.__setJiraBase(`http://127.0.0.1:${proxy.port}`);
      };

      test("the read-back is not a read of the card that was already in the air", async () => {
        holdFirst((u) => u.pathname.endsWith("/issue/ORBIT-1042") && !!u.searchParams.get("fields")?.includes("summary"));
        const slow = J.withStored((c) => J.readIssue(c, "ORBIT-1042"));
        await Bun.sleep(100);
        const r = await move("ORBIT-1042", "21");
        expect(r.ok).toBe(true);
        expect(r.task!.status).toBe("In Review");
        expect((await slow).data!.status).toBe("In Progress");
      });

      test("the check is not a check that was already in the air", async () => {
        // One move is held on its check with the card as it was, and refused for its old stamp.
        holdFirst((u) => u.pathname.endsWith("/issue/ORBIT-1042") && u.searchParams.get("fields") === "updated,status,project,issuetype");
        const old = upd("ORBIT-1042");
        const stale = move("ORBIT-1042", "21", old - 5000);
        await Bun.sleep(100);
        // Somebody edits the card; a second person, who sees that edit, moves it.
        fake.state.issues["ORBIT-1042"]!.updated = new Date(old + 60_000).toISOString().replace("Z", "+0000");
        const r = await move("ORBIT-1042", "21", old + 60_000);
        expect(r.ok).toBe(true);
        expect((await stale).conflict).toBe(true);
      });

      if (dc) {
        test("Data Center sends the move to the v2 address", async () => {
          expect((await move("ORBIT-1042", "21")).ok).toBe(true);
          expect(fake.requests.every((r) => r.auth?.startsWith("Bearer "))).toBe(true);
        });
      }
    });
  });
}

suite("cloud");
suite("datacenter");

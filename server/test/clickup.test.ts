import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The first provider that lives on the other side of a network.
 *
 * Everything here runs against a stub on localhost, and that is not a
 * compromise — it is the only way to assert the cases that matter, which are
 * all failures: a refused token, a rate limit, a timeout, an empty answer.
 * Nobody's real workspace can produce those on demand, and a suite that needed
 * one would be a suite that does not run on a train.
 *
 * What is NOT asserted here is that ClickUp's API looks like this stub. That
 * claim comes from its documentation, and the shapes below are taken from it:
 * `/user` returns `{user}`, `/team` returns `{teams}`, task lists come back
 * under `tasks`, dates are epoch milliseconds as strings, and the token is sent
 * bare in `Authorization`.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-cu-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");

/** What the stub was asked, so a test can assert on the request as well as the
 *  answer — the header is half of what this module has to get right. */
let seen: { path: string; auth: string | null }[] = [];
let reply: (req: Request) => Response;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push({ path: u.pathname + u.search, auth: req.headers.get("authorization") });
    return reply(req);
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "99", ...(init.headers ?? {}) },
    ...init,
  });

const TASK = {
  id: "abc123", name: "Ship the redirect fix",
  url: "https://example.invalid/t/abc123",
  status: { status: "in progress", type: "custom" },
  // 2026-08-09 12:00 local, as epoch ms in a string — ClickUp's own shape.
  due_date: String(new Date(2026, 7, 9, 12, 0, 0).getTime()),
  date_updated: "1754300000000",
  priority: { priority: "high" },
  tags: [{ name: "web" }, { name: "auth" }],
  list: { name: "Sprint 14" },
  assignees: [{ username: "David" }],
};

beforeEach(() => {
  seen = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  CU.__setClickUpBase(BASE);
  reply = () => json({});
});
afterEach(() => { CU.__reset(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("the header", () => {
  it("sends the token bare, with no Bearer prefix", async () => {
    // ClickUp personal tokens are sent as-is. `Bearer pk_…` produces a 401 that
    // looks exactly like a wrong token, which is an afternoon of debugging the
    // wrong thing.
    reply = () => json({ user: { id: 7, username: "David", email: "d@example.invalid" } });
    await CU.whoAmI("pk_12345_TOKEN");
    expect(seen[0]!.auth).toBe("pk_12345_TOKEN");
    expect(seen[0]!.auth).not.toContain("Bearer");
  });
});

describe("who the token belongs to", () => {
  it("reports the account when ClickUp accepts it", async () => {
    reply = () => json({ user: { id: 7, username: "David", email: "d@example.invalid" } });
    const r = await CU.whoAmI("pk_1_X");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ id: "7", name: "David", email: "d@example.invalid" });
  });

  it("falls back to the email when there is no username", async () => {
    reply = () => json({ user: { id: 7, username: "", email: "d@example.invalid" } });
    expect((await CU.whoAmI("pk_1_X")).data!.name).toBe("d@example.invalid");
  });

  it("calls a refused token refused, and says so as the one recoverable error", async () => {
    // The distinction the panel acts on: `unauthorised` means "reconnect",
    // everything else means "try later".
    reply = () => json({ err: "Token invalid" }, { status: 401 });
    const r = await CU.whoAmI("pk_bad");
    expect(r.ok).toBe(false);
    expect(r.unauthorised).toBe(true);
    expect(r.error).not.toContain("Token invalid"); // never the raw body
  });

  it("does not mistake a rate limit for a bad token", async () => {
    reply = () => json({}, { status: 429 });
    const r = await CU.whoAmI("pk_1_X");
    expect(r.throttled).toBe(true);
    expect(r.unauthorised).toBeUndefined();
  });

  it("survives a 200 with nothing in it", async () => {
    reply = () => json({});
    expect((await CU.whoAmI("pk_1_X")).ok).toBe(false);
  });
});

describe("reading tasks", () => {
  it("asks only for what is assigned to you and still open", async () => {
    reply = () => json({ tasks: [TASK] });
    await CU.fetchTasks("pk_1_X", "9001", "7");
    const q = seen[0]!.path;
    expect(q).toContain("/team/9001/task");
    expect(q).toContain("assignees%5B%5D=7");
    expect(q).toContain("include_closed=false");
  });

  it("does not ask for subtasks, which doubled the time and returned nothing", async () => {
    // Measured on a real workspace: 25.0s with `subtasks=true` against 12.5s
    // without, for the same thirteen rows. Asserted so that a future tidy-up
    // cannot put it back on the grounds that it looks more complete.
    reply = () => json({ tasks: [TASK] });
    await CU.fetchTasks("pk_1_X", "9001", "7");
    expect(seen[0]!.path).not.toContain("subtasks");
  });

  it("maps a task into the shape the panel reads", async () => {
    reply = () => json({ tasks: [TASK] });
    const r = await CU.fetchTasks("pk_1_X", "9001", "7");
    const t = r.data!.tasks[0]!;
    expect(t.id).toBe("abc123");
    expect(t.title).toBe("Ship the redirect fix");
    expect(t.status).toBe("in progress");
    expect(t.priority).toBe("high");
    expect(t.tags).toEqual(["web", "auth"]);
    expect(t.list).toBe("Sprint 14");
    expect(t.assignees).toEqual(["David"]);
    expect(t.url).toContain("abc123");
  });

  it("converts the due date to the local day, not UTC's", async () => {
    // A task due at 00:30 in Madrid is due today to the person reading it and
    // yesterday to `toISOString`. The list groups by this string.
    reply = () => json({ tasks: [TASK] });
    const t = (await CU.fetchTasks("pk_1_X", "9001", "7")).data!.tasks[0]!;
    expect(t.due).toBe("2026-08-09");
  });

  it("treats a missing or zero due date as no date", async () => {
    reply = () => json({ tasks: [
      { ...TASK, id: "a", due_date: null },
      { ...TASK, id: "b", due_date: "" },
      { ...TASK, id: "c", due_date: "0" },
      { ...TASK, id: "d", due_date: undefined },
    ] });
    for (const t of (await CU.fetchTasks("pk_1_X", "9001", "7")).data!.tasks) {
      expect(t.due, t.id).toBe(null);
    }
  });

  it("classifies by the provider's status TYPE, never by its name", async () => {
    // Status names are per-list; a workspace may have four words for "doing".
    reply = () => json({ tasks: [
      { ...TASK, id: "a", status: { status: "Ready for QA", type: "custom" } },
      { ...TASK, id: "b", status: { status: "anything at all", type: "done" } },
      { ...TASK, id: "c", status: { status: "whatever", type: "closed" } },
      { ...TASK, id: "d", status: { status: "to do", type: "open" } },
    ] });
    const kinds = (await CU.fetchTasks("pk_1_X", "9001", "7")).data!.tasks.map((t) => t.statusKind);
    expect(kinds).toEqual(["other", "done", "done", "open"]);
  });

  it("drops a priority it does not recognise rather than passing it through", async () => {
    reply = () => json({ tasks: [{ ...TASK, priority: { priority: "catastrophic" } }, { ...TASK, id: "z", priority: null }] });
    const got = (await CU.fetchTasks("pk_1_X", "9001", "7")).data!.tasks.map((t) => t.priority);
    expect(got).toEqual([null, null]);
  });

  it("says when there is another page rather than truncating quietly", async () => {
    // A list that stops at 100 with no note reads as "that is all of them".
    reply = () => json({ tasks: Array.from({ length: 100 }, (_, i) => ({ ...TASK, id: `t${i}` })) });
    expect((await CU.fetchTasks("pk_1_X", "9001", "7")).data!.more).toBe(true);
    reply = () => json({ tasks: [TASK] });
    expect((await CU.fetchTasks("pk_1_X", "9001", "7")).data!.more).toBe(false);
  });
});

describe("the rate limit", () => {
  it("holds off before the wall instead of walking into a 429", async () => {
    reply = () => json({ user: { id: 7, username: "David", email: "e" } }, {
      headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) },
    });
    await CU.whoAmI("pk_1_X");
    expect(CU.rateBudget()!.remaining).toBe(1);

    const before = seen.length;
    const r = await CU.whoAmI("pk_1_X");
    expect(r.throttled).toBe(true);
    // The point: no request was made at all.
    expect(seen.length).toBe(before);
  });

  it("reads the reset header as seconds, not milliseconds", async () => {
    // Treating unix seconds as milliseconds puts the reset in 1970, so the
    // guard is always "already past" and never guards anything.
    const resetAtS = Math.floor(Date.now() / 1000) + 42;
    reply = () => json({ user: { id: 7, username: "d", email: "e" } }, {
      headers: { "x-ratelimit-remaining": "50", "x-ratelimit-reset": String(resetAtS) },
    });
    await CU.whoAmI("pk_1_X");
    expect(CU.rateBudget()!.resetAt).toBe(resetAtS * 1000);
    expect(CU.rateBudget()!.resetAt).toBeGreaterThan(Date.now());
  });
});

describe("the cached list the panel reads", () => {
  it("says so rather than pretending an empty list when nothing is connected", async () => {
    const snap = await CU.clickupTasks(true);
    expect(snap.error).toContain("not connected");
    expect(snap.tasks).toEqual([]);
  });

  it("keeps the last good list when a later poll fails", async () => {
    // The reason this matters: an empty list is read as "nothing to do" and
    // acted on. A network blip must not produce one.
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9001" });
    reply = () => json({ tasks: [TASK] });
    expect((await CU.clickupTasks(true)).tasks.length).toBe(1);

    reply = () => new Response("nope", { status: 500 });
    const after = await CU.clickupTasks(true);
    expect(after.error).toBeTruthy();
    expect(after.tasks.length, "the list was emptied by a failed poll").toBe(1);
  });

  it("marks a refused token so the panel can say reconnect", async () => {
    C.setCredential("clickup", { token: "pk_bad", accountId: "7", workspaceId: "9001" });
    reply = () => json({}, { status: 401 });
    expect((await CU.clickupTasks(true)).unauthorised).toBe(true);
  });

  it("serves the cache rather than asking again within the minute", async () => {
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9001" });
    reply = () => json({ tasks: [TASK] });
    await CU.clickupTasks(true);
    const calls = seen.length;
    await CU.clickupTasks();
    await CU.clickupTasks();
    expect(seen.length, "the cache was bypassed").toBe(calls);
  });

  it("works out the workspace once and remembers it on the credential", async () => {
    C.setCredential("clickup", { token: "pk_1_X" });
    reply = (req) => {
      const p = new URL(req.url).pathname;
      if (p.endsWith("/user")) return json({ user: { id: 7, username: "David", email: "e" } });
      if (p.endsWith("/team")) return json({ teams: [{ id: "9001", name: "Producto" }] });
      return json({ tasks: [TASK] });
    };
    await CU.clickupTasks(true);
    const stored = C.redacted("clickup")!;
    expect(stored.workspaceId).toBe("9001");
    expect(stored.workspace).toBe("Producto");
    expect(stored.accountId).toBe("7");

    // …and the next poll does not ask again.
    seen = [];
    await CU.clickupTasks(true);
    expect(seen.some((s) => s.path.includes("/team/9001/task"))).toBe(true);
    expect(seen.some((s) => s.path.endsWith("/user"))).toBe(false);
  });
});

describe("what may be printed", () => {
  it("never puts the token in an error a person could see", async () => {
    C.setCredential("clickup", { token: "pk_12345_SECRETVALUE", accountId: "7", workspaceId: "9001" });
    reply = () => json({ err: "bad token pk_12345_SECRETVALUE" }, { status: 401 });
    const snap = await CU.clickupTasks(true);
    expect(JSON.stringify(snap)).not.toContain("SECRETVALUE");
    expect(CU.tokenLabel()).not.toContain("SECRETVALUE");
  });
});

describe("connecting, when the tab has already been looked at", () => {
  it("does not report the cached failure back at you", async () => {
    /*
     * The bug this exists for, and it looked like a broken token.
     *
     * The button that opens Integrations lives on the ClickUp tab, so by the
     * time anybody pastes a token the tab has already polled and cached a
     * snapshot saying "ClickUp is not connected". Connecting then succeeded and
     * the card immediately reported that cached failure — "not connected · last
     * known as David" — where the name could only have come from the credential
     * that had just been written a moment earlier.
     */
    const P = await import("../src/providers.ts");

    // 1. The tab polls while nothing is connected. This caches the failure.
    const before = await CU.clickupTasks(true);
    expect(before.error).toContain("not connected");

    // 2. A good token goes in.
    reply = (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/user")) return json({ user: { id: 7, username: "David", email: "e" } });
      if (path.endsWith("/team")) return json({ teams: [{ id: "9001", name: "Producto" }] });
      return json({ tasks: [TASK] });
    };
    const r = await P.connectProvider("clickup", "pk_1_GOOD");

    expect(r.ok, r.error).toBe(true);
    expect(r.status!.state, "connect reported the cached failure").toBe("connected");
    expect(r.status!.detail).toContain("David");
    expect(r.status!.detail).not.toContain("not connected");
  });
});

describe("the address you paste", () => {
  const { parseViewUrl } = CU;

  it("reads a view address, and the list hiding inside its id", () => {
    // The middle segment of a view id is the LIST id — verified against a real
    // board: the whole hyphenated string resolves as a view, the number alone
    // 404s as a view and 200s as a list. That list is what knows the statuses,
    // so pulling it out of the address saves a call and makes the status picker
    // possible at all.
    const p = parseViewUrl("https://example.clickup.com/9000001/v/l/6-901715483311-1")!;
    expect(p.kind).toBe("view");
    expect(p.viewId).toBe("6-901715483311-1");
    expect(p.listId).toBe("901715483311");
    expect(p.workspaceId).toBe("9000001");
  });

  it("reads a bare list address", () => {
    const p = parseViewUrl("https://example.clickup.com/9000001/v/li/901715483311")!;
    expect(p.kind).toBe("list");
    expect(p.listId).toBe("901715483311");
  });

  it("takes the other view kinds, which are views too", () => {
    for (const kind of ["b", "gantt", "cal", "tb", "em"]) {
      const p = parseViewUrl(`https://example.clickup.com/9000001/v/${kind}/7-123456789012-2`);
      expect(p?.kind, kind).toBe("view");
      expect(p?.viewId, kind).toBe("7-123456789012-2");
    }
  });

  it("accepts a pasted id on its own", () => {
    expect(parseViewUrl("6-901715483311-1")?.viewId).toBe("6-901715483311-1");
  });

  it("refuses an address from somewhere else entirely", () => {
    // Somebody pasting a Jira link should be told, not silently handed a
    // request built from whatever numbers were in it.
    expect(parseViewUrl("https://example.invalid/9000001/v/l/6-1-1")).toBe(null);
    expect(parseViewUrl("https://notclickup.example/1/v/l/6-1-1")).toBe(null);
  });

  it("refuses a host that merely ends in the domain", () => {
    // `endsWith("clickup.com")` alone accepts these: they are somebody else's
    // registrable domains, not a ClickUp subdomain.
    for (const host of ["notclickup.com", "evilclickup.com", "clickup.com.example.net"]) {
      expect(parseViewUrl(`https://${host}/9000001/v/l/6-901715483311-1`), host).toBe(null);
    }
    // The apex and a real subdomain still read.
    expect(parseViewUrl("https://clickup.com/9000001/v/l/6-901715483311-1")?.kind).toBe("view");
    expect(parseViewUrl("https://app.clickup.com/9000001/v/l/6-901715483311-1")?.kind).toBe("view");
  });

  it("refuses nothing, and rubbish", () => {
    for (const bad of ["", "   ", "hello", "https://example.clickup.com/", "https://example.clickup.com/9000001"]) {
      expect(parseViewUrl(bad), JSON.stringify(bad)).toBe(null);
    }
  });

  it("does not mistake a short middle segment for a list id", () => {
    // `6-42-1` has a middle segment, but no list id is two digits. Guessing one
    // would produce a status picker offering another board's statuses.
    expect(parseViewUrl("https://example.clickup.com/9000001/v/l/6-42-1")?.listId).toBeUndefined();
  });
});

describe("what the status TYPE decides", () => {
  it("counts a board's done-but-open statuses as done", () => {
    /*
     * Measured on a real board with seventeen statuses: the working ones are
     * all `custom`, while "ready for deployment", "in staging", "in
     * production", "released" and "won't fix / obsolete" are `done` — and only
     * "completed" is `closed`. That is why `include_closed=false` left half the
     * list looking finished, and why the panel hides by TYPE rather than by
     * name.
     */
    const mk = (status: string, type: string) => CU.toTask({ id: "x", name: "n", status: { status, type } });
    expect(mk("in development", "custom").statusKind).toBe("other");
    expect(mk("blocked", "custom").statusKind).toBe("other");
    expect(mk("in production", "done").statusKind).toBe("done");
    expect(mk("won't fix / obsolete", "done").statusKind).toBe("done");
    expect(mk("completed", "closed").statusKind).toBe("done");
    expect(mk("to do", "open").statusKind).toBe("open");
  });

  it("knows which cards are yours without the browser knowing your id", () => {
    const raw = { id: "x", name: "n", assignees: [{ id: 95, username: "you" }, { id: 12, username: "someone" }] };
    expect(CU.toTask(raw, "95").mine).toBe(true);
    expect(CU.toTask(raw, "12").mine).toBe(true);
    expect(CU.toTask(raw, "99").mine).toBe(false);
    expect(CU.toTask(raw).mine).toBeUndefined();
  });

  it("resolves a drop-down to the word on the board, not its index", () => {
    // ClickUp answers with the option's orderindex. Printing `value` gives "3"
    // where the board says the name.
    const t = CU.toTask({
      id: "x", name: "n",
      custom_fields: [{
        id: "f1", name: "Squad", type: "drop_down", value: 2,
        type_config: { options: [
          { id: "a", name: "Orange", orderindex: 0 },
          { id: "b", name: "Purple", orderindex: 1 },
          { id: "c", name: "Blue", orderindex: 2 },
        ] },
      }],
    });
    expect(t.custom).toEqual([{ id: "f1", name: "Squad", value: "Blue" }]);
  });

  it("leaves an unset custom field out entirely", () => {
    const t = CU.toTask({ id: "x", name: "n", custom_fields: [{ id: "f", name: "Squad", type: "drop_down" }] });
    expect(t.custom).toEqual([]);
  });
});

describe("writing to somebody's company board", () => {
  it("is off unless it has been switched on", () => {
    // The local list ships with writes ON and a switch to disable them, which
    // is right for a store that is yours. This is the opposite case, so the
    // default is the opposite too.
    expect(CU.CLICKUP_WRITE_ENABLED).toBe(process.env.AGENTGLASS_CLICKUP_WRITE === "1");
  });

  it.skipIf(process.env.AGENTGLASS_CLICKUP_WRITE === "1")("refuses every write while it is off", async () => {
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7" });
    for (const [what, go] of [
      ["assign", () => CU.assignSelf("abc", true)],
      ["status", () => CU.setStatus("abc", "in development")],
      ["field", () => CU.setField("abc", "f1", "opt")],
    ] as const) {
      const r = await go();
      expect(r.ok, what).toBe(false);
      expect(r.error, what).toContain("switched off");
    }
    // And nothing was sent.
    expect(seen.length).toBe(0);
  });
});

describe("finding a card by the number you remember", () => {
  const { normaliseCardQuery } = CU;

  it("completes a bare number from the shape this workspace uses", () => {
    // The prefix is derived from cards already read, so typing the number is
    // enough and nobody has to be asked what their ids look like.
    expect(normaliseCardQuery("20542", "ABC-")).toBe("ABC-20542");
    expect(normaliseCardQuery("  20542 ", "ABC-")).toBe("ABC-20542");
  });

  it("takes a whole id as typed, in any case", () => {
    expect(normaliseCardQuery("ABC-20542", "ABC-")).toBe("ABC-20542");
    expect(normaliseCardQuery("abc-20542", "")).toBe("ABC-20542");
  });

  it("takes an internal id too", () => {
    expect(normaliseCardQuery("86e2gw40g", "ABC-")).toBe("86e2gw40g");
  });

  it("refuses a bare number when it has never seen this workspace's ids", () => {
    // Guessing a prefix would produce a 404 reading as "no such card", when the
    // truth is "I do not know your naming yet".
    expect(normaliseCardQuery("20542", "")).toBe(null);
  });

  it("refuses what is plainly not an id", () => {
    for (const bad of ["", "   ", "the login bug", "12", "https://example.invalid/x"]) {
      expect(normaliseCardQuery(bad, "ABC-"), JSON.stringify(bad)).toBe(null);
    }
  });
});

describe("the pull requests a card produced", () => {
  const { prNumberFromUrl } = CU;

  it("reads a number out of a pull-request link", () => {
    expect(prNumberFromUrl("https://github.com/acme/widgets/pull/17304")).toBe(17304);
    expect(prNumberFromUrl("https://github.com/acme/widgets/pull/17304/files")).toBe(17304);
  });

  it("refuses anything that is not one", () => {
    // A bare number in that field would be ambiguous — issue or pull request —
    // so the link has to say `/pull/`.
    for (const bad of ["", "17304", "https://github.com/acme/widgets/issues/17304",
      "https://github.com/acme/widgets", "https://example.invalid/x/y/pull/1"]) {
      expect(prNumberFromUrl(bad), JSON.stringify(bad)).toBe(null);
    }
  });
});

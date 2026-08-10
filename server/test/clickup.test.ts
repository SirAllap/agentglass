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
// The write switch lives in clickup-views.json, and without this line that is
// the DEVELOPER'S OWN — so the suite's answer to "are writes allowed?" depended
// on a file outside the repository, and a test asserting that a write is
// refused would pass or fail according to a toggle somebody flipped in the app.
// The seam already existed; this test simply was not using it.
const CV = await import("../src/clickupviews.ts");

/** What the stub was asked, so a test can assert on the request as well as the
 *  answer — the header is half of what this module has to get right. */
let seen: { path: string; auth: string | null }[] = [];
// A handler may need to read the request body, which is async.
let reply: (req: Request) => Response | Promise<Response>;

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
  CV.__setViewsPath(join(dir, "clickup-views.json"));
  reply = () => json({});
});
afterEach(() => { CU.__reset(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  CV.__setViewsPath(null);
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

  it("recognises the My Work page instead of refusing it", () => {
    // The address of "assigned to me" names no view and no list — it is a
    // question, not a place — so the resolver used to call it rubbish. It is
    // also the single likeliest thing anybody pastes.
    const p = parseViewUrl("https://example.clickup.com/9000001/my-work/tasks")!;
    expect(p.kind).toBe("assigned");
    expect(p.workspaceId).toBe("9000001");
    expect(p.viewId).toBeUndefined();
    expect(p.listId).toBeUndefined();
    // The bare page, and the other tabs on it, are the same answer.
    expect(parseViewUrl("https://example.clickup.com/9000001/my-work")?.kind).toBe("assigned");
    expect(parseViewUrl("https://example.clickup.com/9000001/my-work/reminders")?.kind).toBe("assigned");
  });

  it("does not read somebody else's my-work path as ours", () => {
    expect(parseViewUrl("https://example.invalid/9000001/my-work/tasks")).toBe(null);
  });
});

describe("everything assigned to you, which has no view to ask", () => {
  it("follows its pages and says so when it stops early", async () => {
    // Three pages, not the ten a view gets: this query takes about twelve
    // seconds a page against a real workspace, so ten would be two minutes of
    // spinner. Past three the answer is honest about being short.
    const full = Array.from({ length: 100 }, (_, i) => ({ ...TASK, id: `t${i}` }));
    reply = () => json({ tasks: full });
    const r = await CU.assignedTasks("pk_1_X", "9001", "7");
    expect(r.ok).toBe(true);
    expect(r.data!.truncated).toBe(true);
    expect(r.data!.tasks.length).toBe(300);
    expect(seen.length).toBe(3);
  });

  it("stops at the first short page", async () => {
    reply = () => json({ tasks: [TASK] });
    const r = await CU.assignedTasks("pk_1_X", "9001", "7");
    expect(r.data!.truncated).toBe(false);
    expect(r.data!.tasks.length).toBe(1);
    expect(seen.length).toBe(1);
  });

  it("keeps what arrived when a later page fails", async () => {
    // Half an answer beats none: the panel would otherwise blank a list that
    // was almost entirely read.
    let n = 0;
    reply = () => (n++ === 0
      ? json({ tasks: Array.from({ length: 100 }, (_, i) => ({ ...TASK, id: `t${i}` })) })
      : json({ err: "nope" }, { status: 500 }));
    const r = await CU.assignedTasks("pk_1_X", "9001", "7");
    expect(r.ok).toBe(true);
    expect(r.data!.tasks.length).toBe(100);
    expect(r.data!.truncated).toBe(true);
  });

  it("reports nothing at all as a failure, not as an empty list", async () => {
    reply = () => json({ err: "nope" }, { status: 500 });
    const r = await CU.assignedTasks("pk_1_X", "9001", "7");
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
  });

  it("brings back the statuses its own rows are in, finished ones last", async () => {
    /*
     * There is no single list to ask, so the statuses come from the rows. Order
     * is `orderindex` — every board numbers its own workflow left to right, so
     * across lists it is a good hint — with the done ones sorted to the end
     * regardless, because five kinds of done interleaved with the work is worse
     * than no order at all.
     */
    reply = () => json({ tasks: [
      { ...TASK, id: "a", status: { status: "in production", type: "done", orderindex: 9, color: "#0a0" } },
      { ...TASK, id: "b", status: { status: "blocked", type: "custom", orderindex: 3 } },
      { ...TASK, id: "c", status: { status: "to do", type: "open", orderindex: 0 } },
      { ...TASK, id: "d", status: { status: "blocked", type: "custom", orderindex: 3 } },
    ] });
    const s = (await CU.assignedTasks("pk_1_X", "9001", "7")).data!.statuses;
    expect(s.map((x) => x.status)).toEqual(["to do", "blocked", "in production"]);
    expect(s[2]!.color).toBe("#0a0");
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

  it("carries the option's own colour, so the board can be read by colour", () => {
    // The colour is the point of a field like a squad — ClickUp paints those
    // cells — and it lives on the OPTION, next to the name.
    const t = CU.toTask({
      id: "x", name: "n",
      custom_fields: [{
        id: "f1", name: "Squad", type: "drop_down", value: 1,
        type_config: { options: [
          { id: "a", name: "Purple", orderindex: 0, color: "#c034eb" },
          { id: "b", name: "Blue", orderindex: 1, color: "#2ea1e5" },
        ] },
      }],
    });
    expect(t.custom).toEqual([{ id: "f1", name: "Squad", value: "Blue", color: "#2ea1e5" }]);
  });

  it("says nothing about colour for an option nobody coloured", () => {
    // Not `color: undefined` — a grey dot in a colour column reads as a value
    // pretending to be a category, so the key is absent and the caller can tell.
    const t = CU.toTask({
      id: "x", name: "n",
      custom_fields: [{
        id: "f1", name: "Squad", type: "drop_down", value: 0,
        type_config: { options: [{ id: "a", name: "Blue", orderindex: 0 }] },
      }],
    });
    expect(t.custom?.[0]).not.toHaveProperty("color");
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
      ["assign somebody else", () => CU.setAssignee("abc", 9, true)],
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

describe("putting somebody else on a card", () => {
  // Writes are allowed here because the file they are read from is this test's
  // own — see __setViewsPath above.
  const allow = () => { C.setCredential("clickup", { token: "pk_1_X", accountId: "7" }); CV.setWritesAllowed(true); };

  it("adds and removes rather than replacing", async () => {
    // A ClickUp card holds SEVERAL assignees. Sending the whole list would
    // quietly take off whoever else was on it — which is somebody discovering
    // by accident that they are no longer on their own card.
    allow();
    let body: any = null;
    reply = async (req) => { body = await req.json(); return json(TASK); };
    await CU.setAssignee("abc", 9, true);
    expect(body).toEqual({ assignees: { add: [9] } });
    await CU.setAssignee("abc", 9, false);
    expect(body).toEqual({ assignees: { rem: [9] } });
  });

  it("refuses something that is not a person", async () => {
    // The id crosses the wire as JSON from the browser; a NaN here would send
    // `{"add":[null]}` and let ClickUp decide what that means.
    allow();
    const r = await CU.setAssignee("abc", Number("nobody"), true);
    expect(r.ok).toBe(false);
    expect(seen.length).toBe(0);
  });

  it("will not overwrite a card somebody else moved first", async () => {
    // Same precondition the status write has: `updated` is checked before the
    // write, so two people on one card is a conflict rather than a race.
    allow();
    reply = () => json({ ...TASK, date_updated: "1754399999999" });
    const r = await CU.setAssignee("abc", 9, true, 1754300000000);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
  });
});

describe("who can be put on a card", () => {
  it("asks the LIST, not the workspace", async () => {
    // A workspace here holds the whole company. A picker offering all of them
    // to assign one backend card is a picker nobody uses twice.
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7" });
    reply = () => json({ members: [{ id: 9, username: "Ana", initials: "AN", color: "#f0f" }] });
    const r = await CU.listMembers("L1");
    expect(r.ok).toBe(true);
    expect(seen[0]!.path).toBe("/list/L1/member");
    expect(r.data!.members[0]).toMatchObject({ id: 9, name: "Ana", initials: "AN", color: "#f0f" });
  });

  it("puts you first, then everybody else by name", async () => {
    // The commonest assignment on any board is your own, and a list that makes
    // you hunt for yourself is a list that gets used once.
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7" });
    reply = () => json({ members: [
      { id: 3, username: "Zoe" }, { id: 7, username: "You" }, { id: 5, username: "Ana" },
    ] });
    const r = await CU.listMembers("L1");
    expect(r.data!.members.map((m) => m.name)).toEqual(["You", "Ana", "Zoe"]);
    expect(r.data!.members[0]!.me).toBe(true);
  });

  it("adds YOU when the list does not name you", async () => {
    // Measured on a real board: a nineteen-member list came back without the
    // connected account in it. List membership is not the same question as
    // "who can be assigned here", and without this the picker loses the one
    // thing the control it replaced could actually do.
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7" });
    reply = (req) => new URL(req.url).pathname === "/user"
      ? json({ user: { id: 7, username: "You", email: "you@example.invalid" } })
      : json({ members: [{ id: 9, username: "Ana" }] });
    const r = await CU.listMembers("L1");
    expect(r.data!.members.map((m) => m.name)).toEqual(["You", "Ana"]);
    expect(r.data!.members[0]).toMatchObject({ id: 7, me: true });
  });

  it("does not ask who you are when the list already said", async () => {
    // One call, not two, on the ordinary path.
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7" });
    reply = () => json({ members: [{ id: 7, username: "You" }] });
    await CU.listMembers("L1");
    expect(seen.map((x) => x.path)).toEqual(["/list/L1/member"]);
  });

  it("drops a member with no name to show", async () => {
    C.setCredential("clickup", { token: "pk_1_X", accountId: "7" });
    reply = () => json({ members: [{ id: 9 }, { id: 10, username: "Ana" }] });
    const r = await CU.listMembers("L1");
    expect(r.data!.members.map((m) => m.id)).toEqual([10]);
  });

  it("says so rather than guessing when ClickUp is not connected", async () => {
    const r = await CU.listMembers("L1");
    expect(r.ok).toBe(false);
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

describe("which of a card's lists is the sprint", () => {
  const { sprintOf, looksLikeSprint } = CU;

  it("picks the sprint however the lists happen to be ordered", () => {
    /*
     * The bug this replaces, in one assertion. A card in a sprint is in two or
     * three lists at once and they arrive as one flat array whose order is not
     * stable — measured on a real workspace, the SAME card answers these two
     * orders from two endpoints. Taking "the first that is not the primary
     * list" therefore picked a different answer depending on who asked, and a
     * column headed SPRINT spent its life saying "Miscellaneous".
     */
    const a = sprintOf([{ name: "Miscellaneous" }, { name: "Sprint 138 (26/8/5 - 26/8/11)" }], "Bugs");
    const b = sprintOf([{ name: "Sprint 138 (26/8/5 - 26/8/11)" }, { name: "Miscellaneous" }], "Bugs");
    expect(a).toBe("Sprint 138");
    expect(b).toBe(a);
  });

  it("takes a sprint with no dates on it", () => {
    // Real, from the same workspace: requiring the date range would have
    // dropped this one and shown nothing where there is a sprint.
    expect(sprintOf([{ name: "Sprint 118" }], "Grasshopper V1")).toBe("Sprint 118");
  });

  it("finds it when the card's own list IS the sprint", () => {
    expect(sprintOf([], "Sprint 140 (26/8/12 - 26/8/18)")).toBe("Sprint 140");
  });

  it("says nothing rather than naming a list that is not a sprint", () => {
    // The heading says Sprint. A list name under it is not a near miss, it is a
    // different fact — and guessing is what sent somebody to ClickUp to find
    // out which sprint a card was really in.
    expect(sprintOf([{ name: "Bugs" }, { name: "Miscellaneous" }], "Bugs")).toBe(null);
    expect(sprintOf([], "Backlog")).toBe(null);
    expect(sprintOf(undefined, null)).toBe(null);
  });

  it("recognises a workspace that names its sprints something else, if it dates them", () => {
    // ClickUp appends the range itself, so the range is the portable half of
    // the signature — a workspace calling them Iterations still gets a column.
    expect(looksLikeSprint("Iteration 4 (1/1/26 - 1/7/26)")).toBe(true);
    expect(looksLikeSprint("Projects Purple")).toBe(false);
  });
});

describe("an address somebody assembled by hand", () => {
  const { parseViewUrl } = CU;

  it("finds the id even with two kind tokens in front of it", () => {
    // Reported from a real paste: an `l` AND an `li`, which is what you get
    // stitching an address out of two of ClickUp's own forms. The old parser
    // took `li` as the id and the panel said "ClickUp answered 404" about an
    // address whose real id was one segment further along.
    const p = parseViewUrl("https://example.clickup.com/9000001/v/l/li/901715834894")!;
    expect(p.kind).toBe("list");
    expect(p.listId).toBe("901715834894");
  });

  it("lands the same place however the same list is written", () => {
    const forms = [
      "https://example.clickup.com/9000001/v/li/901715834894",
      "https://example.clickup.com/9000001/v/l/li/901715834894",
    ].map((u) => parseViewUrl(u)?.listId);
    expect(new Set(forms).size).toBe(1);
    expect(forms[0]).toBe("901715834894");
  });

  it("still refuses an address with no id in it at all", () => {
    for (const bad of [
      "https://example.clickup.com/9000001/v/l/",
      "https://example.clickup.com/9000001/v/l/li",
      "https://example.clickup.com/9000001/v/",
    ]) expect(parseViewUrl(bad), bad).toBe(null);
  });
});

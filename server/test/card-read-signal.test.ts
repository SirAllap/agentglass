/*
 * A CARD READ FOR A BRIEF ASKS FOR THE CARD, AND ONLY THE CARD.
 *
 * The start reads a card on the worker's behalf and gives up at one deadline
 * that covers the whole read. A read that fans out past that deadline leaves
 * requests in the air — and a 429 on one of them used to answer every optional
 * Jira read in the app from the hold, and to park ClickUp's budget, for a card
 * read nobody was waiting on any more.
 *
 * These drive `readCard`, the function the start calls, against a stand-in
 * site, so what is asserted is the requests the app really sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-card-signal-"));
const credFile = join(dir, "credentials.json");

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const CU = await import("../src/clickup.ts");
const B = await import("../src/cardbrief.ts");

const jiraCreds = () => C.setCredential("jira", { token: FAKE_TOKEN, email: FAKE_EMAIL, site: "acme.atlassian.net", auth: "basic" });
const clickupCreds = () => C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9" });

/** One ClickUp card, in the shape the client reads. */
const card = {
  id: "9zzz0abc1", custom_id: "ORBIT-1042", name: "Retry webhooks", url: "https://app.clickup.com/t/9zzz0abc1",
  status: { status: "in progress", type: "custom" }, date_updated: "1754300000000",
  list: { name: "Orbit" }, assignees: [], tags: [], markdown_description: "Webhooks drop on a 500.",
};

const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });

let seen: string[] = [];
/** A workspace that counts what is asked, and can answer a 429 for a whole test. */
let limited = false;
/** A reply thread that never answers, for the read that must not wait on one. */
let hang = false;
const replies = new Set<string>();
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    seen.push(path);
    if (path.endsWith("/reply")) {
      replies.add(path);
      if (hang) await new Promise<void>(() => {});
      return ok({ comments: [{ id: "r1", comment_text: "on it", date: "1754300000000", user: { id: 1, username: "ann" } }] });
    }
    if (limited) {
      return new Response("{}", {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
        },
      });
    }
    if (path === `/task/${card.id}`) return ok(card);
    if (path === `/task/${card.id}/time_in_status`) return ok({});
    if (path === `/task/${card.id}/comment`) {
      return ok({ comments: [{ id: "c1", reply_count: 1, comment_text: "looks good", date: "1754300000000", user: { id: 1, username: "ann" } }] });
    }
    return ok({});
  },
});

beforeEach(() => {
  seen = [];
  replies.clear();
  limited = false;
  hang = false;
  C.__setCredentialsPath(credFile);
  C.__clearAll();
  J.__setJiraBase(null);
  J.__setJiraGuard(null);
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
});
afterEach(() => {
  J.__setJiraBase(null);
  J.__setJiraGuard(null);
  CU.__setClickUpBase(null);
});
afterAll(() => {
  server.stop(true);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("a brief's Jira read", () => {
  let fake: FakeJira;
  beforeAll(() => { fake = startFakeJira({ flavor: "cloud" }); });
  afterAll(async () => { await fake.stop(); });
  beforeEach(() => {
    fake.reset();
    J.__setJiraBase(fake.base);
    jiraCreds();
  });

  test("asks the card and nothing else, so a 429 where the pane's reads would go never sets the hold", async () => {
    // A pane's read of this card would ask these two and be answered from the hold.
    fake.fail({ path: "/field", status: 429, retryAfter: 11 });
    fake.fail({ path: "/priority/search", status: 429, retryAfter: 11 });
    const ctl = new AbortController();
    const r = await B.readCard({ tracker: "jira", id: "ORBIT-1042" }, ctl.signal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.title).toBeTruthy();
    expect(J.rateNote().holdUntil).toBe(0);
    expect(fake.requests.map((q) => q.path)).toEqual(["/issue/ORBIT-1042"]);
  });

  test("the person's own read of the same card still asks for the fields and the priorities", async () => {
    const r = await B.readCard({ tracker: "jira", id: "ORBIT-1042" });
    expect(r.ok).toBe(true);
    const paths = fake.requests.map((q) => q.path);
    expect(paths).toContain("/issue/ORBIT-1042");
    expect(paths).toContain("/field");
    expect(paths).toContain("/priority/search");
  });
});

describe("a brief's ClickUp read", () => {
  beforeEach(() => { clickupCreds(); });

  test("asks for the card and never for its conversation, and does not wait on a reply that never answers", async () => {
    hang = true;
    const ctl = new AbortController();
    const read = B.readCard({ tracker: "clickup", id: card.id }, ctl.signal);
    read.catch(() => { /* the race below may leave it */ });
    const out = await Promise.race([read, Bun.sleep(800).then(() => "timeout" as const)]);
    expect(out).not.toBe("timeout");
    if (out === "timeout") return;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.card.title).toBe("Retry webhooks");
    expect(out.card.description).toBe("Webhooks drop on a 500.");
    expect(seen.filter((p) => p.includes("/comment"))).toEqual([]);
    expect(replies.size).toBe(0);
  });

  test("a 429 on a read the start abandoned does not narrow the budget the person's own reads are answered from", async () => {
    limited = true;
    const ctl = new AbortController();
    const abandoned = await CU.taskDetail(card.id, { signal: ctl.signal });
    expect(abandoned.ok).toBe(false);
    limited = false;
    const mine = await CU.taskDetail(card.id);
    expect(mine.ok, mine.ok ? "" : String(mine.error)).toBe(true);
  });
});

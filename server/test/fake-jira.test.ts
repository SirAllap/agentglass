import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { FAKE_AUTH, FAKE_DC_BASIC, FAKE_EMAIL, FAKE_PAT_AUTH, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

/*
 * The fake is the thing every later tracker test leans on, so it is tested like
 * product code: each behaviour it promises has an assertion that goes red when
 * the behaviour is taken out. A fake that is quietly too forgiving makes every
 * test written against it too forgiving as well.
 *
 * This file does not touch the server's own modules; it talks to the fake over
 * HTTP only, the way a client will.
 */

const fake = startFakeJira();
// The second personality: Jira Data Center, REST v2, wiki markup, bearer tokens.
const dc = startFakeJira({ flavor: "datacenter" });
afterAll(async () => {
  await fake.stop();
  await dc.stop();
});
beforeEach(() => {
  fake.reset();
  dc.reset();
});

interface Reply {
  status: number;
  headers: Headers;
  json: any;
}

/** `on` picks the fake; a path that starts with `/rest/` is taken whole instead of under the fake's own API prefix. */
async function call(method: string, path: string, opts: { body?: unknown; auth?: string | null; on?: FakeJira } = {}): Promise<Reply> {
  const target = opts.on ?? fake;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.auth !== null) headers.authorization = opts.auth ?? (target.flavor === "datacenter" ? FAKE_PAT_AUTH : FAKE_AUTH);
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch((path.startsWith("/rest/") ? target.base : target.api) + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const adf = (text: string) => ({ version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const updatedOf = async (key: string) => (await call("GET", `/issue/${key}?fields=updated`)).json.fields.updated as string;

describe("auth and the request log", () => {
  it("answers 401 to a wrong token, a wrong email and no header; 200 to the right one", async () => {
    const wrongToken = `Basic ${Buffer.from(`${FAKE_EMAIL}:nope`).toString("base64")}`;
    const wrongEmail = `Basic ${Buffer.from(`eve@acme.example:${FAKE_TOKEN}`).toString("base64")}`;
    expect((await call("GET", "/myself", { auth: wrongToken })).status).toBe(401);
    expect((await call("GET", "/myself", { auth: wrongEmail })).status).toBe(401);
    expect((await call("GET", "/myself", { auth: "Bearer abc" })).status).toBe(401);
    const none = await call("GET", "/myself", { auth: null });
    expect(none.status).toBe(401);
    expect(none.json.message).toContain("authenticated");
    expect((await call("GET", "/myself")).status).toBe(200);
  });

  it("logs every call with method, path, query, auth and body, refused ones too", async () => {
    await call("GET", "/myself", { auth: null });
    await call("GET", "/issue/ORBIT-1042?fields=summary");
    await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: null } });
    await call("GET", "/nowhere");
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /myself",
      "GET /issue/ORBIT-1042",
      "PUT /issue/ORBIT-1042/assignee",
      "GET /nowhere",
    ]);
    expect(fake.requests[0].auth).toBeNull();
    expect(fake.requests[1].auth).toBe(FAKE_AUTH);
    expect(fake.requests[1].query).toEqual({ fields: "summary" });
    expect(fake.requests[2].body).toEqual({ accountId: null });
  });

  it("answers an unknown route 404 instead of pretending", async () => {
    const r = await call("GET", "/field");
    expect(r.status).toBe(404);
    expect(r.json.errorMessages[0]).toContain("does not serve");
  });
});

describe("identity and projects", () => {
  it("/myself returns the caller with an accountId and their own email", async () => {
    const r = await call("GET", "/myself");
    expect(r.status).toBe(200);
    expect(r.json.accountId).toBe("acc-0001");
    expect(r.json.emailAddress).toBe(FAKE_EMAIL);
  });

  it("/project/search lists both projects, pages them and filters by query", async () => {
    const all = await call("GET", "/project/search");
    expect(all.json.values.map((p: { key: string }) => p.key)).toEqual(["ORBIT", "ACME"]);
    expect(all.json.isLast).toBe(true);
    expect(JSON.stringify(all.json)).not.toContain("defaultAssignee");
    const first = await call("GET", "/project/search?maxResults=1");
    expect(first.json.values).toHaveLength(1);
    expect(first.json.isLast).toBe(false);
    const second = await call("GET", "/project/search?maxResults=1&startAt=1");
    expect(second.json.values[0].key).toBe("ACME");
    expect(second.json.isLast).toBe(true);
    const q = await call("GET", "/project/search?query=orb");
    expect(q.json.values.map((p: { key: string }) => p.key)).toEqual(["ORBIT"]);
  });
});

describe("reading an issue", () => {
  it("honours `fields`: only what is asked comes back", async () => {
    const r = await call("GET", "/issue/ORBIT-1042?fields=summary,status");
    expect(r.status).toBe(200);
    expect(r.json.key).toBe("ORBIT-1042");
    expect(r.json.id).toBe("20042");
    expect(Object.keys(r.json.fields).sort()).toEqual(["status", "summary"]);
    expect(r.json.fields.status.statusCategory.key).toBe("indeterminate");
  });

  it("without `fields` returns every navigable field but not the comment block", async () => {
    const r = await call("GET", "/issue/ORBIT-1042");
    expect(r.json.fields.summary).toBe("Fix timeout when syncing the board");
    expect(r.json.fields.priority.name).toBe("High");
    expect(r.json.fields.parent.key).toBe("ORBIT-1000");
    expect(r.json.fields.comment).toBeUndefined();
    expect((await call("GET", "/issue/ORBIT-1042?fields=comment")).json.fields.comment.total).toBe(1);
  });

  it("omits a hidden email from a user object instead of nulling it", async () => {
    const hidden = (await call("GET", "/issue/ORBIT-1043?fields=assignee")).json.fields.assignee;
    expect(hidden.displayName).toBe("Grace Sample");
    expect("emailAddress" in hidden).toBe(false);
    const visible = (await call("GET", "/issue/ORBIT-1044?fields=assignee")).json.fields.assignee;
    expect(visible.emailAddress).toBe("lin@acme.example");
  });

  it("has an issue in each status category and one unassigned", async () => {
    const keys = { new: "ORBIT-1001", indeterminate: "ORBIT-1042", done: "ORBIT-1045" };
    for (const [cat, key] of Object.entries(keys)) {
      expect((await call("GET", `/issue/${key}?fields=status`)).json.fields.status.statusCategory.key).toBe(cat);
    }
    expect((await call("GET", "/issue/ORBIT-1001?fields=assignee")).json.fields.assignee).toBeNull();
  });

  it("serves a rich ADF description: heading, paragraph, link, mention, list, code block, table", async () => {
    const d = (await call("GET", "/issue/ORBIT-1050?fields=description")).json.fields.description;
    expect(d.type).toBe("doc");
    const seen = new Set<string>();
    const walk = (n: { type: string; marks?: { type: string }[]; content?: unknown[] }) => {
      seen.add(n.type);
      for (const m of n.marks ?? []) seen.add(`mark:${m.type}`);
      for (const c of (n.content ?? []) as (typeof n)[]) walk(c);
    };
    walk(d);
    for (const t of ["heading", "paragraph", "bulletList", "listItem", "codeBlock", "table", "tableRow", "mention", "mark:link", "mark:strong"]) {
      expect(seen.has(t)).toBe(true);
    }
  });

  it("answers an unknown key 404 with Jira's sentence", async () => {
    const r = await call("GET", "/issue/ORBIT-9999");
    expect(r.status).toBe(404);
    expect(r.json.errorMessages[0]).toContain("does not exist or you do not have permission");
  });
});

describe("transitions", () => {
  it("lists only the moves valid from the current status", async () => {
    const r = await call("GET", "/issue/ORBIT-1042/transitions");
    expect(r.status).toBe(200);
    expect(r.json.transitions.map((t: { id: string }) => t.id)).toEqual(["21", "22"]);
    expect(r.json.transitions[0].to.name).toBe("In Review");
    expect(r.json.transitions[0].fields).toBeUndefined();
  });

  it("adds each screen's fields only with expand=transitions.fields", async () => {
    const qa = await call("GET", "/issue/ORBIT-1044/transitions?expand=transitions.fields");
    const approve = qa.json.transitions.find((t: { id: string }) => t.id === "41");
    expect(approve.hasScreen).toBe(true);
    expect(approve.fields.resolution.required).toBe(true);
    const review = (await call("GET", "/issue/ORBIT-1043/transitions?expand=transitions.fields")).json.transitions.find((t: { id: string }) => t.id === "31");
    expect(review.fields.assignee.required).toBe(false);
    expect(Object.keys((await call("GET", "/issue/ORBIT-1001/transitions?expand=transitions.fields")).json.transitions[0].fields)).toEqual([]);
  });

  it("returns an empty list with 200 when the caller may not transition", async () => {
    fake.state.deny.transition.push("ORBIT-1042");
    const r = await call("GET", "/issue/ORBIT-1042/transitions");
    expect(r.status).toBe(200);
    expect(r.json.transitions).toEqual([]);
    expect((await call("GET", "/issue/ORBIT-1043/transitions")).json.transitions.length).toBeGreaterThan(0);
  });

  it("a plain transition moves the status and bumps `updated`", async () => {
    const before = await updatedOf("ORBIT-1042");
    const r = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "22" } } });
    expect(r.status).toBe(204);
    const after = (await call("GET", "/issue/ORBIT-1042?fields=status,updated,assignee")).json.fields;
    expect(after.status.name).toBe("To Do");
    expect(after.updated > before).toBe(true);
    expect(after.assignee.accountId).toBe("acc-0001");
  });

  it("accepts the transition id as a number too", async () => {
    expect((await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: 22 } } })).status).toBe(204);
  });

  it("runs the post-function: entering QA assigns the QA owner, even over an assignee sent with it", async () => {
    const r = await call("POST", "/issue/ORBIT-1043/transitions", { body: { transition: { id: "31" }, fields: { assignee: { accountId: "acc-0004" } } } });
    expect(r.status).toBe(204);
    const f = (await call("GET", "/issue/ORBIT-1043?fields=status,assignee")).json.fields;
    expect(f.status.name).toBe("QA");
    expect(f.assignee.accountId).toBe("acc-0003");
  });

  it("sets the assignee from a screen that has the field", async () => {
    const r = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "21" }, fields: { assignee: { accountId: "acc-0002" } } } });
    expect(r.status).toBe(204);
    expect((await call("GET", "/issue/ORBIT-1042?fields=assignee")).json.fields.assignee.accountId).toBe("acc-0002");
    const unassign = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "32" }, fields: {} } });
    expect(unassign.status).toBe(204);
  });

  it("a transition with a required field is 400 naming the field, and nothing moves", async () => {
    const r = await call("POST", "/issue/ORBIT-1044/transitions", { body: { transition: { id: "41" } } });
    expect(r.status).toBe(400);
    expect(Object.keys(r.json.errors)).toEqual(["resolution"]);
    expect((await call("GET", "/issue/ORBIT-1044?fields=status")).json.fields.status.name).toBe("QA");
    const ok = await call("POST", "/issue/ORBIT-1044/transitions", { body: { transition: { id: "41" }, fields: { resolution: { name: "Done" } } } });
    expect(ok.status).toBe(204);
    const f = (await call("GET", "/issue/ORBIT-1044?fields=status,resolution")).json.fields;
    expect(f.status.statusCategory.key).toBe("done");
    expect(f.resolution.name).toBe("Done");
  });

  it("sending `assignee` on a screen without it is 400 naming assignee", async () => {
    const r = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "22" }, fields: { assignee: { accountId: "acc-0002" } } } });
    expect(r.status).toBe(400);
    expect(Object.keys(r.json.errors)).toEqual(["assignee"]);
    expect((await call("GET", "/issue/ORBIT-1042?fields=status")).json.fields.status.name).toBe("In Progress");
  });

  it("a transition that is not valid now, a missing id and an unknown assignee are 400", async () => {
    const stale = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "41" } } });
    expect(stale.status).toBe(400);
    expect(stale.json.errorMessages[0]).toContain("not valid");
    expect((await call("POST", "/issue/ORBIT-1042/transitions", { body: {} })).status).toBe(400);
    const ghost = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "21" }, fields: { assignee: { accountId: "acc-9999" } } } });
    expect(ghost.status).toBe(400);
    expect(ghost.json.errors.assignee).toContain("acc-9999");
  });

  it("without the permission the POST is 400 and nothing moves", async () => {
    fake.state.deny.transition.push("ORBIT-1042");
    expect((await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "22" } } })).status).toBe(400);
    expect((await call("GET", "/issue/ORBIT-1042?fields=status")).json.fields.status.name).toBe("In Progress");
  });

  it("can be told to answer 409 for a conflicting write", async () => {
    fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 409 });
    const r = await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "22" } } });
    expect(r.status).toBe(409);
    expect((await call("GET", "/issue/ORBIT-1042?fields=status")).json.fields.status.name).toBe("In Progress");
  });
});

describe("assignee", () => {
  it("sets, clears, and bumps `updated` each time", async () => {
    const t0 = await updatedOf("ORBIT-1042");
    expect((await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: "acc-0002" } })).status).toBe(204);
    const t1 = await updatedOf("ORBIT-1042");
    expect(t1 > t0).toBe(true);
    expect((await call("GET", "/issue/ORBIT-1042?fields=assignee")).json.fields.assignee.accountId).toBe("acc-0002");
    expect((await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: null } })).status).toBe(204);
    expect((await call("GET", "/issue/ORBIT-1042?fields=assignee")).json.fields.assignee).toBeNull();
    expect((await updatedOf("ORBIT-1042")) > t1).toBe(true);
  });

  it('"-1" lands on the project default, which is exactly what a caller must never send', async () => {
    await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: "-1" } });
    expect((await call("GET", "/issue/ORBIT-1042?fields=assignee")).json.fields.assignee.accountId).toBe("acc-0002");
    await call("PUT", "/issue/ACME-7/assignee", { body: { accountId: "-1" } });
    expect((await call("GET", "/issue/ACME-7?fields=assignee")).json.fields.assignee.accountId).toBe("acc-0003");
  });

  it("refuses an unknown account with 400, a missing body with 400, no permission with 403", async () => {
    const ghost = await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: "acc-9999" } });
    expect(ghost.status).toBe(400);
    expect(ghost.json.errors.assignee).toContain("acc-9999");
    expect((await call("PUT", "/issue/ORBIT-1042/assignee", { body: {} })).status).toBe(400);
    fake.state.deny.assign.push("ORBIT-1042");
    expect((await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: "acc-0002" } })).status).toBe(403);
    expect((await call("GET", "/issue/ORBIT-1042?fields=assignee")).json.fields.assignee.accountId).toBe("acc-0001");
  });
});

describe("comments", () => {
  it("lists comments with an ADF body and a mention", async () => {
    const r = await call("GET", "/issue/ORBIT-1042/comment");
    expect(r.json.total).toBe(1);
    expect(r.json.comments[0].author.displayName).toBe("Grace Sample");
    expect(JSON.stringify(r.json.comments[0].body)).toContain('"type":"mention"');
  });

  it("accepts an ADF body: 201, stored, shown on the next read, `updated` bumped", async () => {
    const t0 = await updatedOf("ORBIT-1042");
    const r = await call("POST", "/issue/ORBIT-1042/comment", { body: { body: adf("Looking at it now") } });
    expect(r.status).toBe(201);
    expect(r.json.author.accountId).toBe("acc-0001");
    const list = (await call("GET", "/issue/ORBIT-1042/comment")).json;
    expect(list.total).toBe(2);
    expect(JSON.stringify(list.comments[1].body)).toContain("Looking at it now");
    expect((await updatedOf("ORBIT-1042")) > t0).toBe(true);
  });

  it("rejects a plain string, a wrong version and a missing body with 400, storing nothing", async () => {
    for (const body of [{ body: "plain text" }, { body: { type: "doc", version: 2, content: [] } }, { body: { type: "paragraph", version: 1, content: [] } }, {}]) {
      const r = await call("POST", "/issue/ORBIT-1042/comment", { body });
      expect(r.status).toBe(400);
      expect(r.json.errorMessages[0]).toContain("Atlassian Document");
    }
    expect((await call("GET", "/issue/ORBIT-1042/comment")).json.total).toBe(1);
  });

  it("is 403 without the permission", async () => {
    fake.state.deny.comment.push("ORBIT-1042");
    expect((await call("POST", "/issue/ORBIT-1042/comment", { body: { body: adf("x") } })).status).toBe(403);
  });
});

describe("search", () => {
  const search = (body: unknown) => call("POST", "/search/jql", { body });

  it("pages by nextPageToken until isLast and never sends a total", async () => {
    const p1 = await search({ jql: "project = ORBIT ORDER BY key ASC", fields: ["summary"] });
    expect(p1.status).toBe(200);
    expect(p1.json.issues.map((i: { key: string }) => i.key)).toEqual(["ORBIT-1000", "ORBIT-1001", "ORBIT-1042", "ORBIT-1043"]);
    expect(p1.json.isLast).toBe(false);
    expect(typeof p1.json.nextPageToken).toBe("string");
    const p2 = await search({ jql: "project = ORBIT order by key", fields: ["summary"], nextPageToken: p1.json.nextPageToken });
    expect(p2.json.issues.map((i: { key: string }) => i.key)).toEqual(["ORBIT-1044", "ORBIT-1045", "ORBIT-1046", "ORBIT-1050"]);
    expect(p2.json.isLast).toBe(true);
    expect(p2.json.nextPageToken).toBeUndefined();
    for (const p of [p1, p2]) {
      expect("total" in p.json).toBe(false);
      expect(JSON.stringify(p.json)).not.toContain('"total"');
    }
  });

  it("honours maxResults when it is smaller than the page, and the page when it is larger", async () => {
    expect((await search({ jql: "project = ORBIT", maxResults: 2 })).json.issues).toHaveLength(2);
    expect((await search({ jql: "project = ORBIT", maxResults: 500 })).json.issues).toHaveLength(4);
  });

  it("refuses an unbounded query with 400, with or without `order by`", async () => {
    for (const jql of ["order by key", "ORDER BY updated DESC", "", "   "]) {
      const r = await search({ jql });
      expect(r.status).toBe(400);
      expect(r.json.errorMessages[0]).toContain("Unbounded");
    }
    expect((await search({})).status).toBe(400);
    expect((await search({ jql: "assignee = currentUser() order by key" })).status).toBe(200);
  });

  it("answers the bounded example: assignee = currentUser()", async () => {
    const r = await search({ jql: "assignee = currentUser() order by key" });
    expect(r.json.issues.map((i: { key: string }) => i.key)).toEqual(["ORBIT-1000", "ORBIT-1042", "ORBIT-1045", "ORBIT-1050"]);
  });

  it("filters by project, status, status category and assignee, and orders by updated", async () => {
    const keys = async (jql: string) => (await search({ jql })).json.issues.map((i: { key: string }) => i.key);
    expect(await keys("project = ACME")).toEqual(["ACME-7", "ACME-8"]);
    expect(await keys('project = ORBIT AND status = "In Review"')).toEqual(["ORBIT-1043"]);
    expect(await keys("project = ORBIT AND statusCategory = Done")).toEqual(["ORBIT-1045"]);
    expect(await keys("project = ORBIT AND assignee is EMPTY")).toEqual(["ORBIT-1001", "ORBIT-1046"]);
    expect(await keys('project = ACME AND assignee = "acc-0002"')).toEqual(["ACME-7"]);
    expect((await keys("project = ORBIT order by updated desc"))[0]).toBe("ORBIT-1044");
  });

  it("is 400 for a clause the fake does not understand, rather than silently matching all", async () => {
    const r = await search({ jql: "labels = ui" });
    expect(r.status).toBe(400);
    expect(r.json.errorMessages[0]).toContain("labels = ui");
  });

  it("is 400 for a token it never issued", async () => {
    expect((await search({ jql: "project = ORBIT", nextPageToken: "garbage" })).status).toBe(400);
  });

  it("honours the requested fields on each hit", async () => {
    const r = await search({ jql: "project = ACME", fields: ["status"] });
    expect(Object.keys(r.json.issues[0].fields)).toEqual(["status"]);
  });

  it("answers the removed /search with 410 and a pointer to the replacement", async () => {
    for (const method of ["GET", "POST"]) {
      const r = await call(method, "/search", method === "POST" ? { body: { jql: "project = ORBIT" } } : {});
      expect(r.status).toBe(410);
      expect(r.json.errorMessages[0]).toContain("/search/jql");
    }
  });

  it("can serve a stale index, so a re-read through search is visibly wrong", async () => {
    fake.state.searchLags = true;
    await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "22" } } });
    const hit = (await search({ jql: "key = ORBIT-1042", fields: ["status"] })).json.issues[0];
    expect(hit.fields.status.name).toBe("In Progress");
    expect((await call("GET", "/issue/ORBIT-1042?fields=status")).json.fields.status.name).toBe("To Do");
  });

  it("an empty search and a failing search are different answers", async () => {
    fake.fail({ path: "/search/jql", empty: true, times: 1 });
    const empty = await search({ jql: "project = ORBIT" });
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ issues: [], isLast: true });
    fake.fail({ path: "/search/jql", status: 500, times: 1 });
    expect((await search({ jql: "project = ORBIT" })).status).toBe(500);
  });
});

describe("priorities and people", () => {
  it("/priority/search pages five priorities", async () => {
    const all = await call("GET", "/priority/search");
    expect(all.json.values.map((p: { name: string }) => p.name)).toEqual(["Highest", "High", "Medium", "Low", "Lowest"]);
    expect(all.json.isLast).toBe(true);
    const page = await call("GET", "/priority/search?maxResults=2&startAt=2");
    expect(page.json.values.map((p: { name: string }) => p.name)).toEqual(["Medium", "Low"]);
    expect(page.json.isLast).toBe(false);
  });

  it("/priority still answers like the deprecated endpoint, and the log shows who called it", async () => {
    expect((await call("GET", "/priority")).json).toHaveLength(5);
    expect(fake.requests.some((r) => r.path === "/priority")).toBe(true);
  });

  it("assignable search returns fewer than maxResults on purpose", async () => {
    const r = await call("GET", "/user/assignable/search?issueKey=ORBIT-1042&maxResults=50");
    expect(r.status).toBe(200);
    expect(r.json.map((u: { displayName: string }) => u.displayName)).toEqual(["Ada Example", "Grace Sample", "Lin Tester"]);
    expect(r.json.length).toBeLessThan(50);
    const q = await call("GET", "/user/assignable/search?issueKey=ORBIT-1042&query=gra");
    expect(q.json.map((u: { accountId: string }) => u.accountId)).toEqual(["acc-0002"]);
    expect((await call("GET", "/user/assignable/search?query=margaret")).json).toEqual([]);
    expect("emailAddress" in r.json[1]).toBe(false);
  });

  it("the scan cap is configurable", async () => {
    const wide = startFakeJira({ assignableScanCap: 100 });
    try {
      const res = await fetch(`${wide.api}/user/assignable/search?maxResults=50`, { headers: { authorization: FAKE_AUTH } });
      const names = ((await res.json()) as { displayName: string }[]).map((u) => u.displayName);
      expect(names).toContain("Margaret Hidden");
      expect(names).not.toContain("Kai Dormant");
    } finally {
      await wide.stop();
    }
  });
});

describe("per-issue write limiter", () => {
  it("allows 20 writes in 2 s on one issue and answers the 21st with 429 jira-per-issue-on-write", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: "acc-0002" } })).status).toBe(204);
    }
    const r = await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: "acc-0002" } });
    expect(r.status).toBe(429);
    expect(r.headers.get("RateLimit-Reason")).toBe("jira-per-issue-on-write");
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another issue, and reads of this one, are untouched.
    expect((await call("PUT", "/issue/ORBIT-1043/assignee", { body: { accountId: "acc-0002" } })).status).toBe(204);
    expect((await call("GET", "/issue/ORBIT-1042")).status).toBe(200);
  });

  it("counts transitions and comments in the same window", async () => {
    for (let i = 0; i < 10; i++) await call("POST", "/issue/ORBIT-1042/comment", { body: { body: adf("x") } });
    for (let i = 0; i < 10; i++) await call("POST", "/issue/ORBIT-1042/transitions", { body: {} });
    expect((await call("POST", "/issue/ORBIT-1042/comment", { body: { body: adf("x") } })).status).toBe(429);
  });
});

describe("failure switches", () => {
  it("answers each status with its body, on any matching path", async () => {
    for (const status of [401, 403, 404, 409, 500] as const) {
      fake.fail({ path: "/myself", status, times: 1 });
      const r = await call("GET", "/myself");
      expect(r.status).toBe(status);
      expect(r.json).not.toBeNull();
      expect(r.headers.get("Retry-After")).toBeNull();
      expect(r.headers.get("RateLimit-Reason")).toBeNull();
      expect(r.headers.get("X-RateLimit-Reset")).toBeNull();
    }
  });

  it("a 429 carries Retry-After, X-RateLimit-Reset and RateLimit-Reason", async () => {
    fake.fail({ path: "/issue/*", status: 429, retryAfter: 7, reason: "jira-burst-based", times: 1 });
    const r = await call("GET", "/issue/ORBIT-1042");
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("7");
    expect(r.headers.get("RateLimit-Reason")).toBe("jira-burst-based");
    const reset = Date.parse(r.headers.get("X-RateLimit-Reset") ?? "");
    expect(Number.isNaN(reset)).toBe(false);
    expect(reset).toBeGreaterThan(Date.now());
    fake.fail({ path: "/myself", status: 429, times: 1 });
    const d = await call("GET", "/myself");
    expect(d.headers.get("Retry-After")).toBe("5");
    expect(d.headers.get("RateLimit-Reason")).toBe("jira-burst-based");
  });

  it("`times` limits how many requests a rule takes, and a method filter is respected", async () => {
    fake.fail({ path: "/myself", status: 500, times: 2 });
    expect([(await call("GET", "/myself")).status, (await call("GET", "/myself")).status, (await call("GET", "/myself")).status]).toEqual([500, 500, 200]);
    fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 500 });
    expect((await call("GET", "/issue/ORBIT-1042/comment")).status).toBe(200);
    expect((await call("POST", "/issue/ORBIT-1042/comment", { body: { body: adf("x") } })).status).toBe(500);
  });

  it("a failing write changes nothing", async () => {
    fake.fail({ path: "/issue/ORBIT-1042/assignee", status: 500, times: 1 });
    await call("PUT", "/issue/ORBIT-1042/assignee", { body: { accountId: null } });
    expect((await call("GET", "/issue/ORBIT-1042?fields=assignee")).json.fields.assignee.accountId).toBe("acc-0001");
  });

  it("a rule fires before the auth check, so a 401 can be forced with good credentials", async () => {
    fake.fail({ path: "/issue/*", status: 401 });
    expect((await call("GET", "/issue/ORBIT-1042")).status).toBe(401);
  });

  it("holds the answer for delayMs", async () => {
    fake.fail({ path: "/myself", delayMs: 200, times: 1 });
    const t0 = Date.now();
    expect((await call("GET", "/myself")).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
    const t1 = Date.now();
    await call("GET", "/myself");
    expect(Date.now() - t1).toBeLessThan(150);
  });

  it("drops the connection mid-answer", async () => {
    fake.fail({ path: "/myself", drop: true, times: 1 });
    let threw = false;
    try {
      const res = await fetch(fake.api + "/myself", { headers: { authorization: FAKE_AUTH } });
      await res.json();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect((await call("GET", "/myself")).status).toBe(200);
  });

  it("answers 200 with a body that is not JSON", async () => {
    fake.fail({ path: "/search/jql", garbage: true, times: 1 });
    const res = await fetch(fake.api + "/search/jql", { method: "POST", headers: { authorization: FAKE_AUTH }, body: JSON.stringify({ jql: "project = ORBIT" }) });
    expect(res.status).toBe(200);
    let parsed = true;
    try {
      await res.json();
    } catch {
      parsed = false;
    }
    expect(parsed).toBe(false);
  });
});

describe("X-RateLimit-Remaining", () => {
  it("is on every response by default, on a 429 too, and can be dropped", async () => {
    expect((await call("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBe("100");
    expect((await call("GET", "/myself", { auth: null })).headers.get("X-RateLimit-Remaining")).toBe("100");
    fake.setRemaining(0);
    expect((await call("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBe("0");
    fake.fail({ path: "/myself", status: 429, times: 1 });
    expect((await call("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBe("0");
    fake.setRemaining(null);
    expect((await call("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBeNull();
  });
});

describe("reset", () => {
  it("restores the seed in place, empties the log, rules, limiter and header", async () => {
    const state = fake.state;
    await call("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "22" } } });
    fake.state.deny.assign.push("ORBIT-1042");
    fake.state.searchLags = true;
    fake.fail({ path: "/myself", status: 500 });
    fake.setRemaining(null);
    for (let i = 0; i < 21; i++) await call("PUT", "/issue/ORBIT-1043/assignee", { body: { accountId: null } });
    fake.reset();
    expect(fake.state).toBe(state);
    expect(fake.requests).toHaveLength(0);
    expect(fake.state.issues["ORBIT-1042"].statusId).toBe("2");
    expect(fake.state.deny.assign).toEqual([]);
    expect(fake.state.searchLags).toBe(false);
    expect((await call("GET", "/myself")).status).toBe(200);
    expect((await call("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBe("100");
    expect((await call("PUT", "/issue/ORBIT-1043/assignee", { body: { accountId: "acc-0002" } })).status).toBe(204);
  });
});

const onDc = (method: string, path: string, opts: { body?: unknown; auth?: string | null } = {}) => call(method, path, { ...opts, on: dc });

describe("serverInfo", () => {
  it("answers Cloud on the Cloud fake and Server on the Data Center fake, with a version", async () => {
    const cloud = await call("GET", "/rest/api/2/serverInfo");
    expect(cloud.status).toBe(200);
    expect(cloud.json.deploymentType).toBe("Cloud");
    expect(cloud.json.version).toMatch(/^1001\./);
    const server = await onDc("GET", "/rest/api/2/serverInfo");
    expect(server.json.deploymentType).toBe("Server");
    expect(server.json.version).toBe("9.12.0");
    expect(server.json.versionNumbers).toEqual([9, 12, 0]);
  });

  it("is open to a caller with no credentials, on both, and logged under its whole path", async () => {
    expect((await call("GET", "/rest/api/2/serverInfo", { auth: null })).status).toBe(200);
    expect((await onDc("GET", "/rest/api/2/serverInfo", { auth: null })).status).toBe(200);
    expect(fake.requests.map((r) => r.path)).toEqual(["/rest/api/2/serverInfo"]);
    expect(dc.requests.map((r) => r.path)).toEqual(["/rest/api/2/serverInfo"]);
    expect(dc.requests[0].auth).toBeNull();
  });

  it("can leave the deployment type out or say another one, the way an odd site does", async () => {
    const odd = startFakeJira({ flavor: "datacenter", serverInfo: { deploymentType: null, version: "8.20.1" } });
    const other = startFakeJira({ serverInfo: { deploymentType: "Cloud" }, flavor: "datacenter" });
    try {
      const a = await call("GET", "/rest/api/2/serverInfo", { on: odd });
      expect("deploymentType" in a.json).toBe(false);
      expect(a.json.version).toBe("8.20.1");
      expect((await call("GET", "/rest/api/2/serverInfo", { on: other })).json.deploymentType).toBe("Cloud");
    } finally {
      await odd.stop();
      await other.stop();
    }
  });

  it("obeys a failure rule like any other path, whichever flavor", async () => {
    dc.fail({ path: "/rest/api/2/serverInfo", status: 404 });
    fake.fail({ path: "/rest/api/2/serverInfo", status: 500 });
    expect((await onDc("GET", "/rest/api/2/serverInfo")).status).toBe(404);
    expect((await call("GET", "/rest/api/2/serverInfo")).status).toBe(500);
  });
});

describe("the Data Center personality", () => {
  const wikiOf = (r: Reply) => r.json.fields.description as string;

  it("serves REST v2 only: a v3 path is not there, and Cloud has no v2 issue routes", async () => {
    expect((await call("GET", "/rest/api/3/myself", { on: dc })).status).toBe(404);
    expect((await call("GET", "/rest/api/3/issue/ORBIT-1042", { on: dc })).status).toBe(404);
    expect((await call("GET", "/rest/api/2/myself", { on: fake })).status).toBe(404);
    expect((await onDc("GET", "/myself")).status).toBe(200);
    expect(dc.api.endsWith("/rest/api/2")).toBe(true);
    expect(dc.requests.map((r) => r.path)).toEqual(["/rest/api/3/myself", "/rest/api/3/issue/ORBIT-1042", "/myself"]);
  });

  it("signs in with a bearer token, or a name and password over Basic; Cloud's email and token do not work", async () => {
    expect((await onDc("GET", "/myself", { auth: FAKE_PAT_AUTH })).status).toBe(200);
    expect((await onDc("GET", "/myself", { auth: FAKE_DC_BASIC })).status).toBe(200);
    expect((await onDc("GET", "/myself", { auth: FAKE_AUTH })).status).toBe(401);
    expect((await onDc("GET", "/myself", { auth: "Bearer pat-wrong" })).status).toBe(401);
    expect((await onDc("GET", "/myself", { auth: null })).status).toBe(401);
    // And the other way round: Cloud does not take a personal access token.
    expect((await call("GET", "/myself", { auth: FAKE_PAT_AUTH })).status).toBe(401);
    const refused = await onDc("GET", "/myself", { auth: "Bearer pat-wrong" });
    expect(refused.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("knows people by name and key, with no account id anywhere", async () => {
    const me = await onDc("GET", "/myself");
    expect(me.json).toMatchObject({ name: "ada", key: "JIRAUSER10000", displayName: "Ada Example", emailAddress: "ada@acme.example", active: true });
    const issue = await onDc("GET", "/issue/ORBIT-1042?fields=assignee,reporter");
    expect(issue.json.fields.assignee).toMatchObject({ name: "ada", key: "JIRAUSER10000" });
    expect(issue.json.fields.reporter).toMatchObject({ name: "grace" });
    // A hidden Cloud email is shown here: the fake does not model Data Center's own privacy switch.
    expect(issue.json.fields.reporter.emailAddress).toBe("grace@acme.example");
    expect(JSON.stringify([me.json, issue.json, (await onDc("GET", "/search?jql=project%3DORBIT")).json])).not.toContain("accountId");
    expect(JSON.stringify([me.json, issue.json])).not.toContain("acc-000");
  });

  it("reads a description as a wiki markup string, not a document", async () => {
    const r = await onDc("GET", "/issue/ORBIT-1050?fields=description");
    expect(typeof wikiOf(r)).toBe("string");
    expect(wikiOf(r)).toContain("h2. Problem");
    expect(wikiOf(r)).toContain("[runbook|https://docs.acme.example/runbook]");
    expect(wikiOf(r)).toContain("[~grace]");
    expect(wikiOf(r)).toContain("{code:ts}");
    const cloud = await call("GET", "/issue/ORBIT-1050?fields=description");
    expect(cloud.json.fields.description.type).toBe("doc");
    expect((await onDc("GET", "/issue/ORBIT-1042?fields=description")).json.fields.description).toBeNull();
  });

  it("serves a seeded comment as wiki text, and refuses a v3 document body with 400", async () => {
    const list = await onDc("GET", "/issue/ORBIT-1042/comment");
    expect(list.json.comments[0].body).toBe("[~ada] can you take a look at the retry loop?");
    expect(list.json.comments[0].author).toMatchObject({ name: "grace" });
    const adfBody = await onDc("POST", "/issue/ORBIT-1042/comment", { body: { body: adf("hello") } });
    expect(adfBody.status).toBe(400);
    expect(dc.state.issues["ORBIT-1042"].comments).toHaveLength(1);
    for (const empty of ["", "   ", null, 7]) expect((await onDc("POST", "/issue/ORBIT-1042/comment", { body: { body: empty } })).status).toBe(400);
    const ok = await onDc("POST", "/issue/ORBIT-1042/comment", { body: { body: "*retrying* now, see [~grace]" } });
    expect(ok.status).toBe(201);
    expect(ok.json.body).toBe("*retrying* now, see [~grace]");
    expect(ok.json.author).toMatchObject({ name: "ada" });
    expect((await onDc("GET", "/issue/ORBIT-1042/comment")).json.comments.map((c: { body: string }) => c.body)).toContain("*retrying* now, see [~grace]");
    // The mirror image: Cloud refuses wiki text.
    expect((await call("POST", "/issue/ORBIT-1042/comment", { body: { body: "plain" } })).status).toBe(400);
  });

  it("writes an assignee by name: null unassigns, an account id or an unknown name is refused, -1 is the default", async () => {
    expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { name: "lin" } })).status).toBe(204);
    expect(dc.state.issues["ORBIT-1043"].assignee).toBe("acc-0003");
    expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { accountId: "acc-0001" } })).status).toBe(400);
    expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { name: "nobody" } })).status).toBe(400);
    expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { name: "acc-0001" } })).status).toBe(400);
    expect(dc.state.issues["ORBIT-1043"].assignee).toBe("acc-0003");
    expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { name: null } })).status).toBe(204);
    expect(dc.state.issues["ORBIT-1043"].assignee).toBeNull();
    expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { name: "-1" } })).status).toBe(204);
    expect(dc.state.issues["ORBIT-1043"].assignee).toBe("acc-0002");
    // Cloud does not take a name.
    expect((await call("PUT", "/issue/ORBIT-1043/assignee", { body: { name: "lin" } })).status).toBe(400);
  });

  it("moves an issue like Cloud does, with the assignee given by name on a screen that has one", async () => {
    const list = await onDc("GET", "/issue/ORBIT-1042/transitions?expand=transitions.fields");
    expect(list.json.transitions.map((t: { id: string }) => t.id)).toEqual(["21", "22"]);
    expect(list.json.transitions[0].fields.assignee).toBeDefined();
    // Availability and conditions are Cloud's words.
    expect("isAvailable" in list.json.transitions[0]).toBe(false);
    expect("isAvailable" in (await call("GET", "/issue/ORBIT-1042/transitions")).json.transitions[0]).toBe(true);
    const byId = await onDc("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "21" }, fields: { assignee: { accountId: "acc-0003" } } } });
    expect(byId.status).toBe(400);
    expect(byId.json.errors.assignee).toBeDefined();
    expect(dc.state.issues["ORBIT-1042"].statusId).toBe("2");
    const byName = await onDc("POST", "/issue/ORBIT-1042/transitions", { body: { transition: { id: "21" }, fields: { assignee: { name: "lin" } } } });
    expect(byName.status).toBe(204);
    expect(dc.state.issues["ORBIT-1042"]).toMatchObject({ statusId: "3", assignee: "acc-0003" });
    // A screen without an assignee, a required field, a denied caller: the same 400s as on Cloud.
    expect((await onDc("POST", "/issue/ORBIT-1043/transitions", { body: { transition: { id: "32" }, fields: { assignee: { name: "ada" } } } })).status).toBe(400);
    dc.state.issues["ORBIT-1044"].statusId = "4";
    expect((await onDc("POST", "/issue/ORBIT-1044/transitions", { body: { transition: { id: "41" } } })).status).toBe(400);
    dc.state.deny.transition.push("ORBIT-1001");
    expect((await onDc("GET", "/issue/ORBIT-1001/transitions")).json.transitions).toEqual([]);
    expect((await onDc("POST", "/issue/ORBIT-1001/transitions", { body: { transition: { id: "11" } } })).status).toBe(400);
  });

  it("searches on /search with startAt and a total; /search/jql is not there", async () => {
    const p1 = await onDc("POST", "/search", { body: { jql: "project = ORBIT order by key", fields: ["summary"] } });
    expect(p1.status).toBe(200);
    expect(p1.json).toMatchObject({ startAt: 0, maxResults: 4, total: 8 });
    expect(p1.json.issues.map((i: { key: string }) => i.key)).toEqual(["ORBIT-1000", "ORBIT-1001", "ORBIT-1042", "ORBIT-1043"]);
    expect("nextPageToken" in p1.json || "isLast" in p1.json).toBe(false);
    const p2 = await onDc("POST", "/search", { body: { jql: "project = ORBIT order by key", startAt: 4, maxResults: 50 } });
    expect(p2.json.issues.map((i: { key: string }) => i.key)).toEqual(["ORBIT-1044", "ORBIT-1045", "ORBIT-1046", "ORBIT-1050"]);
    expect(p2.json).toMatchObject({ startAt: 4, maxResults: 4, total: 8 });
    const viaGet = await onDc("GET", "/search?jql=project%3DACME&fields=summary,status");
    expect(viaGet.json.issues.map((i: { key: string }) => i.key)).toEqual(["ACME-7", "ACME-8"]);
    expect(Object.keys(viaGet.json.issues[0].fields).sort()).toEqual(["status", "summary"]);
    expect((await onDc("POST", "/search/jql", { body: { jql: "project = ORBIT" } })).status).toBe(404);
    // Cloud is the other way round.
    expect((await call("POST", "/search", { body: { jql: "project = ORBIT" } })).status).toBe(410);
  });

  it("accepts an unbounded query, names people by login in JQL, and refuses an account id there", async () => {
    const all = await onDc("POST", "/search", { body: { jql: "order by key", maxResults: 100 } });
    expect(all.status).toBe(200);
    expect(all.json.total).toBe(10);
    expect((await onDc("POST", "/search", { body: { jql: "" } })).json.total).toBe(10);
    const mine = await onDc("POST", "/search", { body: { jql: "assignee = currentUser() order by key" } });
    expect(mine.json.issues.map((i: { key: string }) => i.key)).toEqual(["ORBIT-1000", "ORBIT-1042", "ORBIT-1045", "ORBIT-1050"]);
    const byName = await onDc("POST", "/search", { body: { jql: 'assignee = "lin"' } });
    expect(byName.json.issues.map((i: { key: string }) => i.key)).toEqual(["ACME-8", "ORBIT-1044"]);
    expect((await onDc("POST", "/search", { body: { jql: "assignee = acc-0003" } })).status).toBe(400);
    // Cloud knows the account id and not the login.
    expect((await call("POST", "/search/jql", { body: { jql: "assignee = lin" } })).status).toBe(400);
    expect((await call("POST", "/search/jql", { body: { jql: "assignee = acc-0003" } })).json.issues).toHaveLength(2);
  });

  it("lists projects as one unpaged array and priorities from /priority; the Cloud forms are not there", async () => {
    const projects = await onDc("GET", "/project");
    expect(Array.isArray(projects.json)).toBe(true);
    expect(projects.json.map((p: { key: string }) => p.key)).toEqual(["ORBIT", "ACME"]);
    expect((await onDc("GET", "/project/search")).status).toBe(404);
    expect((await onDc("GET", "/priority/search")).status).toBe(404);
    expect((await onDc("GET", "/priority")).json).toHaveLength(5);
    expect((await call("GET", "/project")).status).toBe(404);
  });

  it("finds assignable users by the `username` text and returns Data Center people", async () => {
    const r = await onDc("GET", "/user/assignable/search?issueKey=ORBIT-1042&username=gra");
    expect(r.json.map((u: { name: string }) => u.name)).toEqual(["grace"]);
    expect(r.json[0].accountId).toBeUndefined();
    const byEmail = await onDc("GET", "/user/assignable/search?issueKey=ORBIT-1042&username=lin@acme");
    expect(byEmail.json.map((u: { name: string }) => u.name)).toEqual(["lin"]);
  });

  it("sends no rate-limit headers, a bare Retry-After on a 429, and has no per-issue write limit", async () => {
    expect((await onDc("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBeNull();
    dc.fail({ path: "/myself", status: 429, retryAfter: 7, reason: "jira-burst-based" });
    const limited = await onDc("GET", "/myself");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("7");
    expect(limited.headers.get("RateLimit-Reason")).toBeNull();
    expect(limited.headers.get("X-RateLimit-Reset")).toBeNull();
    for (let i = 0; i < 25; i++) expect((await onDc("PUT", "/issue/ORBIT-1043/assignee", { body: { name: "ada" } })).status).toBe(204);
    dc.setRemaining(41);
    expect((await onDc("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBe("41");
    dc.reset();
    expect((await onDc("GET", "/myself")).headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("resets to its own seed (wiki text), not Cloud's", async () => {
    await onDc("POST", "/issue/ORBIT-1042/comment", { body: { body: "later" } });
    dc.reset();
    expect(typeof wikiOf(await onDc("GET", "/issue/ORBIT-1050?fields=description"))).toBe("string");
    expect(dc.state.issues["ORBIT-1042"].comments).toHaveLength(1);
    expect(dc.state.issues["ORBIT-1042"].comments[0].body).toBe("[~ada] can you take a look at the retry loop?");
  });
});

describe("boards and saved filters", () => {
  for (const flavor of ["cloud", "datacenter"] as const) {
    const f = flavor === "cloud" ? fake : dc;
    const at = (method: string, path: string) => call(method, path, { on: f });
    const keys = async (jql: string) => {
      const r = flavor === "cloud"
        ? await call("POST", "/search/jql", { on: f, body: { jql, maxResults: 50, fields: ["summary"] } })
        : await call("POST", "/search", { on: f, body: { jql, maxResults: 50, fields: ["summary"] } });
      return r.status === 200 ? (r.json.issues as { key: string }[]).map((i) => i.key) : r.json;
    };

    it(`${flavor}: lists boards under /rest/agile/1.0, logged whole, and filters them by name and project`, async () => {
      const all = await at("GET", "/rest/agile/1.0/board");
      expect(all.json).toMatchObject({ startAt: 0, total: 4, isLast: true });
      expect(all.json.values.map((b: any) => b.id)).toEqual([1, 2, 3, 4]);
      expect(all.json.values[0]).toMatchObject({ name: "ORBIT board", type: "kanban", location: { projectKey: "ORBIT" } });
      expect(f.requests.at(-1)?.path).toBe("/rest/agile/1.0/board");
      expect((await at("GET", "/rest/agile/1.0/board?name=sprint")).json.values.map((b: any) => b.id)).toEqual([2, 3]);
      expect((await at("GET", "/rest/agile/1.0/board?projectKeyOrId=ORBIT")).json.values.map((b: any) => b.id)).toEqual([1, 3]);
      expect((await at("GET", "/rest/agile/1.0/board?projectKeyOrId=NOPE")).status).toBe(404);
    });

    it(`${flavor}: pages boards by startAt and caps a page at 50`, async () => {
      const small = startFakeJira({ flavor, boardPageSize: 2 });
      try {
        const one = await call("GET", "/rest/agile/1.0/board?maxResults=500", { on: small });
        expect(one.json).toMatchObject({ maxResults: 2, total: 4, isLast: false });
        const two = await call("GET", "/rest/agile/1.0/board?startAt=2", { on: small });
        expect(two.json.values.map((b: any) => b.id)).toEqual([3, 4]);
        expect(two.json.isLast).toBe(true);
      } finally { await small.stop(); }
    });

    it(`${flavor}: a board's configuration gives its columns in order, empty ones kept, and its filter and sub-query`, async () => {
      const r = await at("GET", "/rest/agile/1.0/board/1/configuration");
      expect(r.status).toBe(200);
      expect(r.json.filter.id).toBe("10010");
      expect(r.json.subQuery).toEqual({ query: "issuetype != Epic" });
      expect(r.json.columnConfig.columns.map((c: any) => [c.name, c.statuses.map((s: any) => s.id)])).toEqual([
        ["Backlog", []], ["To Do", ["1"]], ["Doing", ["2", "3"]], ["QA", ["4"]], ["Done", ["5"]],
      ]);
      expect(r.json.location).toMatchObject({ type: "project", key: "ORBIT" });
      expect((await at("GET", "/rest/agile/1.0/board/2/configuration")).json.subQuery).toBeUndefined();
      expect((await at("GET", "/rest/agile/1.0/board/99/configuration")).status).toBe(404);
      expect((await at("GET", "/rest/agile/1.0/board/99")).status).toBe(404);
    });

    it(`${flavor}: the deprecated board card list is not served`, async () => {
      expect((await at("GET", "/rest/agile/1.0/board/1/issue")).status).toBe(404);
    });

    it(`${flavor}: a filter by id, the favourites, and one that is not visible`, async () => {
      expect((await at("GET", "/filter/10010")).json).toMatchObject({ id: "10010", name: "ORBIT board filter", jql: "project = ORBIT ORDER BY Rank ASC" });
      expect((await at("GET", "/filter/favourite")).json.map((x: any) => x.id)).toEqual(["10020", "10030"]);
      expect((await at("GET", "/filter/10040")).status).toBe(404);
      expect((await at("GET", "/filter/55555")).status).toBe(404);
    });

    it(`${flavor}: the JQL reader takes status in (ids or names), a bracketed group, Rank order and issuetype`, async () => {
      expect(await keys("(project = ORBIT) AND status in (4, 5) ORDER BY Rank ASC")).toEqual(["ORBIT-1044", "ORBIT-1045"]);
      expect(await keys('project = ORBIT AND status in ("QA", "done")')).toEqual(["ORBIT-1044", "ORBIT-1045"]);
      expect(await keys("(project = ORBIT AND status in (1, 2)) AND (issuetype != Epic) ORDER BY Rank ASC"))
        .toEqual(["ORBIT-1001", "ORBIT-1042", "ORBIT-1046", "ORBIT-1050"]);
      expect(await keys("project = ORBIT AND status in (2) ORDER BY Rank ASC")).toEqual(["ORBIT-1000", "ORBIT-1042"]);
    });

    it(`${flavor}: a clause it cannot read is an error, never an empty answer`, async () => {
      const r = await keys("project = ORBIT AND (sprint in openSprints())");
      expect(JSON.stringify(r)).toContain("does not understand");
    });
  }
});

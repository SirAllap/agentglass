/*
 * "Your turn": which inbox rows wait on the person, and what it costs to know.
 *
 * Two things are pinned here. The decision — a person writing on your pull
 * request is your turn, a coverage bot doing it is not, and a review that asks
 * for changes says so — on fixtures shaped like what GitHub returns. And the
 * price: a stable inbox costs no request on top of the list's own, and a
 * changed row is asked about alone, measured against a stub `gh` in a child
 * process (the real binary is resolved once from the PATH the process started
 * with, so a stub has to be there before it starts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTurn, factsFrom, isHumanAuthor, snippetOf, turnQuery, type TurnEvent, type TurnFacts, type TurnNote } from "../src/ghinbox-turn.ts";

const T = (m: number) => Date.parse("2026-08-19T10:00:00Z") + m * 60_000;
const person = (by: string, m: number, text = "", review?: string): TurnEvent => ({ by, human: true, at: T(m), text, ...(review ? { review } : null) });
const bot = (by: string, m: number, text = ""): TurnEvent => ({ by, human: false, at: T(m), text });

const own = (events: TurnEvent[], lastRead = T(0)): TurnFacts =>
  ({ reason: "author", type: "PullRequest", viewer: "me-dev", lastRead, opener: "me-dev", events });

describe("who wrote it", () => {
  test("a person is a User; a Bot, or a login ending in [bot], is not", () => {
    expect(isHumanAuthor("User", "riley-dev")).toBe(true);
    expect(isHumanAuthor("Bot", "review-bot")).toBe(false);
    expect(isHumanAuthor("User", "ci-app[bot]")).toBe(false);
    // Code scanning reviews as a plain login with no suffix (measured in prs.ts).
    expect(isHumanAuthor("User", "github-advanced-security")).toBe(false);
    // A deleted account has no author at all: nobody to be waiting on.
    expect(isHumanAuthor(undefined, undefined)).toBe(false);
  });
});

describe("your own pull request", () => {
  test("a person commenting after you last read it is your turn", () => {
    expect(classifyTurn(own([person("jo-acme", 5, "Looks right to me,\n one nit on the index name.", "COMMENTED")])))
      .toEqual({ kind: "person", by: "jo-acme", snippet: "Looks right to me, one nit on the index name." });
  });

  test("a review that asks for changes says so", () => {
    expect(classifyTurn(own([person("sam-orbit", 5, "The timeout path has no test yet.", "CHANGES_REQUESTED")])))
      .toEqual({ kind: "changes", by: "sam-orbit", snippet: "The timeout path has no test yet." });
  });

  test("only the latest review counts: changes requested, then approved, is not blocked", () => {
    const turn = classifyTurn(own([
      person("sam-orbit", 5, "Needs a test.", "CHANGES_REQUESTED"),
      person("sam-orbit", 9, "Thanks, this is fine.", "APPROVED"),
    ]));
    expect(turn?.kind).toBe("person");
  });

  test("one reviewer approving does not lift another's request for changes", () => {
    const turn = classifyTurn(own([
      person("sam-orbit", 5, "Needs a test.", "CHANGES_REQUESTED"),
      person("jo-acme", 9, "Looks good.", "APPROVED"),
    ]));
    expect(turn).toMatchObject({ kind: "changes", by: "sam-orbit" });
  });

  test("a block older than your last read still stands when somebody else writes", () => {
    const turn = classifyTurn(own([
      person("sam-orbit", -20, "Needs a test.", "CHANGES_REQUESTED"),
      person("jo-acme", 4, "One question.", "COMMENTED"),
    ]));
    expect(turn).toMatchObject({ kind: "changes", by: "sam-orbit" });
  });

  test("only bots wrote: a bot turn, which the view counts but never lists", () => {
    expect(classifyTurn(own([bot("review-bot", 5, "Automated review: 2 suggestions."), bot("ci-app[bot]", 7, "Coverage 91.4 %.")])))
      .toEqual({ kind: "bot", by: "ci-app[bot]", snippet: "Coverage 91.4 %." });
  });

  test("a bot and a person: the person decides", () => {
    const turn = classifyTurn(own([person("jo-acme", 4, "One question."), bot("ci-app[bot]", 6, "Coverage 91.4 %.")]));
    expect(turn).toMatchObject({ kind: "person", by: "jo-acme" });
  });

  test("what you wrote yourself, or wrote before you last read it, is nothing new", () => {
    expect(classifyTurn(own([person("me-dev", 5, "Pushed a fix.")]))).toBeUndefined();
    expect(classifyTurn(own([person("jo-acme", -3, "Old news.")]))).toBeUndefined();
    expect(classifyTurn(own([]))).toBeUndefined();
  });

  test("a thread you never read counts everything on it", () => {
    expect(classifyTurn(own([person("jo-acme", -3, "Hello.")], 0))?.kind).toBe("person");
  });

  test("somebody else's pull request you merely follow is not your turn", () => {
    for (const reason of ["comment", "subscribed", "state_change", "ci_activity", "manual", "assign"]) {
      expect(classifyTurn({ ...own([person("jo-acme", 5, "Hi.")]), reason, opener: "jo-acme" })).toBeUndefined();
    }
  });

  test("an issue of yours is not a pull request of yours", () => {
    expect(classifyTurn({ ...own([person("jo-acme", 5, "Hi.")]), type: "Issue" })).toBeUndefined();
  });
});

describe("the reasons GitHub already settles", () => {
  const other = (reason: string, events: TurnEvent[] = []): TurnFacts =>
    ({ reason, type: "PullRequest", viewer: "me-dev", lastRead: T(0), opener: "riley-dev", events });

  test("a review somebody asked for names who opened the pull request", () => {
    expect(classifyTurn(other("review_requested"))).toEqual({ kind: "review", by: "riley-dev" });
  });

  test("a mention quotes the newest thing somebody else wrote since you read it", () => {
    expect(classifyTurn({ ...other("mention", [person("riley-dev", 3, "@me-dev does this match staging?")]), type: "Issue" }))
      .toEqual({ kind: "mention", by: "riley-dev", snippet: "@me-dev does this match staging?" });
  });

  test("a mention quotes the person who wrote it, not a bot that wrote after them", () => {
    const turn = classifyTurn(other("mention", [person("riley-dev", 3, "@me-dev ping"), bot("ci-app[bot]", 5, "Coverage 91.4 %.")]));
    expect(turn).toEqual({ kind: "mention", by: "riley-dev", snippet: "@me-dev ping" });
  });

  test("a mention with no comment newer than your read falls back to the opener", () => {
    expect(classifyTurn(other("team_mention"))).toEqual({ kind: "mention", by: "riley-dev" });
  });
});

describe("what a row quotes", () => {
  test("one line, cut with an ellipsis, never more than asked", () => {
    const long = snippetOf("word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(110);
    expect(long.endsWith("…")).toBe(true);
    expect(long.includes("\n")).toBe(false);
    expect(snippetOf("  short\n\nthing ")).toBe("short thing");
  });
});

/* GitHub's own GraphQL shape for one own pull request. */
const gql = {
  author: { __typename: "User", login: "me-dev" },
  comments: { nodes: [{ author: { __typename: "Bot", login: "ci-app" }, bodyText: "Coverage 91.4 %.", createdAt: "2026-08-19T10:07:00Z" }] },
  reviews: { nodes: [{ author: { __typename: "User", login: "sam-orbit" }, state: "CHANGES_REQUESTED", bodyText: "Needs a test.", submittedAt: "2026-08-19T10:05:00Z" }] },
};
const note: TurnNote = { id: "1", at: T(9), lastRead: T(0), unread: true, reason: "author", type: "PullRequest", repo: "acme/orbit", number: 1038 };

describe("from GitHub's answer to a decision", () => {
  test("Bot and User come from __typename, so a bot with a friendly login is still a bot", () => {
    const facts = factsFrom(note, "me-dev", gql);
    expect(facts.events.map((e) => [e.by, e.human])).toEqual([["ci-app", false], ["sam-orbit", true]]);
    expect(classifyTurn(facts)).toMatchObject({ kind: "changes", by: "sam-orbit" });
  });

  test("an event with no author (a deleted account) is dropped, not guessed at", () => {
    const facts = factsFrom(note, "me-dev", { comments: { nodes: [{ author: null, bodyText: "x", createdAt: "2026-08-19T10:07:00Z" }] } });
    expect(facts.events).toEqual([]);
  });
});

describe("the one request", () => {
  test("every row is an alias of the same query, and the repository is quoted, not spliced", () => {
    const q = turnQuery([
      note,
      { ...note, id: "2", type: "Issue", number: 1029, reason: "mention" },
    ]);
    expect(q.match(/^\{viewer\{login\} /)).not.toBeNull();
    expect(q).toContain('r0:repository(owner:"acme",name:"orbit"){pullRequest(number:1038)');
    expect(q).toContain('r1:repository(owner:"acme",name:"orbit"){issue(number:1029)');
    expect(q.split("repository(").length - 1).toBe(2);
  });

  test("a review request only asks who opened the pull request", () => {
    const q = turnQuery([{ ...note, reason: "review_requested" }]);
    expect(q).toContain("pullRequest(number:1038){author{__typename login}}");
    expect(q).not.toContain("comments(");
  });
});

/* ── the price, against a stub `gh` ─────────────────────────────────────── */

let dir = "";
const listBody = (extra: object[] = []) => JSON.stringify([
  { id: "1", unread: true, reason: "review_requested", updated_at: "2026-08-19T10:00:00Z", last_read_at: null, repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1042 Retry webhook delivery", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1042" } },
  { id: "2", unread: true, reason: "author", updated_at: "2026-08-19T10:01:00Z", last_read_at: "2026-08-19T09:00:00Z", repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1031 Cap the retry queue", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1038" } },
  { id: "3", unread: true, reason: "author", updated_at: "2026-08-19T10:02:00Z", last_read_at: "2026-08-19T09:00:00Z", repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1027 Move the delivery log", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1035" } },
  { id: "4", unread: true, reason: "comment", updated_at: "2026-08-19T10:03:00Z", last_read_at: null, repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1050 Somebody else's", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1050" } },
  { id: "5", unread: true, reason: "subscribed", updated_at: "2026-08-19T10:04:00Z", last_read_at: null, repository: { full_name: "acme/orbit" }, subject: { title: "v2.4.0", type: "Release", url: "https://api.github.com/repos/acme/orbit/releases/99" } },
  // Read after its last update: nothing new on it, so nothing to ask.
  { id: "7", unread: false, reason: "author", updated_at: "2026-08-19T10:05:00Z", last_read_at: "2026-08-19T10:30:00Z", repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1012 Old news", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1012" } },
  // A review request already read stays a row by its reason, and costs no question.
  { id: "8", unread: false, reason: "review_requested", updated_at: "2026-08-19T10:06:00Z", last_read_at: "2026-08-19T10:07:00Z", repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1013 Old request", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1013" } },
  ...extra,
]);

/** The stub's whole world: what GitHub would say about each pull request. */
const world = {
  1042: { author: { __typename: "User", login: "riley-dev" }, comments: { nodes: [] }, reviews: { nodes: [] } },
  1038: { author: { __typename: "User", login: "me-dev" }, comments: { nodes: [] }, reviews: { nodes: [{ author: { __typename: "User", login: "sam-orbit" }, state: "CHANGES_REQUESTED", bodyText: "The timeout path has no test yet.", submittedAt: "2026-08-19T10:00:30Z" }] } },
  1035: { author: { __typename: "User", login: "me-dev" }, comments: { nodes: [{ author: { __typename: "Bot", login: "ci-app" }, bodyText: "Coverage 91.4 %.", createdAt: "2026-08-19T10:01:30Z" }] }, reviews: { nodes: [] } },
  1060: { author: { __typename: "User", login: "me-dev" }, comments: { nodes: [{ author: { __typename: "User", login: "jo-acme" }, bodyText: "Approach is fine.", createdAt: "2026-08-19T10:06:00Z" }] }, reviews: { nodes: [] } },
};

const STUB = `
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const dir = process.env.STUB_DIR!;
const a = process.argv.slice(2);
if (a[0] === "api" && a[1] === "graphql") {
  const q = a.find((x) => x.startsWith("query="))!;
  appendFileSync(dir + "/log", "graphql " + (q.match(/repository\\(/g) ?? []).length + "\\n");
  const world = JSON.parse(readFileSync(dir + "/world.json", "utf8"));
  const data: Record<string, unknown> = { viewer: { login: "me-dev" } };
  for (const m of q.matchAll(/(r\\d+):repository\\(owner:"[^"]+",name:"[^"]+"\\)\\{(pullRequest|issue)\\(number:(\\d+)\\)/g)) {
    data[m[1]] = { [m[2]]: world[m[3]] ?? null };
  }
  console.log(JSON.stringify({ data }));
} else {
  appendFileSync(dir + "/log", "list\\n");
  const body = readFileSync(dir + "/list.json", "utf8");
  const etag = '"' + body.length + '"';
  if (a.includes("If-None-Match: " + etag)) { console.error("gh: HTTP 304"); process.stdout.write("HTTP/2.0 304 Not Modified\\r\\n\\r\\n"); process.exit(1); }
  process.stdout.write("HTTP/2.0 200 OK\\r\\netag: " + etag + "\\r\\n\\r\\n" + body);
}
`;

// The driver: the same calls a panel makes, with the clock moved past the TTL
// where the test wants a conditional read rather than the cache.
const DRIVER = `
import { inbox } from "${join(import.meta.dir, "../src/ghinbox.ts")}";
import { appendFileSync } from "node:fs";
const dir = process.env.STUB_DIR!;
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const mark = (s: string) => appendFileSync(dir + "/log", "-- " + s + "\\n");
const seen: Record<string, unknown> = {};
mark("first"); seen.first = (await inbox()).items;
mark("same"); await inbox();
skew += 100_000;
mark("after ttl, nothing changed"); await inbox();
skew += 100_000;
await Bun.write(dir + "/list.json", process.env.SECOND_LIST!);
mark("one row changed"); seen.changed = (await inbox()).items;
console.log(JSON.stringify(seen));
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agx-turn-"));
  await writeFile(join(dir, "stub.ts"), STUB);
  await writeFile(join(dir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "stub.ts")}" "$@"\n`);
  await chmod(join(dir, "gh"), 0o755);
  await writeFile(join(dir, "driver.ts"), DRIVER);
  await writeFile(join(dir, "world.json"), JSON.stringify(world));
  await writeFile(join(dir, "list.json"), listBody());
}, 20_000);

afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function runDriver(secondList: string) {
  await writeFile(join(dir, "list.json"), listBody());
  await writeFile(join(dir, "log"), "");
  const proc = Bun.spawn([process.execPath, join(dir, "driver.ts")], {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`, STUB_DIR: dir, SECOND_LIST: secondList,
      HOME: dir, XDG_CONFIG_HOME: join(dir, "c"), XDG_DATA_HOME: join(dir, "d"), XDG_CACHE_HOME: join(dir, "k"),
      AGENTGLASS_STATE_DIR: join(dir, "s"), AGENTGLASS_DB: join(dir, "db.sqlite"), TMUX_TMPDIR: dir,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`driver exited ${code}: ${err.slice(0, 400)}`);
  const log = (await Bun.file(join(dir, "log")).text()).trim().split("\n");
  const phases: Record<string, string[]> = {};
  let cur = "";
  for (const l of log) { if (l.startsWith("-- ")) phases[(cur = l.slice(3))] = []; else phases[cur]?.push(l); }
  return { phases, seen: JSON.parse(out) as Record<string, { id: string; turn?: { kind: string; by?: string; snippet?: string } }[]> };
}

describe("what it costs", () => {
  // A new row: a person commented on another pull request of yours.
  const changed = JSON.parse(listBody()) as { id: string }[];
  changed.push({
    id: "6", unread: true, reason: "author", updated_at: "2026-08-19T10:06:30Z", last_read_at: "2026-08-19T09:00:00Z",
    repository: { full_name: "acme/orbit" }, subject: { title: "ORBIT-1044 Add jitter", type: "PullRequest", url: "https://api.github.com/repos/acme/orbit/pulls/1060" },
  } as never);

  test("first read: one list, one graphql for every row that needs it; the rest need none", async () => {
    const { phases, seen } = await runDriver(JSON.stringify(changed));
    // Rows 1, 2 and 3 need the network (a review's opener, two of your own pull
    // requests); the comment, the release and the pull request already read past
    // its last update do not, and are not in the query.
    expect(phases["first"]).toEqual(["list", "graphql 3"]);
    const by = Object.fromEntries(seen.first.map((i) => [i.id, i.turn]));
    expect(by["1"]).toEqual({ kind: "review", by: "riley-dev" });
    expect(by["2"]).toEqual({ kind: "changes", by: "sam-orbit", snippet: "The timeout path has no test yet." });
    expect(by["3"]).toEqual({ kind: "bot", by: "ci-app", snippet: "Coverage 91.4 %." });
    expect(by["4"]).toBeUndefined();
    expect(by["5"]).toBeUndefined();
    expect(by["7"]).toBeUndefined();
    expect(by["8"]).toEqual({ kind: "review" });
  }, 30_000);

  test("stable inbox: 0 requests inside the TTL, and only the conditional list read after it", async () => {
    const { phases } = await runDriver(JSON.stringify(changed));
    expect(phases["same"]).toEqual([]);
    expect(phases["after ttl, nothing changed"]).toEqual(["list"]);
    expect(phases["after ttl, nothing changed"].some((l) => l.startsWith("graphql"))).toBe(false);
  }, 30_000);

  test("one row changed: the list is read again and ONLY that row is asked about", async () => {
    const { phases, seen } = await runDriver(JSON.stringify(changed));
    expect(phases["one row changed"]).toEqual(["list", "graphql 1"]);
    const by = Object.fromEntries(seen.changed.map((i) => [i.id, i.turn]));
    expect(by["6"]).toEqual({ kind: "person", by: "jo-acme", snippet: "Approach is fine." });
    // The rows already known kept their answer without being asked again.
    expect(by["2"]?.kind).toBe("changes");
  }, 30_000);
});

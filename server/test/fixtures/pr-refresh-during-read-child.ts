/*
 * The child side of pr-refresh-during-read.test.ts: the list code against a slow,
 * counted GitHub. Runs in its own process because `gh` is found with the PATH the
 * process started with, and the stub has to be first on it.
 *
 * Every GraphQL request goes through `fetch` to api.github.com/graphql (the
 * token comes from the stub `gh auth token`), so replacing `fetch` before the
 * module loads sees all of them. It prints what each step asked, as JSON.
 */
export {};

const asked: string[] = [];

const node = (n: number) => ({
  number: n, title: `Change ${n}`, url: `https://github.com/acme/orbit/pull/${n}`,
  state: "OPEN", isDraft: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
  baseRefName: "main", headRefName: `change-${n}`, author: { login: "octo-dev" },
  labels: { nodes: [] }, assignees: { nodes: [] }, milestone: null,
  additions: 3, deletions: 1, changedFiles: 1, reviewDecision: null, mergeable: "MERGEABLE",
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { oid: `sha${n}`, committedDate: "2026-01-02T00:00:00Z", statusCheckRollup: {
    state: "SUCCESS",
    contexts: { checkRunCountsByState: [{ state: "SUCCESS", count: 2 }], statusContextCountsByState: [] },
  } } }] },
  comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { totalCount: 0, nodes: [] },
});
const search = (ns: number[]) => ({ issueCount: ns.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: ns.map(node) });

let served = [1, 2];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.github.com/graphql")) throw new Error(`unexpected fetch: ${url}`);
  const { query } = JSON.parse(String(init?.body ?? "{}")) as { query: string };
  const both = /\bm:\s*search\(/.test(query) && /\br:\s*search\(/.test(query);
  const full = /reviewThreads/.test(query) && /labels\(/.test(query);
  asked.push(both ? (full ? "queues" : "probe") : /search\(/.test(query) ? "list" : "other");
  const snapshot = served.slice(); // what GitHub says when the request ARRIVES
  await Bun.sleep(400);
  const data = both ? { m: search(snapshot), r: search([3]) } : { search: search(snapshot) };
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { listPrs, __invalidate } = await import("../../src/prs.ts");
const root = process.argv[2]!;

/** Wait until neither queue is loading, reading only what is cached. */
async function settled(filter: "mine" | "review") {
  for (let i = 0; i < 300; i++) {
    const r = await listPrs(root, filter, "open");
    if (!r.loading && !r.checksPending) return r;
    await Bun.sleep(20);
  }
  throw new Error("the list never settled");
}

const out: Record<string, unknown> = {};
await listPrs(root, "mine", "open");           // a poll: read #1 starts
await Bun.sleep(200);
served = [1, 2, 9];                             // somebody opens #9 while it is running
await listPrs(root, "mine", "open", true);      // then presses Refresh
const got = await settled("mine");
out.rows = got.prs.map((p) => p.number);
out.asked = asked.slice();
// A write (a reopen) lands while a read is running: what that read stored predates it.
asked.length = 0;
served = [1, 2];
await listPrs(root, "mine", "open", true);
await Bun.sleep(200);
served = [1, 2, 9];
await __invalidate(root);
for (let i = 0; i < 300 && asked.length < 2; i++) await Bun.sleep(20);
await Bun.sleep(600);
const after = await settled("mine");
out.rowsAfterWrite = after.prs.map((p) => p.number);
out.askedAfterWrite = asked.length;
console.log(JSON.stringify(out));
process.exit(0);

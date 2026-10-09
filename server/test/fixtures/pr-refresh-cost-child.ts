/*
 * The child side of pr-refresh-cost.test.ts: the list code against a counted
 * GitHub. Runs in its own process because `gh` is found with the PATH the
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

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.github.com/graphql")) throw new Error(`unexpected fetch: ${url}`);
  const { query } = JSON.parse(String(init?.body ?? "{}")) as { query: string };
  const both = /\bm:\s*search\(/.test(query) && /\br:\s*search\(/.test(query);
  const full = /reviewThreads/.test(query) && /labels\(/.test(query);
  asked.push(both ? (full ? "queues" : "probe") : /search\(/.test(query) ? "list" : "other");
  const data = both ? { m: search([1, 2]), r: search([3]) } : { search: search([1, 2]) };
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { listPrs } = await import("../../src/prs.ts");
const root = process.argv[2]!;

/** Wait for both queues to land, reading only what is cached. */
async function settled() {
  for (let i = 0; i < 200; i++) {
    const [a, b] = await Promise.all([listPrs(root, "mine", "open"), listPrs(root, "review", "open")]);
    if (!a.loading && !b.loading && !a.checksPending && !b.checksPending) return { mine: a, review: b };
    await Bun.sleep(20);
  }
  throw new Error("the lists never settled");
}

const out: Record<string, unknown> = {};

// First load: what the panel asks on mount — the table (Needs my review by
// default) and the board's two lists.
await Promise.all([listPrs(root, "review", "open"), listPrs(root, "mine", "open"), listPrs(root, "review", "open")]);
let got = await settled();
out.first = asked.splice(0);
out.firstRows = { mine: got.mine.prs.map((p) => p.number), review: got.review.prs.map((p) => p.number) };

// Refresh with the board shown: the table forced (it is a queue) and the
// board's two forced.
await Promise.all([listPrs(root, "review", "open", true), listPrs(root, "mine", "open", true), listPrs(root, "review", "open", true)]);
got = await settled();
out.refresh = asked.splice(0);
out.refreshRows = {
  mine: got.mine.prs.map((p) => p.number), review: got.review.prs.map((p) => p.number),
  checksLoaded: [...got.mine.prs, ...got.review.prs].every((p) => p.checksLoaded === true),
  totals: [got.mine.total, got.review.total],
};

console.log(JSON.stringify(out));
process.exit(0);

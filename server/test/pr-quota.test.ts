/*
 * What the server may spend from the account's GraphQL budget on its own.
 *
 * 5000 points an hour, per account, shared with every other tool signed in as
 * the same person; a request costs one at the least. The list refresh was two
 * requests per queue every 90 seconds and the counts searched the whole
 * repository five ways. These pin the floors against source.
 */
import { describe, expect, it } from "bun:test";

const SRC = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();

/** One function's body: from its signature to its own closing brace. */
function body(sig: string): string {
  const at = SRC.indexOf(sig);
  if (at < 0) throw new Error(`missing: ${sig}`);
  // The body opens at the first brace ending a line: a return type such as
  // `Promise<{ base: string } | null>` has braces of its own.
  const open = SRC.indexOf(" {\n", at) + 1;
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`unclosed: ${sig}`);
}
const literal = (name: string): string => {
  const m = SRC.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`missing: ${name}`);
  return m[1];
};

describe("GitHub GraphQL budget", () => {
  it("keeps a list at least two minutes", () => {
    const m = SRC.match(/const LIST_TTL_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(120_000);
  });

  it("counts only the viewer's two queues", () => {
    const q = literal("VIEW_COUNT_QUERY");
    expect(q.match(/search\(/g)?.length).toBe(2);
    expect(q).not.toMatch(/\b(failing|ready|all):/);
    expect(q).toContain("review:");
    expect(q).toContain("mine:");
  });

  it("probes both queues in one request, each scoped to the viewer", () => {
    const q = literal("PROBE_QUERY");
    expect(q.match(/search\(/g)?.length).toBe(2);
    const probe = body("async function probeOpen(");
    expect(probe).toContain('searchExpr(repo, "mine", "open")');
    expect(probe).toContain('searchExpr(repo, "review", "open")');
    expect(probe).toContain("probeInflight.get(");
  });

  it("asks the probe before paying for a queue read, and Refresh skips it", () => {
    const refresh = body("function refreshList(");
    const probeAt = refresh.indexOf("await probeOpen(repo)");
    const readAt = refresh.indexOf("await readQueues(repo)");
    expect(probeAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(probeAt);
    expect(refresh).toContain("if (!force && prev?.fp) {");
  });

  /* GitHub prices a query as page size times the connections under each row,
     over a hundred. Measured with `rateLimit(dryRun:true)`: the checks query
     was 17 points with a count under each of sixty reviews and is 1 without;
     both queues together are 3 at twenty rows and 4 at twenty-five. */
  it("keeps the queue read inside three points", () => {
    const page = SRC.match(/const LIST_PAGE = (\d+);/);
    expect(page).not.toBeNull();
    expect(Number(page![1])).toBeLessThanOrEqual(20);
    const talk = literal("SEL_TALK");
    const reviews = talk.slice(talk.indexOf("reviews(") + "reviews(".length, talk.indexOf("reviewThreads("));
    expect(reviews).not.toMatch(/\w+\((first|last):/);
    const q = literal("QUEUES_QUERY");
    expect(q.match(/search\(/g)?.length).toBe(2);
    const read = body("function readQueues(");
    expect(read).toContain('searchExpr(repo, "mine", "open")');
    expect(read).toContain('searchExpr(repo, "review", "open")');
    expect(read).toContain("queuesInflight.get(");
  });

  it("reads a pull request's branches from memory before asking gh", () => {
    const fn = body("export async function prBranches(");
    const known = fn.indexOf("knownBranches(");
    const gh = fn.indexOf('"pr", "view"');
    expect(known).toBeGreaterThan(-1);
    expect(gh).toBeGreaterThan(known);
  });
});

/*
 * The lock on the poll.
 *
 * This file exists because the cost of a docker field is invisible in review.
 * Asking `docker ps` for `{{.Size}}` looks like one more column and makes the
 * daemon walk every container's filesystem layers — measured in this repo at
 * **19ms to 4.9s**, on a call that runs every couple of seconds on the same
 * thread that pumps the terminal's PTY. The comment above PS_COLUMNS says so;
 * comments do not fail builds.
 *
 * So the rule is written down as a test: the fast lane may ask for cheap fields
 * and nothing else, and anything expensive belongs to the medium lane (batched,
 * slower) or the slow lane (on demand, with its age shown).
 *
 * If you are here because this test failed: you have not necessarily done
 * anything wrong — you have added something that has to go in another lane.
 */
import { describe, expect, test } from "bun:test";

const SRC = new URL("../src/docker.ts", import.meta.url).pathname;
const source = await Bun.file(SRC).text();

/** The block that defines what `docker ps` is asked for. */
const psColumns = /const PS_COLUMNS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? "";
/** Every `dockerAsync([...])` invocation in the file, as written. */
const calls = [...source.matchAll(/dockerAsync\(\[([\s\S]*?)\]/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());

describe("what the poll is allowed to ask for", () => {
  test("PS_COLUMNS is still where the poll's shape is decided", () => {
    // A guard against this whole file quietly testing nothing after a refactor.
    expect(psColumns).toContain("{{.ID}}");
    expect(psColumns).toContain("{{.State}}");
  });

  /* The one that cost 4.9 seconds. `docker ps` reports size only when asked,
     and asking is a single innocuous-looking word. */
  test("it does not ask for Size, in any spelling", () => {
    expect(psColumns).not.toMatch(/\{\{\s*\.Size\s*\}\}/);
    expect(source).not.toMatch(/"ps"[^)]*"--size"/);
    expect(source).not.toMatch(/"--size"[^)]*"ps"/);
  });

  /* `docker ps --all --size` and `docker system df` are the two calls on this
     surface that scale with the size of the machine rather than the number of
     containers. Neither belongs on a two-second clock. */
  test("nothing in the poll walks the filesystem", () => {
    const pollCalls = calls.filter((c) => c.startsWith('"ps"') || c.startsWith('"images"') || c.startsWith('"volume"') || c.startsWith('"network"'));
    expect(pollCalls.length).toBeGreaterThan(0);
    for (const c of pollCalls) {
      expect(c).not.toContain("--size");
      expect(c).not.toContain("system");
      expect(c).not.toContain(" df");
    }
  });

  test("the poll's containers still come from exactly one docker call", () => {
    // Twelve containers must not become twelve processes. If a per-container
    // call is needed, it goes in the medium lane below — batched.
    const body = /async function containers\(\)[\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(body).toContain("dockerAsync");
    expect([...body.matchAll(/dockerAsync\(/g)]).toHaveLength(1);
  });
});

describe("the medium lane stays slower than the poll", () => {
  const ttl = (name: string) => Number(new RegExp(`const ${name} = ([\\d_]+)`).exec(source)?.[1]?.replace(/_/g, "") ?? NaN);

  test("both clocks are still declared where this test can see them", () => {
    expect(ttl("OVERVIEW_CACHE_MS")).toBeGreaterThan(0);
    expect(ttl("FACTS_TTL_MS")).toBeGreaterThan(0);
  });

  /* The medium lane's whole justification is that it runs rarely. At parity
     with the poll it is just an inspect per poll wearing a hat. */
  test("the batched inspect runs at least five times less often", () => {
    expect(ttl("FACTS_TTL_MS")).toBeGreaterThanOrEqual(ttl("OVERVIEW_CACHE_MS") * 5);
  });

  test("and it inspects every container in one call, not one call each", () => {
    const body = /async function containerFacts\([\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(body).toContain('dockerAsync(["inspect", ...wanted]');
    expect([...body.matchAll(/dockerAsync\(/g)]).toHaveLength(1);
  });

  test("enriching a list spawns nothing per container", () => {
    // The owner is resolved by reading .git/HEAD (a file), the ports out of the
    // string ps already returned. Neither may become a process.
    const body = /async function enrich\([\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(body).not.toContain("dockerAsync");
    expect(body).not.toContain("Bun.spawn");
    expect([...body.matchAll(/containerFacts\(/g)]).toHaveLength(1);
  });
});

describe("every answer carries its age", () => {
  test("the overview says when it was gathered and how fresh it is", () => {
    expect(source).toMatch(/freshness: "live"/);
    expect(source).toMatch(/freshness: "stale"/);
    expect(source).toMatch(/freshness: (?:inconclusive \? "retrying" : "down"|"retrying")/);
  });
});

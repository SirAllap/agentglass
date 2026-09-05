/*
 * A CARD THE ID LOOKUP FOUND, CALLED "NOTHING FOUND".
 *
 * Searching a bare/prefixed id fires two things at once: `clickupFind`, which
 * asks the workspace directly for that one card, and the sweep, which reads
 * the last N cards and rarely holds one from days ago. `clickupFind` was
 * fired with `void` and never waited on, so the sweep's own "nothing found"
 * branch checked `cur.rows.length` on whatever schedule it landed on — before
 * or after `clickupFind`'s `setResults` had run was a coin flip. Losing the
 * flip meant a banner reading "Nothing in the last 0 cards matches […]" over
 * a list that, a beat later, had the row in it: clearing the box and
 * reopening "Looked up" showed it, Ctrl+F found it — the search had worked,
 * the sentence about it hadn't.
 *
 * Read from source, same as search-abort.test.ts and for the same reason:
 * this lives inside a React effect and what has to hold is the ORDER two
 * promises are awaited in, which a render cannot observe from outside.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the id lookup and the sweep's verdict", () => {
  test("the id lookup's promise is kept, not void-d and forgotten", () => {
    expect(bare).toContain("let idLookup: Promise<void> | null = null;");
    expect(bare).toMatch(/idLookup = api\.clickupFind\(asked\)/);
  });

  test("it is awaited before the sweep decides the list is empty", () => {
    const notFound = bare.slice(bare.indexOf("const found = all;"), bare.indexOf("const found = all;") + 600);
    expect(notFound, "the sweep can still say nothing found before the id lookup lands")
      .toContain("if (idLookup) await idLookup;");
    /* Ordering, not just presence: the await has to come before the read it
       protects, or it is just as racy with an extra line. */
    expect(notFound.indexOf("if (idLookup) await idLookup;"))
      .toBeLessThan(notFound.indexOf("!cur.rows.length"));
  });

  test("an abort during that wait still leaves quietly", () => {
    const notFound = bare.slice(bare.indexOf("if (idLookup) await idLookup;"), bare.indexOf("if (idLookup) await idLookup;") + 200);
    expect(notFound).toContain("if (!mine() || ac.signal.aborted) return;");
  });
});

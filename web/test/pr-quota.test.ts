/*
 * What the pull-request panel may spend from GitHub without being asked.
 *
 * Every GitHub read here is a GraphQL request against ONE account's budget of
 * 5000 an hour, shared with every other tool signed in as that person. An idle
 * panel measured about 720 an hour: a twenty-second poll, three states and the
 * next page warmed in the background, and five repository-wide counts for tabs
 * only ever opened by hand. These pin the floors, asserted against source —
 * there is no renderer in this project.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { POLL_MS } from "../src/lib/prSettle.ts";
import { TTL_MS as CARD_PR_TTL_MS } from "../src/lib/cardPrStore.ts";

const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
/** Code only: a comment is allowed to name what was removed. */
const CODE = PANEL.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("pull-request panel GitHub budget", () => {
  it("polls the lists no faster than every two minutes", () => {
    expect(POLL_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("asks no repository-wide count on mount", () => {
    expect(CODE).not.toContain("api.prCounts(");
    expect(CODE).not.toMatch(/viewCounts\.(all|failing|ready)\b/);
  });

  it("warms no other state and prefetches no next page", () => {
    // The old warmers: a list for every state but the visible one, and the
    // cursor's page before Next was pressed.
    expect(CODE).not.toMatch(/api\.prList\(root, filter, st\b/);
    expect(CODE).not.toMatch(/api\.prList\([^)]*\bnext\)/);
  });

  it("loads only Mine and Needs my review without a click", () => {
    const lists = [...CODE.matchAll(/api\.prList\(root, "(\w+)"/g)].map((m) => m[1]);
    expect(lists.length).toBeGreaterThan(0);
    for (const f of lists) expect(["mine", "review"]).toContain(f);
  });

  it("skips a poll while the window is hidden", () => {
    const at = CODE.indexOf("const t = setInterval(tick, POLL_MS)");
    expect(at).toBeGreaterThan(-1);
    const tick = CODE.slice(CODE.lastIndexOf("const tick = () => {", at), at);
    expect(tick).toContain('document.visibilityState === "hidden"');
  });

  it("re-asks a card's pull requests at most every ten minutes", () => {
    expect(CARD_PR_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
  /* One press measured 39 points: the table and the board's two lists each a
     rows and a checks request, and every red card's rollup asked again. The
     server answers both queues from one request; the panel must not undo that
     by forcing a list nobody is looking at or dropping the rollups. */
  it("forces only what is on screen when Refresh is pressed", () => {
    const at = CODE.indexOf("const plan = refreshPlan(selected);");
    expect(at).toBeGreaterThan(-1);
    const press = CODE.slice(at, CODE.indexOf("}} disabled={busy} small", at));
    expect(press).not.toContain("forgetRollups(");
    expect(press).toMatch(/if \(boardShown\) \{\s*boardForce\.current = true;/);
    expect(press).toContain("loadList(!boardShown || tableIsQueue);");
  });
});

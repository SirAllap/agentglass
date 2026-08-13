/*
 * Matching ClickUp's own desktop notification back to a card.
 *
 * Why this exists: ClickUp's app posts the task's TITLE and a sentence about
 * what happened to it — "Alejandro set the status to: READY FOR QA" — with no
 * id and no url, and a D-Bus monitor cannot invoke the notification's own action
 * to ask for one. So those rows behind the bell were the only ones that could
 * not be opened, and the desktop pop-up went to ClickUp's website: the single
 * destination that leaves this app.
 *
 * The watcher already keeps every card it has seen, with its id and its label,
 * in the file it uses to tell a status change from a new assignment. This looks
 * a title up in that. The cases below are the ways a title lookup goes wrong.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardForTitle, __setWatchPath } from "../src/clickupwatch.ts";

const dirs: string[] = [];
afterEach(() => {
  __setWatchPath(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A watch file holding the cards the watcher has seen. */
function watching(seen: Record<string, { status: string; customId?: string; title: string }>): void {
  const dir = mkdtempSync(join(tmpdir(), "agx-watch-"));
  dirs.push(dir);
  const p = join(dir, "clickup-watch.json");
  writeFileSync(p, JSON.stringify({ seen, at: 1 }));
  __setWatchPath(p);
}

const CARDS = {
  "86e2aaa11": { status: "READY FOR QA", customId: "ORBIT-1042", title: "Incarcerated calls skip the Free Plan pause that stops every other call" },
  "86e2bbb22": { status: "IN PROGRESS", customId: "ORBIT-1043", title: "Usage counter resets to zero after a plan change" },
};

describe("which card a notification is about", () => {
  it("finds it by the exact title the notification carried", () => {
    watching(CARDS);
    expect(cardForTitle("Incarcerated calls skip the Free Plan pause that stops every other call"))
      .toEqual({ id: "86e2aaa11", label: "ORBIT-1042" });
  });

  it("finds it when the notification daemon truncated the title", () => {
    /* Which it does — a summary is cut to fit the pop-up, ellipsis included, and
       that is the form this receives. Matching only on equality would have made
       the feature work in a test and never once on the machine. */
    watching(CARDS);
    expect(cardForTitle("Incarcerated calls skip the Free Pla…")).toMatchObject({ label: "ORBIT-1042" });
    expect(cardForTitle("Incarcerated calls skip the Free Pla...")).toMatchObject({ label: "ORBIT-1042" });
  });

  it("ignores case and stray whitespace", () => {
    watching(CARDS);
    expect(cardForTitle("  usage counter resets to zero  after a plan change ")).toMatchObject({ label: "ORBIT-1043" });
  });

  it("refuses to choose when two cards share a title", () => {
    /* Two tickets called "Fix the flaky test" is an ordinary Tuesday. Opening
       the wrong one is worse than opening nothing, because nothing on screen
       tells the reader it happened. */
    watching({
      a: { status: "OPEN", customId: "ORBIT-1", title: "Fix the flaky test" },
      b: { status: "OPEN", customId: "ORBIT-2", title: "Fix the flaky test" },
    });
    expect(cardForTitle("Fix the flaky test")).toBeNull();
  });

  it("refuses a title too short to identify anything", () => {
    // "QA" would resolve to whichever card happened to start with it.
    watching({ a: { status: "OPEN", customId: "ORBIT-1", title: "QA the release" } });
    expect(cardForTitle("QA")).toBeNull();
  });

  it("says nothing about a notification from some other app", () => {
    watching(CARDS);
    expect(cardForTitle("Alejandro sent a message in #engineering")).toBeNull();
  });

  it("falls back to the ClickUp id when a card has no readable label", () => {
    watching({ "86e2ccc33": { status: "OPEN", title: "A card with no custom id at all" } });
    expect(cardForTitle("A card with no custom id at all")).toEqual({ id: "86e2ccc33", label: "86e2ccc33" });
  });

  it("answers nothing rather than throwing on rubbish input", () => {
    watching(CARDS);
    expect(cardForTitle(null)).toBeNull();
    expect(cardForTitle(42)).toBeNull();
    expect(cardForTitle("")).toBeNull();
  });
});

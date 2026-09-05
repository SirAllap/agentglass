/*
 * A page you cannot reach by typing what is on it.
 *
 * The nav filter matches a PAGE by its label plus a hand-written `kw` bag. The
 * row filter then matches the rows on whichever page you are standing on. Those
 * two are only as good as their weakest half: type a word that is on a row but
 * not in that page's `kw`, and the nav hides the page — so the row filter never
 * gets a chance to find it, and the search reports the setting does not exist.
 *
 * Measured, not imagined: typing "scrollback" hid Terminal (which owns the
 * Scrollback rows) and left one result, Pane engine, whose "Restore after
 * reboot" paragraph happens to use the word. The right page was the one taken
 * off screen.
 *
 * So: every row label on a page must be reachable from that page's own `kw`.
 * This reads the labels out of the source rather than a list somebody keeps by
 * hand, because a list kept by hand is the thing that went stale.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

/** `{ id: "x", label: "X", group: "G", kw: "..." }` — the nav's own table. */
function tabKeywords(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*", kw: "([^"]*)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.set(m[1]!, (m[2]! + " " + m[3]!).toLowerCase());
  return out;
}

/** The source between one `{pane === "x" && …}` and the next: everything that
 *  page draws inline. Panes drawn by an imported component contribute nothing
 *  here, which is honest — this guard can only see what is in this file. */
function paneBlocks(): { id: string; body: string }[] {
  const marks = [...src.matchAll(/\{pane === "([a-z-]+)" &&/g)];
  return marks.map((m, i) => ({
    id: m[1]!,
    body: src.slice(m.index!, i + 1 < marks.length ? marks[i + 1]!.index! : src.length),
  }));
}

describe("every setting is reachable from the search box", () => {
  test("a row's label words are in its page's keywords", () => {
    const kw = tabKeywords();
    expect(kw.size).toBeGreaterThan(15);
    const unreachable: string[] = [];
    for (const { id, body } of paneBlocks()) {
      const words = kw.get(id);
      if (words === undefined) continue; // a pane with no nav row of its own
      for (const label of body.match(/\blabel="([^"]{2,60})"/g) ?? []) {
        const text = label.slice(7, -1);
        const missing = (text.match(/[a-zA-Z]{4,}/g) ?? []).filter((w) => !words.includes(w.toLowerCase()));
        if (missing.length) unreachable.push(`${id}: “${text}” — ${missing.join(", ")}`);
      }
    }
    expect(["Add these words to that page's kw so typing them finds it:", ...unreachable].join("\n"))
      .toEqual("Add these words to that page's kw so typing them finds it:");
  });
});

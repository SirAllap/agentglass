/*
 * A card's GitHub and Activity tabs emptied and reloaded when the window came
 * back: the board re-read itself, its tasks were new objects, and the effects
 * keyed on those objects searched GitHub and read the thread again, clearing
 * the list first. Both reads now go through remoteStore (lib/remoteStore.ts,
 * tested generically in remote-store.test.ts); this file checks the source
 * shape that keeps them cache-first and keeps separate cards apart.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const slice = (from: string, to: string) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
  return src.slice(a, b).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
};

describe("CardDetail reads through remoteStore", () => {
  const prsEffect = slice("const key = prsKey(prKey);", "}, [prKey]);");
  it("keys the pull request effect on strings, not on the board's objects", () => {
    expect(src).toContain("}, [prKey]);");
    expect(src).toContain('const prKey = [t.id, t.customId || "", prField, prCwd].join("\\n");');
  });
  it("never empties the list to a new search, only to a card with nothing cached", () => {
    expect(prsEffect).not.toContain("setPrs([])");
    expect(prsEffect).toContain("hit ?? []");
  });
  it("a failed search is never cached, so the next open asks again", () => {
    expect(prsEffect).toContain('throw new Error("the search failed")');
  });
  it("says 'no pull request' only after a search has answered", () => {
    expect(src).toContain("!prs.length && !prsErr && prsLoaded && (");
    expect(src).toContain("!prs.length && !prsErr && !prsLoaded && <div");
  });
  it("reads the thread only through remoteStore, keyed per card id", () => {
    const body = slice("function CardDetail(", "\nfunction ");
    const calls = body.split("api.clickupTask(").length - 1;
    expect(calls).toBe(3); // the mount effect, reread, and the card's own Refresh, each with its own loader
    expect(body).toContain("loadCancellable<CardRead>(key, (signal) => {");
    expect(body).toContain("remoteLoad<CardRead>(threadKey(t.id)");
  });
  it("makes the thread due after a comment or an edit made here", () => {
    expect(slice("const reread = useCallback(", "[t.id, layers, loadReplies]);")).toContain("remoteLoad<CardRead>(threadKey(t.id)");
    expect(src).toContain("remoteMarkStale(threadKey(picked.id)); apply(picked, key, p)");
  });
});

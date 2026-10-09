/*
 * The card list's promises that live in the screen, asserted against its source
 * (there is no renderer here, so a rule about what a screen does is a rule
 * about what it says).
 *
 *   - Typing in the search box and ticking a filter read nothing from the
 *     tracker: the board is read by `load`, and `load` does not depend on
 *     either. A dependency added to it would re-read the board on every key.
 *   - A list the computer has no board for is added first; one it has is not.
 *   - The card screen reports its pull requests to the list only when GitHub
 *     actually answered: a failed search is "not known", not "none".
 */
import { describe, expect, test } from "bun:test";

const screen = await Bun.file(new URL("../app/(tabs)/tasks.tsx", import.meta.url)).text();
const card = await Bun.file(new URL("../app/card/[id].tsx", import.meta.url)).text();

/** The text of `const name = useCallback(` up to its own `}, [deps]);`. */
function callback(src: string, name: string): { body: string; deps: string } {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }, [", at);
  expect(end).toBeGreaterThan(at);
  const close = src.indexOf("]);", end);
  return { body: src.slice(at, end), deps: src.slice(end + "\n  }, [".length, close) };
}

describe("the board read", () => {
  test("depends on the host and the list, and on nothing somebody types or ticks", () => {
    const load = callback(screen, "load");
    expect(load.deps).toBe("host, board, localList, chosen");
    expect(load.body).not.toMatch(/\b(search|filters|openOnly)\b/);
  });
  test("the search and the filters narrow through the model, not through a request", () => {
    expect(screen).toContain("openAllView(tasks ?? [], search, filters, openOnly)");
  });
});

describe("opening a list", () => {
  const open = callback(screen, "openList");
  test("asks the model whether a board is already held, and only adds when it is not", () => {
    expect(open.body).toContain("listTarget(listId, views?.views ?? [])");
    expect(open.body.indexOf('"view" in target')).toBeLessThan(open.body.indexOf("/clickup/views/add"));
  });
  test("a refusal is said under the selector and leaves the board that was open", () => {
    expect(open.body).toContain("setNotice(");
    expect(open.body).not.toContain("setChosen(");
  });
  test("choosing another list clears what was typed and ticked", () => {
    const choose = callback(screen, "choose");
    expect(choose.body).toContain("setFilters(NO_CARD_FILTERS)");
    expect(choose.body).toContain('setSearch("")');
  });
});

describe("the card screen tells the list its pull requests", () => {
  test("only from a real answer", () => {
    const at = card.indexOf("noteCardPrs(host, cardId");
    expect(at).toBeGreaterThan(-1);
    expect(card.slice(card.lastIndexOf("\n", at), at)).toContain("if (answer.ok)");
  });
});

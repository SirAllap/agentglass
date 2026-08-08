// Which grammar a fenced code block gets highlighted with.
//
// Two questions, and only the first has a right answer. `langFromTag` reads
// what the author wrote after the fence, so it is either right or it is a bug.
// `guessLang` runs when there is nothing to read — which is most blocks, since
// ClickUp writes a language only when somebody picks one from its menu — and
// its job is to be right on the shapes nobody could mistake and to say nothing
// otherwise. Guessing wrong is cheap here (a snippet under the wrong grammar is
// dull, never wrong), but guessing wrong CONFIDENTLY on prose is not: a block
// of English rendered as bash would colour half of it at random.
//
// Pure functions, so no highlighter, no DOM and no network: shiki's grammars
// are dynamic chunks and this suite never has to load one.
import { describe, expect, test } from "bun:test";
import { langFromTag, guessLang } from "../src/lib/highlight.ts";

describe("the language named on a fence", () => {
  test("takes the word the author wrote", () => {
    expect(langFromTag("python")).toBe("python");
    expect(langFromTag("sql")).toBe("sql");
    expect(langFromTag("typescript")).toBe("typescript");
  });

  test("knows what people actually type", () => {
    // Nobody writes ```javascript when ```js will do.
    expect(langFromTag("py")).toBe("python");
    expect(langFromTag("js")).toBe("javascript");
    expect(langFromTag("ts")).toBe("typescript");
    expect(langFromTag("sh")).toBe("bash");
    expect(langFromTag("shell")).toBe("bash");
    expect(langFromTag("console")).toBe("bash");
    expect(langFromTag("yml")).toBe("yaml");
    expect(langFromTag("psql")).toBe("sql");
  });

  test("is not case-sensitive, because a fence is typed by hand", () => {
    expect(langFromTag("Python")).toBe("python");
    expect(langFromTag("  SQL ")).toBe("sql");
  });

  test("says nothing rather than something, when there is nothing to say", () => {
    // A bare fence, and the tags that explicitly mean "this is not code".
    for (const t of ["", "   ", undefined, "text", "txt", "plain"]) {
      expect(langFromTag(t), String(t)).toBeNull();
    }
    // A whole sentence after the fence is not a language name.
    expect(langFromTag("this is the current behaviour")).toBeNull();
  });
});

describe("guessing at a fence with no language", () => {
  test("recognises python by the words only python has", () => {
    expect(guessLang("def _validate(self, caller_types):\n    return None")).toBe("python");
    expect(guessLang("from app.services import Thing\nimport re")).toBe("python");
  });

  test("recognises a shell session", () => {
    expect(guessLang("$ make app.build")).toBe("bash");
    expect(guessLang("docker compose up -d\ncurl localhost:8001")).toBe("bash");
  });

  test("recognises sql, json, go and rust", () => {
    expect(guessLang("SELECT id, name FROM caller_types WHERE id = 3;")).toBe("sql");
    expect(guessLang('{\n  "id": 12,\n  "name": "x"\n}')).toBe("json");
    expect(guessLang("func main() {\n\tfmt.Println(1)\n}")).toBe("go");
    expect(guessLang("fn main() {\n    let mut x = 1;\n}")).toBe("rust");
  });

  test("leaves prose alone", () => {
    /*
     * The assertion that matters. A card's fenced blocks are not all code —
     * people paste log lines, stack traces, an error message, a paragraph they
     * want set apart. Colouring those under a guessed grammar is worse than
     * leaving them grey, because it highlights at random and the reader cannot
     * tell that nothing meant anything.
     */
    for (const prose of [
      "The publish succeeds even though the statement is empty.",
      "Two gaps: no flattening, and the walrus short-circuits.",
      "ERROR 2026-08-05 14:02:11 request failed after 3 retries",
    ]) {
      expect(guessLang(prose), prose).toBeNull();
    }
  });
});

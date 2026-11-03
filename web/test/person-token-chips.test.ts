import { describe, expect, test } from "bun:test";
import { completePerson, joinPersonTokens, partialPerson, splitPersonTokens } from "../src/lib/personTokens.ts";

describe("person tokens in the search box", () => {
  test("a token with more typed after it is a chip, the words stay in the field", () => {
    const r = splitPersonTokens("author:erny fix login ", true);
    expect(r.people).toEqual([{ role: "author", login: "erny" }]);
    expect(r.rest).toBe("fix login ");
  });

  test("the word under the caret is partial while typing and a chip once the box was not typed in", () => {
    expect(splitPersonTokens("author:erny", true)).toEqual({ people: [], rest: "author:erny" });
    expect(splitPersonTokens("author:erny", false)).toEqual({ people: [{ role: "author", login: "erny" }], rest: "" });
  });

  test("a space after the word ends it, even while typing", () => {
    expect(splitPersonTokens("author:erny ", true).people).toEqual([{ role: "author", login: "erny" }]);
  });

  test("three roles, any case; involves, @me and bare words stay text", () => {
    const r = splitPersonTokens("Reviewer:ana assignee:bo-t[bot] involves:cy author:@me hello", false);
    expect(r.people).toEqual([{ role: "reviewer", login: "ana" }, { role: "assignee", login: "bo-t[bot]" }]);
    expect(r.rest).toBe("involves:cy author:@me hello");
  });

  test("chips and field text join back into the query, with no stray space", () => {
    expect(joinPersonTokens([{ role: "author", login: "erny" }], "")).toBe("author:erny");
    expect(joinPersonTokens([{ role: "author", login: "erny" }], "fix ")).toBe("author:erny fix ");
    expect(joinPersonTokens([], "fix")).toBe("fix");
  });

  test("a partial qualifier is offered people and completes with its own role", () => {
    expect(partialPerson("fix reviewer:er")).toEqual({ role: "reviewer", token: "er", start: 4 });
    expect(partialPerson("author:erny done")).toBeNull();
    expect(completePerson("fix reviewer:er", "erny")).toBe("fix reviewer:erny ");
  });
});

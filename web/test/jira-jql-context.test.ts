/*
 * What the JQL box is typing at the caret: a field, an operator, or a value - the heuristic jiraJqlContext.ts answers
 * with, every case named in Addendum 2 plus the quoted and ORDER BY edges it has to get right to be worth using.
 */
import { describe, expect, test } from "bun:test";
import { jqlCursorContext } from "../src/lib/jiraJqlContext.ts";

const at = (text: string, caret = text.length) => jqlCursorContext(text, caret);

describe("field position", () => {
  test("the very start of the box", () => {
    expect(at("assig")).toEqual({ kind: "field", partial: "assig", start: 0 });
  });
  test("after AND, OR or NOT, any case", () => {
    expect(at("project = ORB and assig")).toMatchObject({ kind: "field", partial: "assig" });
    expect(at("project = ORB OR assig")).toMatchObject({ kind: "field", partial: "assig" });
    expect(at("project = ORB and not assig")).toMatchObject({ kind: "field", partial: "assig" });
  });
  test("after an open paren", () => {
    expect(at("(assig")).toMatchObject({ kind: "field", partial: "assig" });
  });
  test("ORDER BY's own field list reads as fields, not an operator on \"by\"", () => {
    expect(at("project = ORB ORDER BY cre")).toEqual({ kind: "field", partial: "cre", start: 23 });
  });
});

describe("operator position: a field already typed, then a space", () => {
  test("still typing the field's own name - no space yet - is still the field position", () => {
    expect(at("assignee")).toEqual({ kind: "field", partial: "assignee", start: 0 });
  });
  test("a field then a space then the start of an operator", () => {
    expect(at("assignee i")).toEqual({ kind: "operator", field: "assignee", partial: "i", start: 9 });
  });
});

describe("value position: a known operator just before the caret", () => {
  test("= with nothing typed yet", () => {
    expect(at("assignee =")).toMatchObject({ kind: "value", field: "assignee", partial: "", quoted: false });
  });
  test("in ( starts a value list, field is the one before \"in\"", () => {
    expect(at("assignee in (Al")).toMatchObject({ kind: "value", field: "assignee", partial: "Al", quoted: false });
  });
  test("a comma inside an open in(...) list is still that field's value, not a new clause", () => {
    expect(at("assignee in (Alex, repor")).toMatchObject({ kind: "value", field: "assignee", partial: "repor", quoted: false });
    expect(at("status not in (Done, repor")).toMatchObject({ kind: "value", field: "status", partial: "repor" });
  });
  test("not in, is not, was not in: the longest word operator wins, not \"in\" alone", () => {
    expect(at("assignee not in (Al")).toMatchObject({ kind: "value", field: "assignee" });
    expect(at("status is not Done")).toMatchObject({ kind: "value", field: "status", partial: "Done" });
    expect(at("status was not in (")).toMatchObject({ kind: "value", field: "status", partial: "" });
  });
  test("~ and !~ (text fields)", () => {
    expect(at("summary ~ bu")).toMatchObject({ kind: "value", field: "summary", partial: "bu" });
    expect(at("summary !~")).toMatchObject({ kind: "value", field: "summary", partial: "" });
  });
});

describe("inside an open quote: still a value, field read from before the quote", () => {
  test("a quote opened, nothing closed yet", () => {
    expect(at('assignee = "Al')).toEqual({ kind: "value", field: "assignee", partial: "Al", start: 12, quoted: true });
  });
  test("a closed pair earlier does not fool the next one open", () => {
    expect(at('project = "ORBIT" and assignee = "Al')).toMatchObject({ kind: "value", field: "assignee", partial: "Al", quoted: true });
  });
  test("single quotes work the same as double", () => {
    expect(at("assignee = 'Al")).toMatchObject({ kind: "value", field: "assignee", quoted: true });
  });
});

describe("the caret, not the string's end, decides", () => {
  test("typing in the middle of a longer query", () => {
    const text = "project = ORBIT AND assignee = currentUser()";
    expect(at(text, "project = ORB".length)).toEqual({ kind: "value", field: "project", partial: "ORB", start: 10, quoted: false });
  });
});

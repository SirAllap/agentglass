/* "Use suggestion" into a contenteditable: the draft goes in as a plain-text
   paste would, a paragraph per blank-line block and a line break per single
   newline. One insertText with "\n" in it was one glued paragraph on a rich editor. */
import { describe, expect, test } from "bun:test";
import { DRAFT_PIECES, PUT_DRAFT } from "../src/lib/browserDrive.ts";

/* Built here, not exported from browserDrive.ts: the app's CSP has no
   'unsafe-eval', so a module-level `new Function` throws an EvalError when the
   bundle loads and the window never draws. The test still runs the exact
   string the page runs. */
const draftPieces = new Function(`return ${DRAFT_PIECES}`)() as (text: string) => Array<{ op: "insertText"; text: string } | { op: "insertParagraph" | "insertLineBreak" }>;

describe("draftPieces", () => {
  test("blank lines make paragraphs, single newlines make line breaks", () => {
    expect(draftPieces("First idea.\n\nThe browser\n- one\n- two")).toEqual([
      { op: "insertText", text: "First idea." },
      { op: "insertParagraph" },
      { op: "insertText", text: "The browser" },
      { op: "insertLineBreak" },
      { op: "insertText", text: "- one" },
      { op: "insertLineBreak" },
      { op: "insertText", text: "- two" },
    ]);
  });
  test("several blank lines, CRLF and edge blanks are one paragraph break each", () => {
    expect(draftPieces("\r\nA\r\n\r\n \n\nB\n\n")).toEqual([
      { op: "insertText", text: "A" }, { op: "insertParagraph" }, { op: "insertText", text: "B" },
    ]);
  });
  test("text with no break is one insert", () => {
    expect(draftPieces("just words")).toEqual([{ op: "insertText", text: "just words" }]);
  });
});

/* PUT_DRAFT on stand-in fields: what the page's execCommand is asked to do. */
function run(kind: "editable" | "input", text: string) {
  const calls: Array<[string, unknown]> = [];
  const doc = { execCommand: (op: string, _u: boolean, v: unknown) => { calls.push([op, v]); return true; }, createRange: () => ({ selectNodeContents() {} }), defaultView: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } };
  const n: Record<string, unknown> = { ownerDocument: doc, focus() {}, dispatchEvent() {}, value: "" };
  (new Function(`return ${PUT_DRAFT}`)())(n, kind, text);
  return { calls, n };
}

describe("PUT_DRAFT", () => {
  test("a contenteditable gets paragraphs and line breaks, not one glued insertText", () => {
    const { calls } = run("editable", "One.\n\nTwo\nthree");
    expect(calls).toEqual([["insertText", "One."], ["insertParagraph", undefined], ["insertText", "Two"], ["insertLineBreak", undefined], ["insertText", "three"]]);
  });
  test("a contenteditable with one line is one insertText, as before", () => {
    expect(run("editable", "hello").calls).toEqual([["insertText", "hello"]]);
  });
  test("a textarea keeps the text whole, breaks and all", () => {
    const { calls, n } = run("input", "One.\n\nTwo");
    expect(calls).toEqual([]);
    expect(n.value).toBe("One.\n\nTwo");
  });
});

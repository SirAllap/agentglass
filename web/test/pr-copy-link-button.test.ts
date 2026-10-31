/*
 * "Copy link" is one click from the header of a pull request, not two clicks
 * down in the overflow menu next to "Close pull request". The number beside the
 * title copies "#N"; this one copies the address.
 */
import { expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const start = src.indexOf("function Masthead(");
const masthead = src.slice(start, src.indexOf("\n}\n", start));

it("has a visible Copy link button beside GitHub", () => {
  expect(start).toBeGreaterThan(0);
  expect(masthead).toContain('"Copy the link to this pull request"');
  expect(masthead).toContain("copyLink");
});

it("no longer carries it in the overflow menu", () => {
  expect(masthead).not.toContain("<MenuItem onClick={() => { close(); onCopyLink(); }}");
});

it("in the narrow header's menu it keeps the header button's answer: the item says Copied for the same 1.5s and the menu waits", () => {
  const code = masthead.split("\n").filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)).join("\n");
  expect(src).toContain("const COPIED_LINK_MS = 1500;");
  expect(code).toContain('<span aria-live="polite">{linkCopied ? "Copied" : "Copy link"}</span>');
  expect(code).toContain("setTimeout(close, COPIED_LINK_MS)");
  /* The press no longer closes the menu before the label can change. */
  expect(code).not.toContain("{ close(); copyLink(); }");
});

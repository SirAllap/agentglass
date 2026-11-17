import { describe, expect, test } from "bun:test";

const portal = await Bun.file(new URL("../src/components/Portal.tsx", import.meta.url)).text();
const rail = await Bun.file(new URL("../src/components/jira/JiraFoldedRail.tsx", import.meta.url)).text();

describe("a Portal is in the page before it draws", () => {
  // An autoFocus input drawn into the detached node was focused outside the document, which does nothing:
  // the Jira jump palette opened on "/" with no caret.
  test("the node is attached before the children draw, in the same pass", () => {
    const code = stripComments(portal);
    // Attached in render, so children mount into the page in the commit that creates them.
    expect(code).toContain("if (el && !el.isConnected) document.body.appendChild(el);");
    // No second pass: an effect outside the portal reading a ref inside it would run while it is still null.
    expect(code).not.toContain("setAttached");
    expect(code).toContain("return el ? createPortal(children, el) : null;");
  });
});

describe("the folded Jira rail", () => {
  test("every square carries its view's initial and nothing on top of it", () => {
    const code = stripComments(rail);
    // A letter, a count badge and a kind glyph overlapped in a 26px square; only the letter is drawn.
    expect(code).not.toContain("agx-jr-badge");
    expect(code).not.toContain("agx-jr-kind");
    // The initial is drawn for every kind, not only for a board.
    expect(code).not.toContain('v.kind === "board" ? <span className="agx-jr-letter"');
  });
});

/** The source without comment lines, so a word quoted in a comment does not count. */
function stripComments(src: string): string {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");
}

describe("the bench takes the keyboard when it opens", () => {
  // Opened over a terminal, the keys stayed in the terminal behind it: "/" on a board in the bench did nothing until a click.
  test("the window is focusable and focuses itself on open unless something inside already has the focus", async () => {
    const bench = await Bun.file(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url)).text();
    expect(bench).toContain("tabIndex={-1}");
    expect(bench).toMatch(/if \(!el\.contains\(document\.activeElement\)\) el\.focus\(\{ preventScroll: true \}\)/);
  });
});

describe("the Jira jump palette goes with the bench", () => {
  // A Portal is not inside the bench window, so closing the bench left the palette open over the view.
  test("it closes on the bench's hidden announcement and when its view stops being active", async () => {
    const jump = stripComments(await Bun.file(new URL("../src/components/jira/JiraJump.tsx", import.meta.url)).text());
    expect(jump).toContain("useCloseWithOwner(hide, { open });");
    expect(jump).toContain("if (!active) hide();");
  });
});

describe("the JQL suggestions wait for the person to write", () => {
  // A saved view's tab put its JQL in the box and the list of every field opened by itself, and stayed over the view after the bench closed.
  test("shown only while typing in the box, gone on blur, and no field list before a letter", async () => {
    const search = stripComments(await Bun.file(new URL("../src/components/jira/list/JiraSearch.tsx", import.meta.url)).text());
    expect(search).toContain("jqlOn && writing && !dismissed");
    expect(search).toContain('!(ctx.kind === "field" && !ctx.partial)');
    expect(search).toContain("onBlur={() => setWriting(false)}");
  });
});

import { describe, expect, it } from "bun:test";

/*
 * No view paints its own name, and no view loses it either.
 *
 * The nine headers used to open with the word for the panel below them —
 * "Terminal" over a terminal, "Docker" over a wall of containers — while the lit
 * icon in the rail had already said the same thing. Three statements of one
 * fact, and the widest of them sat where the controls wanted to be, so every
 * header started indented by a different amount depending on the length of its
 * own name.
 *
 * Deleting a heading is the easy half. The half that rots is the other one: the
 * name is what a screen reader has instead of the rail, so it stays in the
 * document as an `sr-only` heading. That is invisible by definition, which means
 * nothing on screen would ever show it going missing — a header written next
 * year would simply not have one, and nobody would notice for a year more. So it
 * is asserted here rather than trusted.
 *
 * The source is read as text on purpose. What is being checked is that a file
 * does not contain a shape, and rendering nine panels — each wanting a store, a
 * socket and a git repository — to learn that would cost far more than it says.
 */

/** Every file that draws one of the workspace's top bars. */
const VIEWS: Record<string, string> = {
  "Terminal": "TerminalPanel.tsx",
  "Source control": "GitPanel.tsx",
  "Pull Requests": "PrPanel.tsx",
  "Docker": "DockerPanel.tsx",
  "Browser": "BrowserPanel.tsx",
  "Diff": "diff/DiffPage.tsx",
};

/** The three that render the shared component instead of the raw markup; their
 *  heading is `ViewHeader`'s, so what is checked here is the prop that feeds it. */
const VIA_COMPONENT: Record<string, string> = {
  "Tasks": "TasksPanel.tsx",
  "Files": "FilesPanel.tsx",
  "Chats": "ChatPanel.tsx",
  "Clone": "understudy/UnderstudyPanel.tsx",
};

const read = (f: string) => Bun.file(new URL(`../src/components/${f}`, import.meta.url)).text();
const srcs = Object.fromEntries(await Promise.all(
  [...Object.values(VIEWS), ...Object.values(VIA_COMPONENT), "workspace/ViewHeader.tsx"]
    .map(async (f) => [f, await read(f)] as const),
));

describe("view headers", () => {
  it("keeps the name in the document for screen readers", () => {
    for (const [name, file] of Object.entries(VIEWS)) {
      expect(
        srcs[file]!.includes(`<h2 className="sr-only">${name}</h2>`),
        `${file} draws a top bar with no accessible name — a screen reader has no rail to read instead`,
      ).toBe(true);
    }
    for (const [name, file] of Object.entries(VIA_COMPONENT)) {
      expect(
        new RegExp(`<ViewHeader[^>]*\\blabel="${name}"`).test(srcs[file]!),
        `${file} renders ViewHeader without a label, so its view has no accessible name`,
      ).toBe(true);
    }
  });

  it("paints no visible title", () => {
    // The class that used to size them. Gone from the module, so any file still
    // naming it would not compile — but it is the exact shape a copy-paste from
    // an old header brings back, and the message here is cheaper than the type
    // error to understand.
    for (const [file, src] of Object.entries(srcs)) {
      expect(src.includes("viewTitleClass"), `${file} is drawing a view title again`).toBe(false);
    }
  });

  it("does not offer a title prop to fall back into", () => {
    const header = srcs["workspace/ViewHeader.tsx"]!;
    expect(/\btitle[?]?:\s*string/.test(header), "ViewHeader took its title prop back").toBe(false);
    // `count` went with it: on its own, with no word in front, it was a bare
    // numeral at the far left of an otherwise empty bar.
    expect(/\bcount[?]?:\s*number/.test(header), "ViewHeader took its count prop back").toBe(false);
  });
});

import { describe, expect, it } from "bun:test";

/*
 * One picker, and nobody keeps a private copy.
 *
 * There were seven of these — Source control, Files, Tasks, Chat, the terminal
 * view, the docked console, plus a row of bare `<select>`s in Machine, Recipes,
 * Budgets and the browser — written at seven different times. They had drifted
 * into two chevron glyphs, five widths, three placeholders, and one with no
 * filter at all. Nothing learned in one of them transferred to the next.
 *
 * That is not a state a codebase arrives at on purpose; it is what happens when
 * the cheapest way to add a picker is to write one. So this makes the cheap way
 * the shared one: the local state each copy used to declare (`repoOpen`,
 * `repoQuery`) is the shape a new copy would bring back, and it fails here.
 *
 * The source is read as text on purpose. What is asserted is that files do not
 * contain a shape, and rendering ten panels — each wanting a store, a socket
 * and a git repository — to find that out would cost far more than it says.
 */
const dir = new URL("../src/components/", import.meta.url);
const read = (f: string) => Bun.file(new URL(f, dir)).text();

const PICKER = "CheckoutPicker.tsx";

/** Everything that draws a checkout chooser, and must do it through the one. */
const USERS = [
  "GitPanel.tsx", "FilesPanel.tsx", "ChatPanel.tsx", "TerminalPanel.tsx",
  "MachinePanel.tsx", "RecipesPane.tsx", "BudgetsPane.tsx",
  "browser/PagePicker.tsx", "browser/MarkupLayer.tsx",
];

const picker = await read(PICKER);
const users = Object.fromEntries(await Promise.all(USERS.map(async (f) => [f, await read(f)] as const)));

describe("the shared checkout picker", () => {
  it("is the only place a checkout menu is written", () => {
    for (const [file, src] of Object.entries(users)) {
      expect(src.includes("CheckoutPicker"), `${file} chooses a checkout without the shared control`).toBe(true);
      for (const shape of ["repoOpen", "repoQuery"]) {
        expect(src.includes(shape), `${file} declares its own \`${shape}\` — that is a second picker growing`).toBe(false);
      }
    }
  });

  it("keeps a stored value on screen when the list no longer offers it", () => {
    // A budget is attached to a root and a chat remembers where it runs. A
    // checkout can move, be deleted, or fall out of the open project's scope,
    // and falling back to the placeholder would read as "everything" or "pick
    // one" while the setting underneath still says something else.
    expect(picker).toContain("const unlisted = value && !here ? value : \"\";");
    expect(picker).toContain("not in this list");
  });

  it("never decides the value for the panel", () => {
    // Chat's checkout is where that conversation runs, the docked console's is
    // where you build, Source control's is what you are reading. One control
    // that quietly moved all three would be worse than the seven it replaced,
    // so it holds no root of its own and writes to no storage key.
    expect(/useState[^\n]*\broot\b/.test(picker), "the picker is holding a checkout of its own").toBe(false);
    expect(picker.includes("localStorage"), "the picker is persisting somebody else's choice").toBe(false);
  });

  it("keeps looking and writing apart", () => {
    // Repo rows change what you are looking at; branch rows run `git checkout`
    // over the directory you are standing in. Only Source control passes the
    // second kind, and they are the only rows in the menu that touch the disk —
    // so they live under their own heading rather than mixed into the list.
    expect(picker).toContain("Branches — checkout here");
    const withBranches = Object.entries(users).filter(([, s]) => /branches=\{\{/.test(s)).map(([f]) => f);
    expect(withBranches.sort()).toEqual(["GitPanel.tsx", "TerminalPanel.tsx"]);
  });
});

describe("the terminal", () => {
  const term = users["TerminalPanel.tsx"]!;

  it("does not offer to move a shell it cannot move", () => {
    // The server reads a shell's directory once, when the PTY opens, so the old
    // picker never moved the shell in front of you — it hid your shells and
    // started a new one elsewhere. The view header states where the pane is
    // instead, and the one picker left is the docked console's, which is a
    // different shell and a different question.
    expect(term.match(/<CheckoutPicker/g)?.length ?? 0).toBe(1);
    expect(term).toContain("requestWorktreeJump({ view: \"git\", root: at.root })");
  });

  it("still writes the key the docked console falls back to", () => {
    // Nobody picks this root any more, but `consoleRoot()` reads it when the
    // console has no pick of its own. Without a writer, `docker exec` and every
    // recipe would stop working on a fresh profile — silently, because
    // `runInConsole` only returns false.
    expect(term).toContain("localStorage.setItem(ROOT_KEY, root)");
  });
});

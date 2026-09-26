/*
 * The empty state is a dead end no longer: it lists the paired projects and
 * opens a shell straight into one, instead of only offering "Look again"
 * over copy that assumed the reader knows what tmux is.
 *
 * The header's own `+` needs a pane to read a project off (see the comment on
 * it in this file), which is exactly what is missing here — so this reads
 * `/git/repos` (already scoped to the paired project server-side, same as the
 * project pickers) and calls `/terminal/open-shell` with an explicit root
 * instead of a pane's cwd.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `\`${from}\` is gone — this test is reading the wrong code`).toBeGreaterThan(0);
  const end = source.indexOf(to, start);
  expect(end, `\`${to}\` no longer follows \`${from}\``).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the empty state", () => {
  test("reads the paired projects rather than only offering to look again", () => {
    const effect = between(screen, "The empty state's own list", "}, [host, open, emptyRepos]);");
    expect(effect).toContain('"/git/repos"');
    // Asked only once there is truly nothing attached — a project list the
    // strip's own poll would make stale a moment later is not worth reading
    // while a pane is up.
    expect(effect).toContain("if (!host || open || emptyRepos !== null) return;");
  });

  test("opens with an explicit root, never off a pane it does not have", () => {
    const fn = between(screen, "const openShellIn = useCallback(", "}, [host, load]);");
    expect(fn).toContain('"/terminal/open-shell"');
    expect(fn).toContain("method: \"POST\"");
    expect(fn).toContain("body: { root }");
    // Same follow as the header's own `+` (see terminal-opened-follows-session):
    // a window that lands somewhere is a window this screen switches to.
    expect(fn).toContain("setActive(answer.value.pane)");
    expect(fn).toContain("setSession(answer.value.session)");
  });

  test("bridges to the freshly opened pane rather than trusting the next poll", () => {
    /*
     * Reported from a real device: the server DID create the session and
     * window, but a session with zero tmux clients and no agent is exactly
     * what `paneTabs` filters out of the strip forever, so `open` stayed null
     * and the phone sat on "Nothing open" through repeated "Look again"
     * presses. `pendingOpen` bridges it until an attach makes the poll list
     * it for real — see terminal-pending-tab.test.ts for the pure decision.
     */
    const fn = between(screen, "const openShellIn = useCallback(", "}, [host, load]);");
    expect(fn).toContain("pendingOpen.current = {");
    expect(fn).toContain("paneId: answer.value.pane, session: answer.value.session");

    const openLine = screen.split("\n").find((l) => l.includes("const open = tabs.find"));
    expect(openLine, "the `open` computation moved").toBeTruthy();
    expect(openLine).toContain("pendingTab(pendingOpen.current, active)");
  });

  test("the card offers a button per paired project, not just Look again", () => {
    const at = screen.indexOf('emptyRepos?.length ? (');
    expect(at, "the empty-state list moved").toBeGreaterThan(-1);
    const card = screen.slice(at, screen.indexOf("Look again", at));
    expect(card).toContain("openShellIn(r.root)");
    expect(card).toContain("Open a shell in");
  });

  test("the copy no longer assumes the reader knows what tmux is", () => {
    const at = screen.indexOf("Nothing is open on the computer");
    expect(at, "the empty-state sentence moved").toBeGreaterThan(-1);
    const sentence = screen.slice(at, at + 200);
    expect(sentence).not.toContain("tmux");
  });

  test("Look again is still there", () => {
    expect(screen).toContain('<Btn label="Look again" onPress={() => { void load(); }} />');
  });

  /* The header's own `+`, which this test's own opening comment refers to. */
  test("the header's + is disabled with no pane, because it reads the project off one", () => {
    const at = screen.indexOf("A new window, with an agent already running in it.");
    expect(at, "the comment moved").toBeGreaterThan(-1);
    expect(screen.slice(at, at + 800)).toContain("disabled={!open || opening}");
  });
});

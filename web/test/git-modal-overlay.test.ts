/*
 * The Git modals open over the view the person is on.
 *
 * An agent showing Insights from the terminal used to land the person on the
 * Git view, and the chat in the terminal went out of sight. The modals are
 * portals, so what they need is the Git view MOUNTED (hidden) with a checkout,
 * not shown. There is no renderer here, so the wiring is asserted as source and
 * the mailbox as behaviour.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_MODAL_TTL_MS, hasGitModal, latchGitModal, takeGitModal } from "../src/lib/gitModalIntent.ts";
import { VIEW_SWITCHERS } from "../src/lib/agentBack.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const stripComments = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
/** From `from` to its own closing brace at the same indent. */
const block = (t: string, from: string) => {
  const a = t.indexOf(from);
  expect(a, `${from} moved`).toBeGreaterThan(-1);
  const lineStart = t.lastIndexOf("\n", a) + 1;
  const indent = /^\s*/.exec(t.slice(lineStart))![0];
  const end = t.indexOf("\n" + indent + "}", a);
  expect(end, `${from} has no closing brace`).toBeGreaterThan(a);
  return t.slice(a, end);
};

afterEach(() => { takeGitModal(); });

describe("the doors", () => {
  const handlers = stripComments(src("lib/uiActions.ts")).split("\n").filter((l) => /^\s+"git\.(modal|compare|blame|rebase)":/.test(l));

  it("all four are there, latch, and never switch the view", () => {
    expect(handlers.length).toBe(4);
    for (const l of handlers) {
      expect(l).toContain("latchGitModal(");
      expect(l).not.toContain("goView");
    }
  });

  it("none of them is a view switcher, so no 'back to' chip is armed for a view that did not change", () => {
    for (const id of ["git.modal", "git.compare", "git.blame", "git.rebase"]) expect(VIEW_SWITCHERS as readonly string[], id).not.toContain(id);
  });
});

describe("the mailbox", () => {
  it("is visible without being taken, and gone when taken or stale", () => {
    expect(hasGitModal()).toBe(false);
    latchGitModal({ which: "insights" });
    expect(hasGitModal()).toBe(true);
    expect(hasGitModal()).toBe(true);
    expect(hasGitModal(Date.now() + GIT_MODAL_TTL_MS + 1000)).toBe(false);
    expect(takeGitModal()).toEqual({ which: "insights" });
    expect(hasGitModal()).toBe(false);
  });
});

describe("the Git view serves them while hidden", () => {
  const git = src("components/GitPanel.tsx");

  it("is open for data while a modal was asked for, and the request wakes it", () => {
    expect(git).toContain("const [asked, setAsked] = useState(hasGitModal);");
    expect(git).toContain("const open = active || asked;");
    expect(block(git, "const wake = () =>")).toContain("setAsked(true)");
  });

  it("does not poll, take focus or hold the cover for a view nobody is looking at", () => {
    expect(git).toContain('useCoverHold("git", active &&');
    expect(git).toContain("usePoll(active && !!root && !busy, () => loadTree(root));");
    expect(git).toContain("usePoll(active && !!root && !busy, loadView, 10_000);");
    expect(git).toContain("if (active) requestAnimationFrame(() => frameRef.current?.focus());");
  });

  it("every modal gets the checkout the view is on, and the request waits for one", () => {
    const drain = block(git, "useEffect(() => {\n    if (!root) return;\n    const run = () => {");
    expect(drain).toContain("takeGitModal()");
    for (const m of ["RebaseModal", "CompareModal", "InsightsModal", "BlameModal", "BisectModal"]) {
      expect(git, m).toMatch(new RegExp(`<${m}[^>]*\\sroot=\\{root\\}`));
    }
  });

  it("the toast floats when the view is hidden, since it answers what the palette ran", () => {
    expect(git).toContain("<Portal z={LAYER.palette}><GitToast toast={toast} floating /></Portal>");
  });

  it("Workspace mounts the view hidden for a request, and does not show it", () => {
    const ws = src("components/workspace/Workspace.tsx");
    const mount = block(ws, "const mountGit = () => {");
    expect(mount).toContain("hasGitModal()");
    expect(mount).toContain('add("git")');
    expect(mount).not.toContain("onView");
    expect(mount).not.toContain("setView");
  });
});

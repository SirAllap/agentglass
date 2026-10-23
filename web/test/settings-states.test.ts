/*
 * The three states a settings page has besides "fine": saving, a page that
 * could not read what it shows, and a list with nothing in it. The decisions are
 * asserted on the pure functions; that every page maps its own real state onto
 * them is asserted against the source (there is no renderer for the pages), and
 * what the kit draws is rendered. Each test goes red when its decision is reverted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NO_MARK, headerChips, rollup, withProblems, type PageMark } from "../src/lib/settingsNav.ts";
import { SAVED_MS, applyProblem, nextSavePhase, problemChip } from "../src/lib/settingsStates.ts";
import { ProblemNote, SaveChip, SettingsCard, StatusBadge } from "../src/components/SettingsKit.tsx";
import { EditorFoot, ListPanel } from "../src/components/SettingsListEditor.tsx";

const SRC = join(import.meta.dir, "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");
const css = read("index.css");
const modal = read("components/SettingsModal.tsx");
const h = React.createElement;

describe("saving", () => {
  test("a write that is out is saving, and one that landed is saved", () => {
    expect(nextSavePhase("idle", true, false)).toBe("saving");
    expect(nextSavePhase("saving", true, false)).toBe("saving");
    expect(nextSavePhase("saving", false, false)).toBe("saved");
  });
  test("a write that failed is never Saved: the page's own error line says what happened", () => {
    expect(nextSavePhase("saving", false, true)).toBe("idle");
  });
  test("nothing is written means nothing is said, and Saved is left to its timer", () => {
    expect(nextSavePhase("idle", false, false)).toBe("idle");
    expect(nextSavePhase("saved", false, false)).toBe("saved");
    expect(SAVED_MS).toBeGreaterThan(1000);
  });
  test("the chip says Saving with a spinner and Saved with a dot, and says nothing when idle", () => {
    const html = (phase: "idle" | "saving" | "saved") => renderToStaticMarkup(h(SaveChip, { phase }));
    expect(html("saving")).toContain("Saving");
    expect(html("saving")).toContain("agx-spin");
    expect(html("saved")).toContain("Saved");
    expect(html("saved")).not.toContain("agx-spin");
    expect(html("idle")).not.toContain("agx-badge");
    expect(html("idle")).toContain('aria-live="polite"');
  });
  test("the page header says Saving after the verdict while a write is out", () => {
    const on: PageMark = { state: "on" };
    expect(headerChips("lantern", on, true)).toEqual([{ tone: "ok", text: "Watching" }, { tone: "saving", text: "Saving" }]);
    expect(headerChips("lantern", on)).toEqual([{ tone: "ok", text: "Watching" }]);
    expect(headerChips("privacy", NO_MARK, true)).toEqual([{ tone: "saving", text: "Saving" }]);
  });
  test("the editor foot says Saving while a save is out, and keeps Save from being pressed twice", () => {
    const foot = renderToStaticMarkup(h(EditorFoot, { dirty: true, canSave: true, noun: "reply", onCancel: () => {}, busy: true }));
    expect(foot).toContain("Saving reply…");
    expect(foot).toContain("agx-spin");
    expect(foot).not.toContain("Unsaved changes");
    expect(foot).toContain("disabled");
    const idle = renderToStaticMarkup(h(EditorFoot, { dirty: false, canSave: true, noun: "reply", onCancel: () => {} }));
    expect(idle).toContain("All changes saved");
    expect(idle).not.toContain("<button");
  });
  test("the terminal's two write cards show it in their header and tell the page header", () => {
    for (const card of ["LaunchPermissionsCard", "TerminalRunsOn"]) {
      const body = modal.slice(modal.indexOf(`function ${card}(`), modal.indexOf("\nfunction ", modal.indexOf(`function ${card}(`) + 10));
      expect(body, card).toContain('useSavePhase("terminal", busy, !!err)');
      expect(body, card).toContain("<SaveChip phase={phase} />");
    }
  });
  test("the list pages tell the header about their save", () => {
    for (const [f, id] of [["SavedRepliesPane", "saved-replies"], ["RecipesPane", "recipes"], ["ReviewPromptsPane", "review-prompts"]]) {
      expect(read(`components/${f}.tsx`), f).toContain(`useReportSaving("${id}", busy)`);
    }
    expect(read("components/RecipesPane.tsx")).toContain("noun=\"recipe\" onCancel={onCancel} busy={busy}");
    expect(read("components/ReviewPromptsPane.tsx")).toContain("noun=\"prompt\" onCancel={onCancel} busy={busy}");
  });
});

describe("a page that could not read what it shows", () => {
  const problems = { jira: { chip: "Token refused", title: "401 Unauthorized" } };
  test("its mark turns red over whatever the open-time fact said", () => {
    const marks = withProblems({ jira: { state: "on" }, hooks: { state: "on" } }, problems);
    expect(marks.jira).toEqual({ state: "err", title: "401 Unauthorized", chip: "Token refused" });
    expect(marks.hooks).toEqual({ state: "on" });
  });
  test("a page with no report keeps its mark, and a page with none gets none", () => {
    expect(withProblems({ hooks: { state: "on" } }, {})).toEqual({ hooks: { state: "on" } });
    expect(withProblems({}, {}).jira).toBeUndefined();
  });
  test("the header chip is red and carries the page's own words", () => {
    expect(headerChips("jira", withProblems({}, problems).jira!)).toEqual([{ tone: "err", text: "Token refused" }]);
    expect(headerChips("jira", { state: "err" })).toEqual([{ tone: "err", text: "Not reachable" }]);
  });
  test("a shut group counts a failed page as one that wants you", () => {
    expect(rollup([{ state: "err" }, { state: "needs" }, { state: "on" }, NO_MARK])).toBe(2);
  });
  test("the words say why: a refused token is not an unreachable server", () => {
    expect(problemChip()).toBe("Not reachable");
    expect(problemChip({ unauthorised: true })).toBe("Token refused");
    expect(problemChip({ throttled: true })).toBe("Rate limited");
  });
  test("reporting the same problem again, or clearing a page with none, changes nothing (no extra render)", () => {
    const one = applyProblem({}, "jira", problems.jira);
    expect(applyProblem(one, "jira", { ...problems.jira })).toBe(one);
    const none = {};
    expect(applyProblem(none, "jira", null)).toBe(none);
    expect(applyProblem(one, "jira", null)).toEqual({});
    expect(applyProblem(one, "jira", { chip: "Not reachable", title: "x" }).jira?.chip).toBe("Not reachable");
  });
  test("the shell draws it: nav mark, header chip and a Try again that runs the page's own retry", () => {
    expect(modal).toContain("const marks = useMemo(() => withProblems(withNeeds(navMarks({");
    expect(modal).toContain("<PageState.Provider value={pageState}>");
    expect(modal).toMatch(/problems\[navTab\.id\] \? <Button tone="primary" onClick=\{\(\) => retries\.current\[navTab\.id\]\?\.\(\)\}>Try again<\/Button>/);
    const nav = read("components/SettingsNav.tsx");
    expect(nav).toMatch(/m\.state === "err"\) return <span className="agx-sn-meta" data-keep>/);
    expect(css).toMatch(/\.agx-sn-dot\[data-state="err"\] \{ background: var\(--error\); \}/);
  });
  test("the red dot survives the icon rail, where every other mark is folded away", () => {
    expect(css).toMatch(/@media \(max-width: 1100px\) \{\s*\.agx-sn-meta\[data-keep\] \{ display: flex; position: absolute;/);
  });
  test("each page that can fail maps its OWN failed read onto it, not a made-up one", () => {
    const want: [string, string, RegExp][] = [
      ["components/JiraPane.tsx", 'useReportProblem("jira"', /failed \? \{ chip: problemChip\(\), title: "Could not read Jira's state\." \}/],
      ["components/ClickUpPane.tsx", 'useReportProblem("clickup"', /connected && state\.kind === "error" \? \{ chip: problemChip\(state\), title: state\.error \}/],
      ["components/RemoteAccessPane.tsx", 'useReportProblem("remote"', /failed \? \{ chip: problemChip\(\), title: "Could not read the network state\." \}/],
      ["components/engines/EnginesPane.tsx", 'useReportProblem("engines"', /failed \? \{ chip: "Not scanned"/],
      ["components/SettingsModal.tsx", 'useReportProblem("connections", err ? { chip: "Not read"', /err \? \{ chip: "Not checked", title: err \}/],
    ];
    for (const [f, a, b] of want) { const src = read(f); expect(src, f).toContain(a); expect(src, f).toMatch(b); }
  });
  test("the engines scan stops swallowing a failed read: the failure is a state, cleared by the next good scan", () => {
    const src = read("components/engines/EnginesPane.tsx");
    expect(src).not.toContain("a failed read keeps what is on screen");
    expect(src).toContain("setFailed(false)");
    expect(src).toContain("setFailed(true)");
  });
  test("an error card is red-tinted but keeps its buttons filled; a problem row has role alert", () => {
    expect(renderToStaticMarkup(h(SettingsCard, { title: "Jira", tone: "error", children: h("i") }))).toContain('data-tone="error"');
    expect(css).toMatch(/\.agx-scard\[data-tone="error"\] \{\s*background: color-mix\(in srgb, var\(--error\) 5%/);
    expect(css).not.toContain('.agx-scard[data-tone="error"] .agx-btn');
    const note = renderToStaticMarkup(h(ProblemNote, { title: "Could not reach", action: h("button", null, "Try again") }, "401"));
    expect(note).toContain('role="alert"');
    expect(note).toContain("Could not reach");
    expect(note).toContain("Try again");
  });
  test("the saving badge draws the house spinner where the dot is", () => {
    const html = renderToStaticMarkup(h(StatusBadge, { tone: "saving", children: "Saving" }));
    expect(html).toContain("agx-spin");
    expect(html).toContain('data-tone="info"');
    expect(html).not.toContain("<i");
  });
});

describe("a list with nothing in it", () => {
  const blank = { icon: h("svg"), title: "No saved replies yet", text: "One sentence.", action: h("button", null, "New reply") };
  const html = (props: Record<string, unknown>) => renderToStaticMarkup(h(ListPanel, { sections: [{ id: "a", title: "Replies", entries: [] }], selected: null, onSelect: () => {}, ...props }));
  test("says what is missing in one sentence and offers the action that fills it", () => {
    const out = html({ blank });
    expect(out).toContain("No saved replies yet");
    expect(out).toContain("One sentence.");
    expect(out).toContain("New reply");
    expect(out).not.toContain("agx-le-lg");
  });
  test("a filter that matched nothing is not an empty list: it keeps its sections and says so", () => {
    const out = html({ nothing: "Nothing matches." });
    expect(out).toContain("Nothing matches.");
    expect(out).toContain("agx-le-lg");
    expect(out).not.toContain("agx-le-blank");
  });
  test("the three list pages show it only when the whole list is empty, never for a filter", () => {
    expect(read("components/SavedRepliesPane.tsx")).toContain("blank={replies?.length === 0 ? {");
    expect(read("components/RecipesPane.tsx")).toContain("blank={list?.length === 0 ? {");
    expect(read("components/ReviewPromptsPane.tsx")).toContain("blank={count === 0 && !hiddenList.length ? {");
  });
});

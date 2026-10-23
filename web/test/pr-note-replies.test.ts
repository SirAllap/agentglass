/*
 * Replying to a plugin's finding: what the composer allows, how a thread
 * reads, when a closed finding folds it, and that the one action that leaves
 * the machine is off by default, asked about every time, and reachable from
 * nowhere else. Decisions live in lib/noteReplies.ts; the screens that use
 * them are checked as markup and as source (there is no renderer here).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COLLAPSE_OVER, FRESH_DRAFT, REPLY_MAX_CHARS, authorLabel, composerActions, composerKey, draftState, replyCountLabel, replyTags, threadFolded,
} from "../src/lib/noteReplies.ts";
import { NoteCard, ReplyComposer, ReplyThread, type LocalNote } from "../src/components/plugins/LocalReview.tsx";
import type { NoteReply } from "../src/lib/pluginTypes.ts";

const reply = (id: string, over: Partial<NoteReply> = {}): NoteReply => ({ id, text: `text ${id}`, at: Date.now() - 120_000, by: "user", ...over });
const note = (over: Partial<LocalNote> = {}): LocalNote => ({
  id: "f-1", plugin: "acme-review", repo: "acme/orbit", number: 1042, severity: "critical", title: "Guard runs after the loop",
  status: "open", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...over,
});
const md = (el: React.ReactElement) => renderToStaticMarkup(el);
const src = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const review = code(await src("../src/components/plugins/LocalReview.tsx"));
const pr = code(await src("../src/components/PrPanel.tsx"));
const lib = code(await src("../src/lib/noteReplies.ts"));
/** From `start` to the function's own closing brace at the same indent. */
const fn = (s: string, start: string) => {
  const i = s.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  const indent = s.slice(s.lastIndexOf("\n", i) + 1, i).match(/^\s*/)![0];
  const end = s.indexOf(`\n${indent}}\n`, i);
  return s.slice(i, end + 2 + indent.length);
};

describe("composer rules", () => {
  test("the counter, the cap and what can be sent", () => {
    expect(draftState("")).toMatchObject({ canSend: false, empty: true, counter: `0 / ${REPLY_MAX_CHARS}` });
    expect(draftState("   \n ").canSend).toBe(false);
    expect(draftState("ok").canSend).toBe(true);
    expect(draftState("a".repeat(REPLY_MAX_CHARS)).canSend).toBe(true);
    expect(draftState("a".repeat(REPLY_MAX_CHARS + 1))).toMatchObject({ canSend: false, over: true });
  });

  test("Esc closes, Ctrl+Enter and Cmd+Enter save, Enter alone is a newline", () => {
    expect(composerKey({ key: "Escape" })).toBe("close");
    expect(composerKey({ key: "Enter", ctrlKey: true })).toBe("save");
    expect(composerKey({ key: "Enter", metaKey: true })).toBe("save");
    expect(composerKey({ key: "Enter" })).toBeNull();
    expect(composerKey({ key: "a", ctrlKey: true })).toBeNull();
  });

  test("a fresh draft is just an empty text: there is no way to send a reply to GitHub", () => {
    expect(FRESH_DRAFT).toEqual({ text: "" });
  });

  test("an open finding offers all three, a closed one only Save", () => {
    expect(composerActions("open")).toEqual(["save", "resolve", "dismiss"]);
    expect(composerActions("resolved")).toEqual(["save"]);
    expect(composerActions("dismissed")).toEqual(["save"]);
  });

  test("the composer renders its buttons, the counter and an unticked box", () => {
    const open = md(React.createElement(ReplyComposer, { status: "open", onSend: async () => ({ ok: true }), onClose() {} }));
    for (const label of ["Cancel", "Save reply", "Resolve with reply", "Dismiss with reply", `0 / ${REPLY_MAX_CHARS}`]) {
      expect(open).toContain(label);
    }
    expect(open).not.toContain("GitHub");
    expect(open).not.toContain("checkbox");
    const closed = md(React.createElement(ReplyComposer, { status: "resolved", onSend: async () => ({ ok: true }), onClose() {} }));
    expect(closed).toContain("Save reply");
    expect(closed).not.toContain("Resolve with reply");
    expect(closed).not.toContain("Dismiss with reply");
  });
});

describe("thread", () => {
  test("author, time, tags and text; oldest first as given", () => {
    const html = md(React.createElement(ReplyThread, {
      status: "resolved",
      replies: [reply("a", { text: "Checking this one." }), reply("b", { text: "Fixed in 3f9a2c1.", withStatus: "resolved" })],
    }));
    expect(html).toContain("You");
    expect(html).toContain("2m ago");
    expect(html).toContain("resolved with this reply");
    expect(html).not.toContain("posted on GitHub");
    expect(html.indexOf("Checking this one.")).toBeLessThan(html.indexOf("Fixed in 3f9a2c1."));
  });

  test("an agent's reply shows its name, not 'You'", () => {
    const html = md(React.createElement(ReplyThread, { status: "open", replies: [reply("a", { by: "agent:bug-fixer" })] }));
    expect(html).toContain("bug-fixer");
    expect(html).not.toContain(">You<");
    expect(authorLabel("agent:bug-fixer")).toBe("bug-fixer");
    expect(authorLabel("user")).toBe("You");
  });

  test("reply text is text: markup in it is escaped", () => {
    const html = md(React.createElement(ReplyThread, { status: "open", replies: [reply("a", { text: "<img src=x onerror=1>" })] }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("tags: none for a plain reply, what the reply did", () => {
    expect(replyTags(reply("a"))).toEqual([]);
    expect(replyTags(reply("a", { withStatus: "dismissed" }))).toEqual(["dismissed with this reply"]);
  });
});

describe("collapse", () => {
  test("only a closed finding with more than two replies folds", () => {
    expect(COLLAPSE_OVER).toBe(2);
    expect(threadFolded("resolved", 3, false)).toBe(true);
    expect(threadFolded("dismissed", 3, false)).toBe(true);
    expect(threadFolded("resolved", 2, false)).toBe(false);
    expect(threadFolded("open", 9, false)).toBe(false);
    expect(threadFolded("resolved", 3, true)).toBe(false);
  });

  test("folded: one button with the count, no reply text; reopened: all of it", () => {
    const rs = [reply("a"), reply("b"), reply("c")];
    const folded = md(React.createElement(ReplyThread, { status: "resolved", replies: rs }));
    expect(folded).toContain("3 replies");
    expect(folded).not.toContain("text a");
    const reopened = md(React.createElement(ReplyThread, { status: "open", replies: rs }));
    expect(reopened).toContain("text a");
    expect(reopened).toContain("text c");
    expect(replyCountLabel(1)).toBe("1 reply");
  });

  test("a card with replies shows them, and has the Reply button only when it can save one", () => {
    const withIt = md(React.createElement(NoteCard, { n: note({ replies: [reply("a")] }), onStatus() {}, onReply: async () => ({ ok: true }) }));
    expect(withIt).toContain("text a");
    expect(withIt).toContain(">Reply<");
    const without = md(React.createElement(NoteCard, { n: note(), onStatus() {} }));
    expect(without).not.toContain(">Reply<");
    expect(without).not.toContain("Replies");
  });

  test("Reopen keeps the thread: the open card still shows every reply", () => {
    const rs = [reply("a"), reply("b"), reply("c")];
    const html = md(React.createElement(NoteCard, { n: note({ status: "open", replies: rs }), onStatus() {} }));
    expect(html).toContain("text a");
    expect(html).toContain("text c");
  });
});

describe("a reply never reaches GitHub", () => {
  test("GUARD: no GitHub box, no root, no confirm in the reply path", () => {
    const at = review.indexOf("const reply = useCallback(");
    const body = review.slice(at, review.indexOf("const pressAction", at));
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("api.pluginNoteReply(");
    expect(body).not.toMatch(/postToGitHub|approve|root|gh\.current/);
    expect(review).not.toMatch(/postToGitHub|postedOnGitHub|Also post on the pull request/);
    expect(lib).not.toMatch(/postToGitHub|postedOnGitHub/);
    expect(pr).not.toMatch(/This will comment on GitHub as you, on/);
  });

  test("it resets after a successful use and not before", () => {
    const body = fn(review, "const send = async (to?: NoteStatus)");
    expect(body).toContain("if (r.ok) setDraft(FRESH_DRAFT)");
    expect(review).toContain("useState<ReplyDraft>(FRESH_DRAFT)");
  });

  test("the lib never reaches the network and the card never posts by itself", () => {
    expect(lib).not.toContain("fetch(");
    expect(review.match(/api\.pluginNoteReply\(/g)).toHaveLength(1);
    expect(review).not.toContain("api.prComment");
  });

  test("the Reply button is the shared compact bar control, with no height of its own", () => {
    const body = fn(review, "function StatusActions(");
    expect(body).toContain('<Button size="compact" on={replying || undefined}');
    expect(body).not.toMatch(/height|h-\d|style=\{\{[^}]*h\b/);
  });
});

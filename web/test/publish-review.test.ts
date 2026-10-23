/*
 * "Publish review…": the button's four states, what the dialog starts with,
 * what "Publish all" ticks, when Post is allowed, and which cards say
 * "local only" afterwards. Decisions live in lib/publishReview.ts; the screens
 * are checked as markup and as source (there is no renderer here).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_PUBLISH_OPTIONS, NOTHING_LEAVES_WARNING, NO_REVIEW_TIP, PUBLISH_MAX_CHARS, allTicked, canPost, charCounter, freshOptions, localOnly, openCount,
  optionRows, postLabel, publishAllOptions, publishButtonState,
} from "../src/lib/publishReview.ts";
import { NoteCard, type LocalNote } from "../src/components/plugins/LocalReview.tsx";
import type { PrRun } from "../src/lib/pluginTypes.ts";

const HEAD = "3f9a2c1d0e8b7a6f5e4d3c2b1a09f8e7d6c5b4a3";
const run = (over: Partial<PrRun> = {}): PrRun => ({ id: "run-7", repo: "acme/orbit", number: 1042, state: "done", title: "Local review", sha: HEAD, startedAt: 1, ...over });
const n = (over: Partial<LocalNote> = {}): LocalNote => ({
  id: "f-1", plugin: "acme-review", repo: "acme/orbit", number: 1042, severity: "critical", title: "Guard runs after the loop", status: "open", createdAt: 1, updatedAt: 1, ...over,
});
const src = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("the button's four states", () => {
  test("no review yet: disabled with the tooltip", () => {
    expect(publishButtonState(undefined, [], HEAD)).toMatchObject({ kind: "none", disabled: true, tooltip: NO_REVIEW_TIP, label: "Publish review…" });
  });
  test("a run still going or failed cannot be published", () => {
    expect(publishButtonState(run({ state: "running" }), [n()], HEAD).disabled).toBe(true);
    expect(publishButtonState(run({ state: "failed" }), [n()], HEAD).disabled).toBe(true);
  });
  test("ready: enabled, no chips", () => {
    expect(publishButtonState(run(), [n()], HEAD)).toMatchObject({ kind: "ready", disabled: false, staleChip: false, published: null, label: "Publish review…" });
  });
  test("stale: enabled, with the amber chip, when the head moved", () => {
    const s = publishButtonState(run(), [n()], "ffffffffffffffffffffffffffffffffffffffff");
    expect(s).toMatchObject({ kind: "stale", disabled: false, staleChip: true });
    expect(publishButtonState(run({ sha: HEAD.slice(0, 7) }), [n()], HEAD).staleChip).toBe(false);
    expect(publishButtonState(run(), [n()], undefined).staleChip).toBe(false);
  });
  test("published: becomes Update, with the chip and where it points", () => {
    const s = publishButtonState(run({ published: { at: 5, url: "https://github.com/acme/orbit/pull/1042#issuecomment-1" } }), [n()], HEAD);
    expect(s).toMatchObject({ kind: "published", label: "Update published review…", published: { at: 5, url: "https://github.com/acme/orbit/pull/1042#issuecomment-1" } });
    const both = publishButtonState(run({ published: { at: 5, url: "u" } }), [n()], "ffffffffffffffffffffffffffffffffffffffff");
    expect(both.label).toBe("Update published review…");
    expect(both.staleChip).toBe(true);
  });
  test("nothing open: enabled, and the tooltip says what the comment will hold", () => {
    const s = publishButtonState(run(), [n({ status: "resolved" }), n({ severity: "info" })], HEAD);
    expect(s).toMatchObject({ kind: "nothing-open", disabled: false });
    expect(s.tooltip).toContain("no open findings; header and verdict only");
    expect(openCount([n({ status: "resolved" }), n({ severity: "idea" }), n({ severity: "low" })])).toBe(1);
  });
});

describe("the dialog", () => {
  test("GUARD: it opens with the minimum, never the last choice", () => {
    expect(freshOptions()).toEqual({ includeHeader: true, includeOpen: true, includeResolved: false, includeDismissed: false, includeReplies: false, includeInfo: false });
    expect(DEFAULT_PUBLISH_OPTIONS.includeResolved).toBe(false);
    expect(freshOptions()).not.toBe(DEFAULT_PUBLISH_OPTIONS);
  });
  test("the dialog source starts from freshOptions", async () => {
    const dialog = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(dialog).toContain("useState<PublishOptions>(freshOptions)");
  });
  test("the list has counts, and only the open ones and the header start ticked", () => {
    const rows = optionRows([n(), n({ status: "resolved", replies: [{ id: "r", text: "x", at: 1, by: "user" }] }), n({ status: "dismissed" }), n({ severity: "idea" })], freshOptions());
    expect(rows.filter((r) => r.checked).map((r) => r.key)).toEqual(["includeHeader", "includeOpen"]);
    expect(rows.find((r) => r.key === "includeOpen")!.count).toBe(1);
    expect(rows.find((r) => r.key === "includeResolved")!.count).toBe(1);
    expect(rows.find((r) => r.key === "includeReplies")!.count).toBe(1);
    expect(rows.find((r) => r.key === "includeInfo")!.count).toBe(1);
  });
  test("Publish all ticks everything", () => {
    const all = publishAllOptions();
    expect(Object.values(all).every(Boolean)).toBe(true);
    expect(allTicked(all)).toBe(true);
    expect(allTicked(freshOptions())).toBe(false);
  });
  test("the warning says nothing leaves until Post", () => {
    expect(NOTHING_LEAVES_WARNING.startsWith("Nothing from your local review is on GitHub until you press Post")).toBe(true);
  });
  test("Post is allowed only with text, within the cap, and not while posting; no second confirm", async () => {
    expect(canPost("hello", false)).toBe(true);
    expect(canPost("", false)).toBe(false);
    expect(canPost("   \n", false)).toBe(false);
    expect(canPost("x".repeat(PUBLISH_MAX_CHARS + 1), false)).toBe(false);
    expect(canPost("x".repeat(PUBLISH_MAX_CHARS), false)).toBe(true);
    expect(canPost("hello", true)).toBe(false);
    expect(postLabel(false)).toBe("Post comment");
    expect(postLabel(true)).toBe("Update comment");
    expect(charCounter(1284)).toEqual({ text: "1,284 / 60,000", over: false });
    expect(charCounter(60001).over).toBe(true);
    const dialog = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(dialog).not.toMatch(/\bask\(|confirm\(|ConfirmDialog/);
  });
  test("Esc closes it, and not while a post is in flight", async () => {
    const dialog = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(dialog).toContain('e.key === "Escape" && !posting');
  });
  test("the edited text is sent only if it was edited", async () => {
    const dialog = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(dialog).toContain("...(dirty ? { markdown } : {})");
  });
});

describe("after publishing", () => {
  const published = run({ published: { at: 5, url: "u", options: freshOptions() } });
  test("closed findings that were not in the comment say local only", () => {
    expect(localOnly(n({ status: "resolved" }), published)).toBe(true);
    expect(localOnly(n({ status: "dismissed" }), published)).toBe(true);
    expect(localOnly(n({ status: "open" }), published)).toBe(false);
    expect(localOnly(n({ status: "resolved" }), run({ published: { at: 5, url: "u", options: publishAllOptions() } }))).toBe(false);
    expect(localOnly(n({ status: "resolved" }), run())).toBe(false);
  });
  test("the card renders the mark only when asked", () => {
    const html = (localOnly: boolean) => renderToStaticMarkup(React.createElement(NoteCard, { n: n({ status: "resolved" }), onStatus() {}, localOnly }));
    expect(html(true)).toContain("local only");
    expect(html(false)).not.toContain("local only");
  });
});

describe("where the button lives", () => {
  test("the PR header and the run header both draw it, from the one component", async () => {
    const actions = code(await src("../src/components/plugins/PluginPrActions.tsx"));
    const review = code(await src("../src/components/plugins/LocalReview.tsx"));
    expect(actions).toContain("<PublishReview");
    expect(review).toContain("{publish}");
    const bar = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(bar).toContain('size="compact"');
    expect(bar).toContain("CTRL_H.compact");
    expect(bar).not.toMatch(/height:\s*\d/);
  });
  test("it only talks to the two publish routes, and never to the PR comment routes", async () => {
    const bar = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(bar).toContain("api.pluginPublishPreview(");
    expect(bar.match(/api\.pluginPublish\(/g)).toHaveLength(1);
    expect(bar).not.toMatch(/prComment|prReview|submitReview|approve/i);
  });
});

describe("rendered preview", () => {
  const render = async (md: string) => {
    const { Md } = await import("../src/components/PrPanel.tsx");
    return renderToStaticMarkup(React.createElement(Md, { body: md }));
  };
  const finding = [
    "**Summary**", "",
    "| Severity | Count |", "| --- | --- |", "| critical | 1 |", "",
    "<details>", "<summary>Guard runs after the loop</summary>", "", "The `check()` call sits below the loop.", "", "> quoted line", "</details>", "",
    "<details open>", "<summary>Open one</summary>", "", "body", "</details>", "",
    "<!-- agentglass-review:acme-review -->",
  ].join("\n");

  test("a table becomes a table, details fold, bold and code render, quote is a quote", async () => {
    const html = await render(finding);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Guard runs after the loop</summary>");
    expect(html.match(/<details[^>]*\bopen/g)?.length).toBe(1); // only the one written `<details open>`
    expect(html).toContain("<strong>Summary</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("<blockquote");
  });
  test("the hidden marker never shows", async () => {
    expect(await render(finding)).not.toContain("agentglass-review");
  });
  test("a script or javascript: link in a finding body stays inert", async () => {
    const html = await render("<script>alert(1)</script>\n\n[open](javascript:alert(2))\n\n<img src=x onerror=alert(3)>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/href=["']javascript:/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });
  test("the zero-width break after @ in a mention survives", async () => {
    const html = await render("ping @​acme-user please");
    expect(html).toContain("@​acme-user");
  });
});

describe("preview and markdown tabs", () => {
  test("Preview is the default and the tabs are the two views", async () => {
    const { DEFAULT_PREVIEW_TAB, PREVIEW_TABS, readPreviewTab } = await import("../src/lib/publishReview.ts");
    expect(DEFAULT_PREVIEW_TAB).toBe("preview");
    expect(PREVIEW_TABS.map((t) => t.id)).toEqual(["preview", "markdown"]);
    expect(readPreviewTab()).toBe("preview"); // no sessionStorage here: blocked storage falls back
  });
  test("the dialog draws Tabs, renders Preview through Md, and edits only in the Markdown tab", async () => {
    const s = code(await src("../src/components/plugins/PublishReview.tsx"));
    expect(s).toContain("<Tabs value={tab} options={PREVIEW_TABS}");
    expect(s).toContain("useState<PreviewTab>(readPreviewTab)");
    expect(s).toContain("<Md body={markdown} />");
    expect(s).toContain('tab === "markdown" ? (');
    expect(s).toContain("onChange={(e) => p.onText(e.target.value)}");
    expect(s).toContain("rememberPreviewTab(t)");
  });
  test("what is posted is the Markdown tab's text, even after an edit", async () => {
    const s = code(await src("../src/components/plugins/PublishReview.tsx"));
    const post = s.slice(s.indexOf("const post = async () => {"));
    const fn = post.slice(0, post.indexOf("\n  };"));
    expect(fn).toContain("...(dirty ? { markdown } : {})");
    // The one textarea writes into the same state the Preview renders from.
    expect(s).toContain("onText={(t) => { setMarkdown(t); setDirty(true); }}");
  });
});

/*
 * Changing, deleting and answering a Jira comment from the card. There is no
 * renderer in this project, so the rules are asserted against the source that
 * draws and sends them, each one in the slice of the function it lives in.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  return src.slice(a, src.indexOf(to, a + from.length));
};

describe("what a comment offers", () => {
  test("edit and delete are for your own comment only, and reply only where Jira threads", async () => {
    const src = await read("components/jira/JiraActivity.tsx");
    const bar = slice(src, "{act && mode === \"read\" && (", "{/* Asked in place");
    expect(bar).toContain("{act.reply && (");
    expect(bar).toContain("{c.mine && (");
    // Both of the destructive pair sit inside the `mine` branch.
    const mine = bar.slice(bar.indexOf("{c.mine && ("));
    expect(mine).toContain('label="Edit"');
    expect(mine).toContain('label="Delete"');
    expect(bar.slice(0, bar.indexOf("{c.mine && ("))).not.toContain('label="Delete"');
  });

  test("a delete is asked in place, says it cannot be undone, and the first press sends nothing", async () => {
    const src = await read("components/jira/JiraActivity.tsx");
    const del = slice(src, 'label="Delete" title="Delete this comment"', "/>");
    expect(del).toContain('setMode("delete")');
    expect(del).not.toContain("remove(");
    const ask = slice(src, '{act && mode === "delete" && (', "</div>\n      )}");
    expect(ask).toContain("Delete this comment for good? Jira cannot bring it back.");
    expect(ask).toContain("void drop()");
    expect(ask).toContain("Keep it");
  });

  test("a changed comment sends the people it named back, and an empty one is refused before the request", async () => {
    const card = await read("components/jira/JiraCard.tsx");
    expect(card).toContain("api.jiraCommentEdit(key, c.id, text, c.mentions ?? [])");
    const act = await read("components/jira/JiraActivity.tsx");
    const save = slice(act, "const save = async () => {", "const drop = async");
    expect(save).toContain('A comment cannot be empty: delete it instead');
    expect(save.indexOf("A comment cannot be empty")).toBeLessThan(save.indexOf("act.edit("));
  });

  test("the edited and the restricted markers are drawn from the comment", async () => {
    const src = await read("components/jira/JiraActivity.tsx");
    expect(src).toContain("{c.edited && ");
    expect(src).toContain("{c.restricted && (");
    expect(src).toContain("Restricted to {c.restricted}");
  });
});

describe("what the card hands down", () => {
  test("no actions while writing is off or before the site described the card", async () => {
    const src = await read("components/jira/JiraCard.tsx");
    expect(src).toContain("const act: CommentAct | undefined = writes && detail?.edit ? {");
    // Reply is a Cloud thing: the card's own description says whether it is offered.
    expect(src).toContain("reply: detail.edit.reply,");
  });

  test("a reply is sent with the comment it answers, and a successful send forgets it", async () => {
    const src = await read("components/jira/JiraCard.tsx");
    const send = slice(src, "const send = () => {", "return (");
    expect(send).toContain("offered.current.named(say), replyTo?.id");
    // The read-back does not know the threads, so the pane carries them over.
    expect(send).toContain("keepThreads(d?.comments ?? [], sent.comments, replyTo?.id)");
    expect(send).toContain("setSay(\"\"); setReplyTo(null);");
    // A refused send keeps both the draft and whom it answers.
    expect(send.slice(0, send.indexOf("setSay(\"\"); setReplyTo(null);"))).toContain("the draft is kept");
  });

  test("a change to a comment reads the card's stamp again without losing the comments paged in", async () => {
    const src = await read("components/jira/JiraCard.tsx");
    const re = slice(src, "const restamp = async () => {", "const act:");
    expect(re).toContain("task: r.detail!.task");
    expect(re).not.toContain("comments:");
    expect(slice(src, "edit: async (c, text) => {", "remove: async").includes("void restamp()")).toBe(true);
    expect(slice(src, "remove: async (c) => {", "} : undefined;").includes("void restamp()")).toBe(true);
  });
});

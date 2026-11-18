/*
 * The Jira card's two pure rules, and the two wirings a card cannot be read
 * without.
 *
 * The comment is asserted as data because the case that matters is the one the
 * server answers with a PARTIAL success: the comment was posted and the read
 * back failed, so the card on screen must gain it from what was typed — not
 * stay as it was and invite a second send.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderTask, TaskDetail } from "../../shared/providers.ts";
import { appendComment, commentFrom, isJiraKey } from "../src/model/jiraCard.ts";

const task: ProviderTask = {
  id: "10042", customId: "ORBIT-1042", title: "Dark mode in Settings", url: "", status: "In progress",
  statusKind: "other", priority: "high", due: null, updated: 1, tags: [], list: "ORBIT", listId: "ORBIT", assignees: [],
};

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  task, description: "The rail wears the palette.", subtasks: [], checklists: [],
  comments: [{ id: "c1", who: "Ana", text: "The third case is the one that failed.", at: 1 }],
  ...over,
});

describe("appendComment", () => {
  test("the new comment is last, and the card it came from is not changed", () => {
    const before = detail();
    const after = appendComment(before, commentFrom("c2", "you", "Fixed it.", 2));
    expect(after.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(after.comments[1]).toMatchObject({ who: "you", text: "Fixed it.", mine: true });
    expect(before.comments).toHaveLength(1);
  });

  test("a comment a slower read already brought back is not drawn twice", () => {
    const before = detail();
    expect(appendComment(before, commentFrom("c1", "Ana", "The third case is the one that failed.", 1))).toBe(before);
  });
});

describe("what a Jira key is", () => {
  test("the site's shape, and nothing else", () => {
    expect(isJiraKey("ORBIT-1042")).toBe(true);
    expect(isJiraKey("orbit-1042")).toBe(true);
    expect(isJiraKey("WEB_2-7")).toBe(true);
    for (const bad of ["", "ORBIT", "ORBIT-", "-1042", "ORBIT-1042/../x", "ORBIT 1042", "a/b-1", 1042, null]) {
      expect(isJiraKey(bad)).toBe(false);
    }
  });
});

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

describe("the wiring", () => {
  test("a linked pull request opens the pull request's own screen", () => {
    const screen = src("src", "jira", "Card.tsx");
    expect(screen).toContain("openLinkedPr(host, router, pr.url)");
    // And every row that draws one goes through it, not to a browser or a no-op.
    expect(screen).toMatch(/<PrTile[^>]*onOpen=\{\(\) => openPr\(pr\)\}/);
  });

  test("a comment is posted through /jira/comment and laid on the card", () => {
    const screen = src("src", "jira", "Card.tsx");
    expect(screen).toContain('"/jira/comment", { method: "POST", body: { key: cardKey, text } }');
    expect(screen).toContain("appendComment(detail, commentFrom(");
  });

  test("the route guards the key before it reads a card", () => {
    const route = src("app", "jira", "[key].tsx");
    expect(route).toContain("isJiraKey(cardKey)");
    expect(route).toContain("<JiraCard cardKey=");
  });

  test("the board opens a card on its own route, not the ClickUp one", () => {
    const board = src("src", "jira", "Board.tsx");
    expect(board).toContain('pathname: "/jira/[key]"');
    expect(board).not.toContain('"/card/[id]"');
  });

  test("the Comment tile and the composer are off on a read-only pairing", () => {
    // The tile focuses the composer and the composer is `editable={full}`, with
    // Send disabled: a tile that stays live focuses a field nobody can type in,
    // and says nothing.
    const screen = src("src", "jira", "Card.tsx");
    const at = screen.indexOf('label="Comment"');
    const tile = screen.slice(at, screen.indexOf("/>", at));
    expect(tile).toContain("disabled={!full}");
    const field = screen.indexOf("`Write a comment on ${cardKey}`}");
    const composer = screen.slice(field, screen.indexOf("/>", field));
    expect(composer).toContain("editable={full}");
    expect(screen).toContain('busy={posting} disabled={!full || !comment.trim()}');
  });

  test("a second message is not cut short by the first one's clock", () => {
    const screen = src("src", "jira", "Card.tsx");
    const at = screen.indexOf("const say = (ok: boolean, text: string): void => {");
    const say = screen.slice(at, screen.indexOf("\n  };", at));
    expect(at).toBeGreaterThan(-1);
    expect(say).toContain("if (saidTimer.current) clearTimeout(saidTimer.current)");
    expect(say).toContain("saidTimer.current = setTimeout");
    // And the timer does not outlive the card that started it.
    expect(screen).toContain("useEffect(() => () => { if (saidTimer.current) clearTimeout(saidTimer.current); }, []);");
  });
});

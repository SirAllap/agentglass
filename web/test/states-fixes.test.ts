import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("estimate fact under the fold", () => {
  const facts = src("components/jira/JiraFacts.tsx");
  const card = src("components/jira/JiraCard.tsx");
  test("the fact is hidden only when the card's fold put the estimate in its Empty line", () => {
    expect(facts).toContain('estFolded && ask?.k !== "estimate"');
    expect(facts).not.toContain('hid("estimate")');
  });
  test("the fold decides once: est is true only when every estimate fact is empty", () => {
    expect(card).toContain('noEst.every((f) => !(f.value ?? "").trim())');
    expect(card).toContain("est = true;");
    expect(card).toContain("est: !!line && est");
    expect(card).toContain("estFolded={fold.est}");
  });
});

describe("Still reading… Cancel", () => {
  test("the Jira card read can be aborted and Cancel shows the retry state", () => {
    const card = src("components/jira/JiraCard.tsx");
    expect(card).toContain("api.jiraDetail(key, undefined, ac.signal)");
    expect(card).toContain("onCancel={cancelRead}");
    expect(card).toContain("readAbort.current?.abort()");
    expect(card).toMatch(/cancelRead[\s\S]{0,200}setErr\(/);
    expect(src("lib/api.ts")).toMatch(/jiraDetail: \(key: string, repo\?: string, signal\?: AbortSignal\)/);
  });
});

describe("ClickUp slow reads", () => {
  const tp = src("components/TasksPanel.tsx");
  test("the board read takes an abort signal and both skeletons offer Cancel", () => {
    expect(tp).toContain("source.read(id, force, id ? quickRef.current[id] : undefined, ac.signal)");
    expect(tp.match(/onCancel=\{cancelRead\}/g)?.length).toBe(2);
    expect(src("lib/boardSource.ts")).toContain("api.clickupView(id, force, signal)");
    expect(src("lib/api.ts")).toMatch(/clickupView: \(id\?: string, force = false, signal\?: AbortSignal\)/);
  });
  test("the card read can be aborted and Cancel shows the retry state", () => {
    expect(tp).toContain("api.clickupTask(t.id, signal)");
    expect(tp).toContain("onCancel={cancelCard}");
    expect(src("lib/api.ts")).toMatch(/clickupTask: \(id: string, signal\?: AbortSignal\)/);
  });
  test("a reopened board draws the last good rows, marked as refreshing", () => {
    expect(tp).toContain("lastBoard.get(source.id)");
    expect(tp).toContain("{ ...c, revalidating: true }");
    expect(tp).toContain("lastBoard.set(source.id, r)");
  });
});

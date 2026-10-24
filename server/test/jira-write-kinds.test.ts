/*
 * Writing to Jira, one kind at a time.
 *
 * The master switch decides first; under it, moving, commenting, linking and
 * assigning are four more switches, all on until somebody turns one off, so a
 * settings file from before them behaves as it did. A refused write is refused
 * before any request leaves, so none of these needs a site to answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-kinds-"));
const saved = process.env.AGENTGLASS_JIRA_WRITE;
delete process.env.AGENTGLASS_JIRA_WRITE;
const J = await import("../src/jira.ts");
const Comments = await import("../src/jiraComments.ts");
const creds = { email: "a@acme.example", site: "acme.atlassian.net", token: "t", auth: "basic" as const, api: 3 as const };

beforeAll(() => { J.__setJiraSettingsPath(join(dir, "jira-settings.json")); });
afterAll(() => { J.__setJiraSettingsPath(null); rmSync(dir, { recursive: true, force: true }); if (saved !== undefined) process.env.AGENTGLASS_JIRA_WRITE = saved; });

describe("write kinds", () => {
  test("every kind is allowed until it is switched off", () => {
    expect(J.jiraWriteKinds()).toEqual({ move: true, comment: true, link: true, assign: true });
  });

  test("a kind that is on does nothing while writing is off", () => {
    expect(J.writeRefusal("move")).toBe(J.WRITE_OFF);
  });

  test("with writing on, only the kind switched off is refused, in its own words", () => {
    J.setJiraWrites(true);
    J.setJiraWriteKind("comment", false);
    expect(J.writeRefusal("comment")).toBe("Commenting on a card is switched off in Settings");
    expect(J.writeRefusal("move")).toBeNull();
    expect(J.jiraWriteKinds()).toEqual({ move: true, comment: false, link: true, assign: true });
  });

  test("the writes themselves are refused before any request, kind by kind", async () => {
    J.setJiraWrites(true);
    for (const k of J.JIRA_WRITE_KINDS) J.setJiraWriteKind(k, false);
    const gone = (r: { ok: boolean; error?: string }, word: string) => { expect(r.ok).toBe(false); expect(r.error).toContain(word); };
    gone(await J.moveIssue(creds, "ORBIT-1", "11", 1), "Moving cards");
    gone(await J.setAssignee(creds, "ORBIT-1", "u1", 1), "Assigning a person");
    gone(await J.linkPullRequest(creds, "ORBIT-1", "https://github.com/acme/orbit/pull/7"), "Linking a pull request");
    gone(await Comments.commentOn(creds, "ORBIT-1", "hello", []), "Commenting on a card");
    gone(await Comments.editComment(creds, "ORBIT-1", "10001", "hello", []), "Commenting on a card");
    gone(await Comments.deleteComment(creds, "ORBIT-1", "10001"), "Commenting on a card");
  });

  test("turning the master switch off wins over every kind", () => {
    J.setJiraWrites(false);
    for (const k of J.JIRA_WRITE_KINDS) J.setJiraWriteKind(k, true);
    for (const k of J.JIRA_WRITE_KINDS) expect(J.writeRefusal(k)).toBe(J.WRITE_OFF);
  });
});

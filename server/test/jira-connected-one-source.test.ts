/*
 * Two cards, one question: is Jira connected?
 *
 * Settings showed "Connected" on the Connections card (/providers) and "Not
 * connected" on Jira's own page (/jira/status) for a stored token with no
 * email on basic auth. /providers asked "is there a token"; /jira/status asked
 * "can a call be made" (storedCreds). Both now ask the second.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-one-source-"));
const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const P = await import("../src/providers.ts");
const providersSrc = await Bun.file(join(import.meta.dir, "../src/providers.ts")).text();

const jiraRow = async () => (await P.providerStatuses()).find((s) => s.id === "jira")!;

beforeEach(() => { C.__setCredentialsPath(join(dir, `creds-${Math.random()}.json`)); });
afterAll(() => { C.__setCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

describe("Jira connected: /providers and /jira/status agree", () => {
  it("a token with no email on basic auth is Not connected on both", async () => {
    C.setCredential("jira", { token: "tok", site: "acme.atlassian.net", auth: "basic" });
    expect(J.storedCreds()).toBeNull();
    expect((await J.jiraStatus()).connected).toBe(false);
    expect((await jiraRow()).state).toBe("needs-auth");
  });

  it("a token with no site is Not connected on both", async () => {
    C.setCredential("jira", { token: "tok", email: "ada@example.com", auth: "basic" });
    expect((await J.jiraStatus()).connected).toBe(false);
    expect((await jiraRow()).state).toBe("needs-auth");
  });

  it("a usable credential is Connected on the card without a request", async () => {
    C.setCredential("jira", { token: "tok", email: "ada@example.com", site: "acme.atlassian.net", auth: "basic" });
    expect(J.storedCreds()).not.toBeNull();
    expect((await jiraRow()).state).toBe("connected");
  });

  it("the card reads storedCreds, not the bare token test", () => {
    const at = providersSrc.indexOf('case "jira": {');
    const body = providersSrc.slice(at, providersSrc.indexOf("\n    }\n", at));
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).toContain("jiraCreds()");
    expect(code).not.toContain('if (!hasCredential("jira"))');
  });
});

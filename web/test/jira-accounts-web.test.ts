/**
 * Jira's second account goes through Jira's own door (site, email, token) with the account's name,
 * a one-account person sends no name, and the Jira page offers the accounts section.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
let sent: string[] = [];
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: string }) => {
  const u = new URL(String(input));
  sent.push(`${init?.method ?? "GET"} ${u.pathname} ${init?.body ?? ""}`.trim());
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
});
const { api } = await import("../src/lib/api.ts");
beforeEach(() => { sent = []; });
const read = (f: string) => readFileSync(new URL(`../src/components/${f}`, import.meta.url), "utf8");

describe("connecting another Jira account", () => {
  test("the account's name rides in the body", async () => {
    await api.jiraConnect("ada@acme.example", "acme.atlassian.net", "fake-token", "work");
    expect(JSON.parse(sent[0]!.split("/jira/connect ")[1]!)).toEqual({ email: "ada@acme.example", site: "acme.atlassian.net", token: "fake-token", accountKey: "work" });
  });
  test("a one-account person sends no name", async () => {
    await api.jiraConnect("ada@acme.example", "acme.atlassian.net", "fake-token");
    expect(JSON.parse(sent[0]!.split("/jira/connect ")[1]!)).not.toHaveProperty("accountKey");
  });
  test("the accounts box asks Jira's door for Jira, the generic one for the rest", () => {
    const code = read("AccountsSection.tsx");
    expect(code).toContain("jira ? api.jiraConnect(email.trim(), site.trim(), token.trim(), name.trim()) : api.providerConnect(");
  });
  test("the Jira page shows the accounts section", () => {
    expect(read("JiraPane.tsx")).toContain('<AccountsSection provider="jira"');
  });
});

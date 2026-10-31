/*
 * A scoped API token is refused at the site and accepted at the Atlassian
 * gateway. Connecting tries the gateway only after the site said 401, keeps
 * the site's id with the connection, and sends every later call there.
 * Fake network only.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-gateway-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_BASE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_BASE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");

const CLOUD_ID = "6c1f0a52-3b7e-4d1a-9f0e-2a5b8c7d9e10";
const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const ME = { accountId: "acc-0001", displayName: "Ada Example" };

let urls: string[] = [];
let tenant: () => Response;
let siteStatus: number;
let gatewayStatus: number;

beforeEach(() => {
  urls = [];
  tenant = () => json({ cloudId: CLOUD_ID });
  siteStatus = 401;
  gatewayStatus = 200;
  C.__setCredentialsPath(join(dir, "creds.json"));
  C.__clearAll();
  J.__setJiraBase(null);
  J.__setJiraGuard({
    resolver: async () => [{ address: "104.192.136.1", family: 4 }],
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/_edge/tenant_info")) return tenant();
      if (url.startsWith(GATEWAY)) return gatewayStatus === 200 ? json(ME) : json({}, gatewayStatus);
      return siteStatus === 200 ? json(url.includes("serverInfo") ? { deploymentType: "Cloud" } : ME) : json({}, siteStatus);
    },
  });
});
afterAll(() => {
  J.__setJiraGuard(null);
  J.__setJiraBase(null);
  C.__clearAll();
  C.__setCredentialsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const connect = (site = "acme.atlassian.net") => J.connectJira({ site, email: "ada@example.com", token: "scoped-token-0001" });

describe("a scoped token goes through the gateway", () => {
  test("401 at the site, then the gateway answers: the id is stored and later calls use it", async () => {
    expect(await connect()).toEqual({ ok: true, account: "Ada Example" });
    expect(C.redacted("jira")?.cloudId).toBe(CLOUD_ID);
    urls = [];
    const r = await J.jiraCall(J.storedCreds()!, "/rest/api/3/myself", { fresh: true });
    expect(r.ok).toBe(true);
    expect(urls).toEqual([`${GATEWAY}/rest/api/3/myself`]);
  });

  test("a missing or malformed id keeps the original refusal", async () => {
    for (const body of [{}, { cloudId: "not-a-uuid" }, { cloudId: "../evil" }]) {
      tenant = () => json(body);
      expect(await connect()).toEqual({ ok: false, error: J.JIRA_REFUSED });
    }
    tenant = () => json({}, 404);
    expect(await connect()).toEqual({ ok: false, error: J.JIRA_REFUSED });
    expect(C.redacted("jira")).toBeNull();
  });

  test("the gateway also refusing is refused, and nothing is stored", async () => {
    gatewayStatus = 401;
    expect(await connect()).toEqual({ ok: false, error: J.JIRA_REFUSED });
    expect(C.redacted("jira")).toBeNull();
  });

  test("a site that accepts the token never touches the gateway", async () => {
    siteStatus = 200;
    expect(await connect()).toMatchObject({ ok: true });
    expect(urls.some((u) => u.includes("api.atlassian.com") || u.includes("tenant_info"))).toBe(false);
    expect(C.redacted("jira")?.cloudId).toBeUndefined();
  });

  test("a self-hosted site never tries the gateway", async () => {
    const r = await J.connectJira({ site: "jira.example.com", token: "pat-orbit" });
    expect(r.ok).toBe(false);
    expect(urls.some((u) => u.includes("api.atlassian.com") || u.includes("tenant_info"))).toBe(false);
  });

  test("a redirect from tenant_info to another host is not followed", async () => {
    J.__setJiraGuard({
      resolver: async () => [{ address: "104.192.136.1", family: 4 }],
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.endsWith("/_edge/tenant_info")) return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
        return json({}, 401);
      },
    });
    expect(await connect()).toEqual({ ok: false, error: J.JIRA_REFUSED });
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
  });

  test("disconnecting clears the id", async () => {
    await connect();
    J.disconnectJira();
    expect(C.redacted("jira")).toBeNull();
  });
});

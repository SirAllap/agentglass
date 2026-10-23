/*
 * Where a typed site is allowed to send the token.
 *
 * With no stand-in configured, every request goes to the validated site
 * through `guardedFetch`. These tests give it a resolver and a fetcher that
 * need no network, and watch what it is willing to send and where.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-guard-"));
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

const TOKEN = "orbit-guard-token-4c1e";
const CREDS = { email: "ada@acme.example", site: "acme.atlassian.net", token: TOKEN, auth: "basic" as const, api: 3 as const };
const CUSTOM = { site: "jira.example.com", token: "pat-orbit", auth: "bearer" as const, api: 2 as const };
const ME = JSON.stringify({ accountId: "acc-0001", displayName: "Ada Example" });

interface Sent { url: string; auth: string | null; address?: string }
let sent: Sent[] = [];
let answer: (url: string) => Response = () => new Response(ME, { headers: { "content-type": "application/json" } });

beforeEach(() => {
  sent = [];
  answer = () => new Response(ME, { headers: { "content-type": "application/json" } });
  C.__setCredentialsPath(join(dir, "creds.json"));
  C.__clearAll();
  J.__setJiraBase(null);
  J.__setJiraGuard({
    // Public for the Atlassian name, whatever else is asked.
    resolver: async (h: string) => [{ address: h.endsWith(".atlassian.net") ? "104.192.136.1" : "93.184.216.34", family: isIP(h) ? 4 : 4 }],
    fetchImpl: async (url, init, address) => {
      sent.push({ url, auth: new Headers(init.headers).get("authorization"), address });
      return answer(url);
    },
  });
});
afterEach(() => { J.__setJiraGuard(null); });
afterAll(() => {
  J.__setJiraBase(null);
  C.__clearAll();
  C.__setCredentialsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("a typed site reaches only its own host, over the guard", () => {
  test("the request goes to the rebuilt address, pinned to what the guard resolved", async () => {
    const r = await J.whoAmI(CREDS);
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{
      url: "https://acme.atlassian.net/rest/api/3/myself",
      auth: `Basic ${Buffer.from(`ada@acme.example:${TOKEN}`).toString("base64")}`,
      address: "104.192.136.1",
    }]);
  });

  test("a name that resolves to the metadata address is refused and nothing is sent", async () => {
    J.__setJiraGuard({
      resolver: async () => [{ address: "169.254.169.254", family: 4 }],
      fetchImpl: async (url, init, address) => { sent.push({ url, auth: null, address }); return answer(url); },
    });
    const r = await J.whoAmI(CREDS);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("169.254.169.254");
    expect(sent).toEqual([]);
  });

  test("one loopback answer among public ones is enough to refuse", async () => {
    J.__setJiraGuard({
      resolver: async () => [{ address: "104.192.136.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
      fetchImpl: async (url) => { sent.push({ url, auth: null }); return answer(url); },
    });
    expect((await J.whoAmI(CREDS)).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a redirect to another host is not followed and the header never goes there", async () => {
    answer = () => new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } });
    const r = await J.whoAmI(CREDS);
    expect(r.ok).toBe(false);
    expect(sent.map((s) => s.url)).toEqual(["https://acme.atlassian.net/rest/api/3/myself"]);
  });

  test("nor to another Atlassian tenant, whose site is somebody else's", async () => {
    answer = () => new Response(null, { status: 307, headers: { location: "https://other.atlassian.net/rest/api/3/myself" } });
    const r = await J.whoAmI(CREDS);
    expect(r.ok).toBe(false);
    expect(sent.map((s) => s.url)).toEqual(["https://acme.atlassian.net/rest/api/3/myself"]);
  });

  test("nor down to plain http on the same host", async () => {
    answer = () => new Response(null, { status: 301, headers: { location: "http://acme.atlassian.net/rest/api/3/myself" } });
    expect((await J.whoAmI(CREDS)).ok).toBe(false);
    expect(sent.length).toBe(1);
  });

  test("a redirect to the same host is followed", async () => {
    let n = 0;
    answer = () => (n++ === 0
      ? new Response(null, { status: 302, headers: { location: "https://acme.atlassian.net/rest/api/3/myself?again=1" } })
      : new Response(ME));
    expect((await J.whoAmI(CREDS)).ok).toBe(true);
    expect(sent.length).toBe(2);
  });

  test("a custom host is reached the same way, with the bearer header", async () => {
    const r = await J.whoAmI(CUSTOM);
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ url: "https://jira.example.com/rest/api/2/myself", auth: "Bearer pat-orbit", address: "93.184.216.34" }]);
  });

  test("a port and a context path are kept in the address", async () => {
    await J.whoAmI({ ...CUSTOM, site: "jira.example.com:8443/jira" });
    expect(sent[0]!.url).toBe("https://jira.example.com:8443/jira/rest/api/2/myself");
  });

  test("connect with a look-alike site sends nothing at all", async () => {
    for (const site of ["notatlassian.net", "acme.atlassian.net.evil.example", "169.254.169.254", "127.0.0.1", "http://acme.atlassian.net", "localhost", "[::1]"]) {
      expect((await J.connectJira({ email: "ada@acme.example", site, token: TOKEN })).ok).toBe(false);
    }
    expect(sent).toEqual([]);
    expect(C.hasCredential("jira")).toBe(false);
  });

  test("connect through the guard stores the host it rebuilt, not the text it was given", async () => {
    const r = await J.connectJira({ email: "ada@acme.example", site: "  HTTPS://ACME.atlassian.net/  ", token: TOKEN });
    expect(r).toEqual({ ok: true, account: "Ada Example" });
    expect(C.redacted("jira")!.site).toBe("acme.atlassian.net");
    expect(sent.map((x) => x.url)).toEqual(["https://acme.atlassian.net/rest/api/2/serverInfo", "https://acme.atlassian.net/rest/api/3/myself"]);
  });
});

/*
 * Where a NAME is allowed to lead. A custom site may be an internal Jira on a
 * private network, so the LAN is open; loopback and link-local (where the cloud
 * metadata address lives) are not, at connect time or at any request after.
 */
describe("which addresses a name may resolve to", () => {
  const answering = (...addresses: string[]) => J.__setJiraGuard({
    resolver: async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    fetchImpl: async (url, init, address) => { sent.push({ url, auth: new Headers(init.headers).get("authorization"), address }); return answer(url); },
  });

  for (const lan of ["10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.20", "100.64.0.5", "fd12:3456::7"]) {
    test(`${lan} is an internal Jira and is allowed`, async () => {
      answering(lan);
      expect((await J.whoAmI(CUSTOM)).ok).toBe(true);
      expect(sent.map((s) => s.address)).toEqual([lan]);
    });
  }

  for (const bad of [
    "127.0.0.1", "127.5.5.5", "0.0.0.0", "169.254.169.254", "169.254.0.7",
    "::1", "::", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1",
  ]) {
    test(`${bad} is refused, with nothing sent`, async () => {
      answering(bad);
      const r = await J.whoAmI(CUSTOM);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Not contacting that address");
      expect(sent).toEqual([]);
    });
  }

  test("one loopback answer among LAN ones is enough to refuse", async () => {
    answering("10.1.2.3", "127.0.0.1");
    expect((await J.whoAmI(CUSTOM)).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a name that was fine when connecting and points at loopback afterwards is refused on the next request", async () => {
    answering("10.1.2.3");
    expect((await J.whoAmI(CUSTOM)).ok).toBe(true);
    expect(sent.length).toBe(1);
    answering("127.0.0.1");
    const again = await J.jiraCall(CUSTOM, "/rest/api/2/project", { fresh: true });
    expect(again.ok).toBe(false);
    expect(sent.length).toBe(1);
  });

  test("the connection is made to the address that was judged, not to a second answer", async () => {
    let asked = 0;
    J.__setJiraGuard({
      // Public the first time, loopback every time after: a name that rebinds.
      resolver: async () => [{ address: asked++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
      fetchImpl: async (url, init, address) => { sent.push({ url, auth: null, address }); return answer(url); },
    });
    expect((await J.whoAmI(CUSTOM)).ok).toBe(true);
    expect(sent.map((s) => s.address)).toEqual(["93.184.216.34"]);
    expect(asked).toBe(1);
  });

  test("connecting to a custom host that resolves to loopback or link-local stores nothing", async () => {
    for (const a of ["127.0.0.1", "169.254.169.254"]) {
      answering(a);
      expect((await J.connectJira({ site: "jira.example.com", token: "pat-orbit" })).ok).toBe(false);
    }
    expect(sent).toEqual([]);
    expect(C.hasCredential("jira")).toBe(false);
  });

  test("a redirect from a custom host to its own loopback name, or another port, is not followed", async () => {
    for (const to of ["https://jira.example.com:9000/x", "https://localhost/x", "http://jira.example.com/x", "https://jira.example.org/x"]) {
      sent = [];
      answer = () => new Response(null, { status: 302, headers: { location: to } });
      expect((await J.whoAmI(CUSTOM)).ok).toBe(false);
      expect(sent.length).toBe(1);
    }
  });
});

describe("the source says the same", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "jira.ts"), "utf8");
  // Code only: a comment may say "fetch(" while explaining why there is one.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

  test("the only plain fetches are the two behind the operator's base address: a call's, and a file's", () => {
    const lines = code.split("\n");
    const at = lines.flatMap((l, i) => (/(^|[^A-Za-z_.])fetch\(/.test(l) ? [i] : []));
    expect(at.length).toBe(2);
    // Each sits on a line that names the override or directly under the `if` that does.
    for (const i of at) expect(lines.slice(Math.max(0, i - 1), i + 1).join("\n"), lines[i]).toContain("baseOverride");
  });

  test("the connection is always made under the loopback and link-local refusal", () => {
    expect(code).toContain("{ refuses: refusesAddress, ...guardOpts }");
    expect(code).toContain("privateAddress(a) && !lanAddress(a)");
  });

  test("a stand-in is never chosen by what was typed", () => {
    // The origin is the override or the validated host, nothing else.
    expect(code).toContain("const origin = baseOverride ?? `https://${site.site}`;");
    expect(code).toContain("const site = parseSite(creds.site);");
  });

  test("no sentence is built from a response", () => {
    // Bodies are cancelled, never read for text; only a JSON success is parsed.
    expect(code.match(/\.text\(\)/g)).toBeNull();
    expect(code.match(/res\.json\(\)/g)?.length).toBe(1);
  });
});

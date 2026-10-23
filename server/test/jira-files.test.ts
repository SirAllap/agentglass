/*
 * The files on a Jira card: what is shown in place and what is only handed over, the one named host a Cloud site's
 * redirect may reach, what the page is never told, the limits, and a file added or taken off. Against the Cloud fake
 * (REST v3, a 303 to a stand-in media host) and its Data Center personality (REST v2, served from the site), and through
 * the guarded path with a fake fetch for the real host rule.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, MEDIA_TOKEN, TINY_PNG, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

import myself from "./fixtures/jira/myself.json";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-files-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_WRITE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const K = await import("../src/jiraComments.ts");
const F = await import("../src/jiraFiles.ts");
const D = await import("../src/jiraDoor.ts");
const N = await import("../src/net.ts");
const credFile = join(dir, "creds.json");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  J.__setJiraGuard(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("deliver: what is drawn in place", () => {
  test("a picture or a video only when the site's type and the bytes' type are the same listed entry", () => {
    expect(F.deliver("image/png", "image/png", false)).toEqual({ inline: true, type: "image/png" });
    expect(F.deliver("image/jpeg", "image/jpeg; charset=binary", false)).toEqual({ inline: true, type: "image/jpeg" });
    expect(F.deliver("video/quicktime", "video/quicktime", false)).toEqual({ inline: true, type: "video/mp4" });
  });
  test("SVG, HTML, PDF, script and anything unnamed is a download of a type that cannot run", () => {
    for (const t of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/pdf", "text/javascript", "application/octet-stream", "", "image/x-icon"]) {
      expect(F.deliver(t, t, false)).toEqual({ inline: false, type: "application/octet-stream" });
    }
  });
  test("a site that says picture and bytes that say page are a download, and the other way round", () => {
    expect(F.deliver("image/png", "text/html", false).inline).toBe(false);
    expect(F.deliver("text/html", "image/png", false).inline).toBe(false);
    expect(F.deliver("image/png", "image/jpeg", false).inline).toBe(false);
  });
  test("a download asked for is a download of a picture too", () => {
    expect(F.deliver("image/png", "image/png", true)).toEqual({ inline: false, type: "application/octet-stream" });
  });
  test("inlineKind", () => {
    expect(F.inlineKind("IMAGE/PNG")).toBe("image");
    expect(F.inlineKind("video/webm; codecs=vp9")).toBe("video");
    expect(F.inlineKind("image/svg+xml")).toBeNull();
  });
});

describe("names and limits", () => {
  test("a name is a plain name: no path, no quote, no control, never empty", () => {
    expect(F.fileName("../../etc/passwd")).toBe("passwd");
    expect(F.fileName("C:\\temp\\a b.txt")).toBe("a b.txt");
    expect(F.fileName('a"b\r\nc.png')).toBe("abc.png");
    expect(F.fileName("...hidden")).toBe("hidden");
    expect(F.fileName("")).toBe("file");
    expect(F.fileName(7)).toBe("file");
    expect(F.fileName("x".repeat(500)).length).toBe(200);
  });
  test("a download's disposition cannot be broken out of", () => {
    const d = F.dispositionOf('re"port;\r\nX-Evil: 1.txt');
    expect(d).not.toMatch(/[\r\n]/);
    expect(d.startsWith('attachment; filename="')).toBe(true);
    expect(d.slice(d.indexOf('"') + 1, d.indexOf('";'))).not.toContain('"');
    expect(F.dispositionOf("vue—é.png")).toContain("filename*=UTF-8''vue%E2%80%94%C3%A9.png");
  });
  test("the lines: 25 MB in place, 100 MB to download, 1 MB a thumbnail", () => {
    expect(F.tooBig(F.INLINE_MAX, false, true)).toBeNull();
    expect(F.tooBig(F.INLINE_MAX + 1, false, true)).toMatch(/too large to show/);
    expect(F.tooBig(F.INLINE_MAX + 1, false, false)).toBeNull();
    expect(F.tooBig(F.DOWNLOAD_MAX + 1, false, false)).toMatch(/too large to carry/);
    expect(F.tooBig(F.THUMB_MAX + 1, true, true)).not.toBeNull();
    expect(F.tooBig(0, false, true)).toBeNull();
  });
  test("a stream with no length is counted and cut at the line", async () => {
    // Finite, so a missing cap shows as a read that finishes where it should have been cut, not as a hang.
    const big = new ReadableStream<Uint8Array>({ start(c) { for (let n = 0; n < 100; n++) c.enqueue(new Uint8Array(1024)); c.close(); } });
    await expect(new Response(F.capped(big, 10 * 1024)).arrayBuffer()).rejects.toThrow();
    const small = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(100)); c.close(); } });
    expect((await new Response(F.capped(small, 1024)).arrayBuffer()).byteLength).toBe(100);
  });
});

describe("siteThenNamedHost: the one host a redirect may reach", () => {
  const h = N.siteThenNamedHost("acme.atlassian.net", "api.media.atlassian.com", { Authorization: "Basic SECRET" });
  test("the site and the named host, over https, and nothing else", () => {
    expect(h.allow(new URL("https://acme.atlassian.net/rest/api/3/attachment/content/1"))).toBeNull();
    expect(h.allow(new URL("https://api.media.atlassian.com/file/abc?token=T"))).toBeNull();
    for (const bad of [
      "http://acme.atlassian.net/x", "http://api.media.atlassian.com/x", "https://other.atlassian.net/x", "https://api.media.atlassian.com.evil.example/x",
      "https://evil.example/api.media.atlassian.com", "https://media.atlassian.com/x", "https://api.media.atlassian.com:8443/x", "https://169.254.169.254/latest",
      "https://127.0.0.1/x", "https://notapi.media.atlassian.com/x", "ftp://api.media.atlassian.com/x",
    ]) expect(h.allow(new URL(bad)), bad).not.toBeNull();
  });
  test("the credential goes to the site's hop and not to the named host's", () => {
    expect(h.initFor(new URL("https://acme.atlassian.net/x"))).toEqual({ headers: { Authorization: "Basic SECRET" } });
    expect(h.initFor(new URL("https://api.media.atlassian.com/file/abc?token=T"))).toEqual({ headers: {} });
  });
});

/** The real host rule, through the guarded path and a fetch that answers by script. */
describe("jiraFetch on the guarded path (no network)", () => {
  const creds = { site: "acme.atlassian.net", token: "tok", auth: "basic" as const, email: "ada@acme.example", api: 3 as const };
  const seen: { url: string; auth: string | null }[] = [];
  const script = (steps: Record<string, () => Response>) => {
    seen.length = 0;
    J.__setJiraBase(null);
    J.__setJiraGuard({
      hostCheck: async () => null,
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: new Headers(init.headers).get("authorization") });
        const make = steps[new URL(url).host];
        return make ? make() : new Response("no", { status: 599 });
      },
    });
  };
  afterEach(() => J.__setJiraGuard(null));
  const to = (loc: string) => () => new Response(null, { status: 303, headers: { location: loc } });

  test("the site, then the named host: the credential on the first hop only, the bytes back", async () => {
    script({ "acme.atlassian.net": to("https://api.media.atlassian.com/file/abc?token=MEDIA-SECRET"), "api.media.atlassian.com": () => new Response("png", { headers: { "content-type": "image/png" } }) });
    const r = await J.jiraFetch(creds, "/rest/api/3/attachment/content/10001", { timeoutMs: 1000 });
    expect("res" in r && await r.res.text()).toBe("png");
    expect(seen.map((s) => s.url.split("?")[0])).toEqual(["https://acme.atlassian.net/rest/api/3/attachment/content/10001", "https://api.media.atlassian.com/file/abc"]);
    expect(seen[0]!.auth).toStartWith("Basic ");
    expect(seen[1]!.auth).toBeNull();
  });
  test("a redirect to any other host is refused, and the answer names neither the address nor its token", async () => {
    for (const where of ["https://evil.example/steal?token=MEDIA-SECRET", "http://api.media.atlassian.com/file/x?token=MEDIA-SECRET", "https://169.254.169.254/latest/meta-data?token=MEDIA-SECRET", "https://api.media.atlassian.com.evil.example/x?token=MEDIA-SECRET"]) {
      script({ "acme.atlassian.net": to(where) });
      const r = await J.jiraFetch(creds, "/rest/api/3/attachment/content/10001", { timeoutMs: 1000 });
      expect("error" in r, where).toBe(true);
      const said = JSON.stringify(r);
      expect(said).not.toContain("MEDIA-SECRET");
      expect(said).not.toContain("evil.example");
      expect(said).not.toContain("169.254");
      expect(seen.length, `${where} was fetched`).toBe(1);
    }
  });
  test("a loop of redirects stops", async () => {
    script({ "acme.atlassian.net": to("https://api.media.atlassian.com/a"), "api.media.atlassian.com": to("https://acme.atlassian.net/b") });
    const r = await J.jiraFetch(creds, "/rest/api/3/attachment/content/10001", { timeoutMs: 1000 });
    expect("error" in r).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(6);
  });
});

describe("a file that takes longer than the first-byte limit to arrive", () => {
  const creds = { site: "acme.atlassian.net", token: "tok", auth: "basic" as const, email: "ada@acme.example", api: 3 as const };
  afterEach(() => J.__setJiraGuard(null));
  /** A fetch that honours its signal the way a real one does: an abort errors the body being read. */
  const slowBody = (gapMs: number, chunks: number) => async (_u: string, init: RequestInit) => {
    let n = 0;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { init.signal?.addEventListener("abort", () => { try { c.error(init.signal!.reason); } catch { /* already closed */ } }); },
      async pull(c) {
        await Bun.sleep(gapMs);
        if (n++ < chunks) c.enqueue(new Uint8Array(10)); else c.close();
      },
    }), { headers: { "content-type": "video/mp4" } });
  };
  test("is carried whole: the limit is for the first byte and not for the body", async () => {
    J.__setJiraBase(null);
    J.__setJiraGuard({ hostCheck: async () => null, fetchImpl: slowBody(60, 5) });
    const r = await J.jiraFetch(creds, "/rest/api/3/attachment/content/10001", { timeoutMs: 150 });
    expect("res" in r).toBe(true);
    if ("res" in r) expect((await r.res.arrayBuffer()).byteLength).toBe(50);
  });
  test("no first byte in time is still the sentence", async () => {
    J.__setJiraBase(null);
    J.__setJiraGuard({ hostCheck: async () => null, fetchImpl: (_u, init) => new Promise((_, no) => init.signal!.addEventListener("abort", () => no(init.signal!.reason))) });
    const r = await J.jiraFetch(creds, "/rest/api/3/attachment/content/10001", { timeoutMs: 50 });
    expect("error" in r && r.error).toBe("Jira did not answer in time");
  });
  test("idleLimited ends a stalled stream and lets a slow, steady one through", async () => {
    const steady = new ReadableStream<Uint8Array>({ async pull(c) { await Bun.sleep(30); c.enqueue(new Uint8Array(1)); if (++steadyN >= 6) c.close(); } });
    let steadyN = 0;
    expect((await new Response(F.idleLimited(steady, 100)).arrayBuffer()).byteLength).toBe(6);
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    await expect(new Response(F.idleLimited(stalled, 50)).arrayBuffer()).rejects.toThrow();
  });
});

describe("Range on the guarded path", () => {
  const creds = { site: "acme.atlassian.net", token: "tok", auth: "basic" as const, email: "ada@acme.example", api: 3 as const };
  afterEach(() => J.__setJiraGuard(null));
  test("goes to the media host and the credential does not", async () => {
    const seen: { host: string; range: string | null; auth: string | null }[] = [];
    J.__setJiraBase(null);
    J.__setJiraGuard({
      hostCheck: async () => null,
      fetchImpl: async (url, init) => {
        const h = new Headers(init.headers);
        const host = new URL(url).host;
        seen.push({ host, range: h.get("range"), auth: h.get("authorization") });
        return host === "acme.atlassian.net" ? new Response(null, { status: 303, headers: { location: "https://api.media.atlassian.com/file/abc?token=T" } }) : new Response("x", { status: 206 });
      },
    });
    const r = await J.jiraFetch(creds, "/rest/api/3/attachment/content/10001", { range: "bytes=0-9", timeoutMs: 1000 });
    expect("res" in r).toBe(true);
    expect(seen.map((s) => s.range)).toEqual(["bytes=0-9", "bytes=0-9"]);
    expect(seen[0]!.auth).toStartWith("Basic ");
    expect(seen[1]!.auth).toBeNull();
  });
});

describe("a Data Center site with a context path", () => {
  const creds = { site: "jira.acme.example/jira", token: "pat", auth: "bearer" as const, api: 2 as const };
  afterEach(() => J.__setJiraGuard(null));
  test("is asked for a file once under its context, not twice", async () => {
    const urls: string[] = [];
    J.__setJiraBase(null);
    J.__setJiraGuard({ hostCheck: async () => null, fetchImpl: async (url) => { urls.push(url); return new Response("png", { headers: { "content-type": "image/png" } }); } });
    F.rememberFiles(creds, "ORBIT-1", { attachment: [
      { id: "10001", filename: "shot.png", mimeType: "image/png", size: 3, content: "https://jira.acme.example/jira/secure/attachment/10001/shot.png", thumbnail: "https://jira.acme.example/jira/secure/thumbnail/10001/_thumb_10001.png" },
      { id: "10002", filename: "off.png", mimeType: "image/png", size: 3, content: "https://jira.acme.example/other/secure/attachment/10002/off.png" },
    ] }, "");
    const a = await F.serveFile(creds, { key: "ORBIT-1", id: "10001", thumb: false, download: false, range: null });
    expect("res" in a && await a.res.text()).toBe("png");
    expect(urls).toEqual(["https://jira.acme.example/jira/secure/attachment/10001/shot.png"]);
    const t = await F.serveFile(creds, { key: "ORBIT-1", id: "10001", thumb: true, download: false, range: null });
    expect("res" in t).toBe(true);
    expect(urls[1]).toBe("https://jira.acme.example/jira/secure/thumbnail/10001/_thumb_10001.png");
    // An address under another path of the same host is not the site's own.
    const off = await F.serveFile(creds, { key: "ORBIT-1", id: "10002", thumb: false, download: false, range: null });
    expect("error" in off && off.status).toBe(404);
  });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`files, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    let creds: import("../src/jira.ts").JiraCreds;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraGuard(null);
      J.__setJiraBase(fake.base);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      creds = J.storedCreds()!;
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });

    const first = () => Object.keys(fake.state.issues)[0]!;

    /** Put files on the first card as the site's data, then read the card the way the screen does. */
    async function seed(files: NonNullable<import("./fixtures/fakeJira.ts").FakeIssue["attachments"]>) {
      const k = first();
      fake.state.issues[k]!.attachments = files;
      const r = await K.readDetail(creds, k, { fresh: true });
      expect(r.ok).toBe(true);
      return { k, rows: r.data!.detail.attachments ?? [] };
    }
    // The fake stores a file's author by the fixture's account id and shows it as that account's key on Data Center.
    const me = () => myself.accountId;
    const file = (id: string, filename: string, mimeType: string, extra: Record<string, unknown> = {}) =>
      ({ id, filename, size: 120, mimeType, created: "2026-10-01T10:00:00.000+0000", author: me(), ...extra });
    const ask = (k: string, id: string, o: Partial<import("../src/jiraFiles.ts").FileAsk> = {}) => F.serveFile(creds, { key: k, id, thumb: false, download: false, range: null, ...o });
    const drain = async (a: Awaited<ReturnType<typeof F.serveFile>>) => { if ("res" in a) await a.res.arrayBuffer(); };
    const fileCalls = () => fake.requests.filter((r) => /attachment|\/media\/|\/secure\//.test(r.path) || /^\/media|^\/secure/.test(r.path));

    test("the card's rows point at this app's own route and carry no address of the site's", async () => {
      const { k, rows } = await seed([file("10001", "shot.png", "image/png"), file("10002", "notes.txt", "text/plain"), file("10003", "page.html", "text/html")]);
      expect(rows.map((r) => r.url)).toEqual([`/jira/file?key=${k}&id=10001`, `/jira/file?key=${k}&id=10002`, `/jira/file?key=${k}&id=10003`]);
      expect(rows[0]!.thumb).toBe(`/jira/file?key=${k}&id=10001&thumb=1`);
      expect(rows[1]!.thumb).toBeUndefined();
      expect(rows.every((r) => r.mine)).toBe(true);
      const said = JSON.stringify(rows);
      expect(said).not.toContain("atlassian.net");
      expect(said).not.toContain("jira.acme.example");
      expect(said).not.toContain("token");
    });
    test("opening the card asks for no file at all", async () => {
      await seed([file("10001", "shot.png", "image/png")]);
      expect(fileCalls()).toEqual([]);
    });
    test("a picture is shown in place: its bytes, a listed type, nosniff, a CSP that allows nothing; never the site's address", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png", { bytes: TINY_PNG })]);
      const a = await ask(k, "10001");
      expect("res" in a).toBe(true);
      if (!("res" in a)) return;
      expect(a.res.headers.get("content-type")).toBe("image/png");
      expect(a.res.headers.get("content-disposition")).toBeNull();
      expect(a.res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(a.res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(new Uint8Array(await a.res.arrayBuffer())).toEqual(new Uint8Array(Buffer.from(TINY_PNG, "base64")));
      const all = JSON.stringify([...a.res.headers.entries()]);
      expect(all).not.toContain(MEDIA_TOKEN);
      expect(all).not.toContain("/media/");
      expect(all.toLowerCase()).not.toContain("location");
    });
    if (!dc) test("Cloud: the site is asked with the credential and the media hop without it", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png")]);
      fake.requests.length = 0;
      await drain(await ask(k, "10001"));
      const content = fake.requests.find((r) => r.path.endsWith("/attachment/content/10001"));
      const media = fake.requests.find((r) => r.path.startsWith("/media/file/"));
      expect(content?.auth).toStartWith("Basic ");
      expect(media).toBeDefined();
      expect(media!.auth).toBeNull();
      expect(media!.query.token).toBe(MEDIA_TOKEN);
    });
    if (dc) test("Data Center: served from the site itself, signed in, no redirect", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png")]);
      fake.requests.length = 0;
      await drain(await ask(k, "10001"));
      expect(fake.requests.map((r) => r.path)).toEqual(["/secure/attachment/10001/shot.png"]);
      expect(fake.requests[0]!.auth).not.toBeNull();
    });
    test("an HTML page, an SVG and a PDF are downloads that cannot run, however they are named", async () => {
      const { k } = await seed([
        file("10001", "page.html", "text/html", { bytes: Buffer.from("<script>alert(1)</script>").toString("base64") }),
        file("10002", "logo.svg", "image/svg+xml", { bytes: Buffer.from("<svg onload=alert(1)/>").toString("base64") }),
        file("10003", "doc.pdf", "application/pdf"),
        file("10004", "innocent.png", "text/html", { bytes: Buffer.from("<script>1</script>").toString("base64") }),
      ]);
      for (const id of ["10001", "10002", "10003", "10004"]) {
        const a = await ask(k, id);
        expect("res" in a, id).toBe(true);
        if (!("res" in a)) continue;
        expect(a.res.headers.get("content-type"), id).toBe("application/octet-stream");
        expect(a.res.headers.get("content-disposition"), id).toStartWith("attachment;");
        expect(a.res.headers.get("x-content-type-options")).toBe("nosniff");
        void a.res.body?.cancel();
      }
    });
    test("a picture can be asked for as a download", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png")]);
      const a = await ask(k, "10001", { download: true });
      expect("res" in a && a.res.headers.get("content-disposition")).toStartWith("attachment; filename=\"shot.png\"");
    });
    test("only what the card read listed: another id, another card, a malformed id and no read at all ask the site for nothing", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png")]);
      const other = Object.keys(fake.state.issues).find((x) => x !== k)!;
      fake.requests.length = 0;
      for (const [kk, id] of [[k, "10099"], [other, "10001"], [k, "../10001"], [k, "10001/../1"], ["nope", "10001"], [k, ""], [k, "1e3"]] as const) {
        const a = await ask(kk, id);
        expect("error" in a && a.status, `${kk} ${id}`).toBe(404);
      }
      expect(fake.requests).toEqual([]);
    });
    if (dc) test("Data Center: a file the site says lives on another host, or over plain http, is not fetched at all", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png")]);
      const raw = (id: string, content: string) => ({ id, filename: `${id}.png`, mimeType: "image/png", size: 10, content, author: {} });
      F.rememberFiles(creds, k, { attachment: [raw("10011", "https://evil.example/secure/attachment/10011/x.png"), raw("10012", "http://jira.acme.example/secure/attachment/10012/x.png"), raw("10013", "https://jira.acme.example.evil.example/secure/attachment/10013/x.png")] }, "");
      fake.requests.length = 0;
      for (const id of ["10011", "10012", "10013"]) {
        const a = await ask(k, id);
        expect("error" in a && a.status, id).toBe(404);
      }
      expect(fake.requests).toEqual([]);
    });
    test("a file over the line is refused before a byte is read", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png", { size: F.INLINE_MAX + 1 }), file("10002", "huge.bin", "application/zip", { size: F.DOWNLOAD_MAX + 1 })]);
      const inline = await ask(k, "10001");
      expect("error" in inline && inline.status).toBe(413);
      const zip = await ask(k, "10002");
      expect("error" in zip && zip.status).toBe(413);
      expect(fake.requests.some((r) => r.path.startsWith("/media/file"))).toBe(false);
    });
    test("a thumbnail is asked once and kept; only a picture the site made a small one for has one", async () => {
      const { k, rows } = await seed([file("10001", "shot.png", "image/png"), file("10002", "big.png", "image/png", { noThumb: true }), file("10003", "a.txt", "text/plain")]);
      expect(rows.map((r) => !!r.thumb)).toEqual([true, false, false]);
      fake.requests.length = 0;
      for (let n = 0; n < 3; n++) {
        const t = await ask(k, "10001", { thumb: true });
        expect("res" in t && t.res.headers.get("content-type")).toBe("image/png");
        if ("res" in t) await t.res.arrayBuffer();
      }
      expect(fake.requests.filter((r) => /\/(attachment|secure)\/thumbnail\//.test(r.path)).length).toBe(1);
      const none = await ask(k, "10003", { thumb: true });
      expect("error" in none && none.status).toBe(404);
    });
    test("a small picture is judged by its own size and not by the big picture's", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png", { size: F.INLINE_MAX * 2 })]);
      const t = await ask(k, "10001", { thumb: true });
      expect("res" in t).toBe(true);
      if ("res" in t) await t.res.arrayBuffer();
    });
    test("a range is passed on, so a video can seek", async () => {
      const { k } = await seed([file("10001", "clip.mp4", "video/mp4")]);
      fake.requests.length = 0;
      const a = await ask(k, "10001", { range: "bytes=0-9" });
      if ("res" in a) await a.res.arrayBuffer();
      expect(fake.requests.some((r) => r.range === "bytes=0-9")).toBe(true);
    });
    test("a site that says the file is gone or not yours is a sentence, not the site's words", async () => {
      const { k } = await seed([file("10001", "shot.png", "image/png")]);
      fake.state.issues[k]!.attachments = [];
      const a = await ask(k, "10001");
      expect("error" in a && a.status).toBe(404);
      expect(JSON.stringify(a)).not.toContain("does not exist");
    });

    // --- adding ---------------------------------------------------------------------------------------------
    const bytes = (s: string) => new TextEncoder().encode(s);
    test("a file is added with the anti-forgery header and its name, and the card comes back with it", async () => {
      const { k } = await seed([]);
      fake.requests.length = 0;
      const r = await F.attachFile(creds, k, "build.log", bytes("ok\n"));
      expect(r.ok).toBe(true);
      const post = fake.requests.find((x) => x.method === "POST" && x.path.endsWith("/attachments"));
      expect(post?.token).toBe("no-check");
      expect(post?.body).toEqual({ file: "build.log" });
      expect(r.detail?.attachments?.map((a) => a.title)).toEqual(["build.log"]);
      expect(r.detail?.attachments?.[0]!.mine).toBe(true);
      expect(r.added).toBeDefined();
    });
    test("a file's own path is not its name", async () => {
      const { k } = await seed([]);
      const r = await F.attachFile(creds, k, "../../etc/cron.d/x", bytes("1"));
      expect(r.detail?.attachments?.map((a) => a.title)).toEqual(["x"]);
    });
    test("with writing off, nothing is sent", async () => {
      const { k } = await seed([]);
      delete process.env.AGENTGLASS_JIRA_WRITE;
      fake.requests.length = 0;
      const r = await F.attachFile(creds, k, "a.txt", bytes("1"));
      expect(r).toEqual({ ok: false, error: "Writing to Jira is switched off" });
      expect(fake.requests).toEqual([]);
    });
    test("empty, over 25 MB and not a card id send nothing", async () => {
      const { k } = await seed([]);
      fake.requests.length = 0;
      expect((await F.attachFile(creds, k, "a.txt", new Uint8Array(0))).error).toMatch(/empty/);
      expect((await F.attachFile(creds, k, "a.txt", new Uint8Array(F.UPLOAD_MAX + 1))).error).toMatch(/at most 25 MB/);
      expect((await F.attachFile(creds, "nope", "a.txt", bytes("1"))).error).toMatch(/not a Jira card id/);
      expect(fake.requests).toEqual([]);
    });
    test("a site that cannot answer says the file may have been added, and a refusal says only ours", async () => {
      const { k } = await seed([]);
      fake.fail({ path: "/issue/*", method: "POST", status: 500, times: 1 });
      const lost = await F.attachFile(creds, k, "a.txt", bytes("1"));
      expect(lost.error).toMatch(/may have been added/);
      fake.fail({ path: "/issue/*", method: "POST", status: 403, times: 1 });
      const denied = await F.attachFile(creds, k, "a.txt", bytes("1"));
      expect(denied.error).toMatch(/cannot do that/);
    });

    // --- taking off -----------------------------------------------------------------------------------------
    test("one of your own is taken off by the id the card holds, and it is gone from the card and from what is offered", async () => {
      const { k } = await seed([file("10001", "mine.png", "image/png"), file("10002", "theirs.png", "image/png", { author: "other" })]);
      const r = await F.removeFile(creds, k, "10001");
      expect(r.ok).toBe(true);
      expect(r.detail?.attachments?.map((a) => a.title)).toEqual(["theirs.png"]);
      expect(fake.requests.filter((x) => x.method === "DELETE").map((x) => x.path)).toEqual(["/attachment/10001"]);
      const again = await ask(k, "10001");
      expect("error" in again && again.status).toBe(404);
    });
    test("somebody else's file, a file the card does not hold and a malformed id send no delete", async () => {
      const { k } = await seed([file("10002", "theirs.png", "image/png", { author: "other" })]);
      fake.requests.length = 0;
      expect((await F.removeFile(creds, k, "10002")).error).toMatch(/only take off a file you added/);
      expect((await F.removeFile(creds, k, "10404")).error).toMatch(/not a file this card has/);
      expect((await F.removeFile(creds, k, "1; DROP")).error).toMatch(/not a file this card has/);
      expect((await F.removeFile(creds, k, 10002 as unknown as string)).error).toMatch(/not a file this card has/);
      expect(fake.requests.filter((x) => x.method === "DELETE")).toEqual([]);
    });
    test("with writing off, nothing is read or sent", async () => {
      const { k } = await seed([file("10001", "mine.png", "image/png")]);
      delete process.env.AGENTGLASS_JIRA_WRITE;
      fake.requests.length = 0;
      expect(await F.removeFile(creds, k, "10001")).toEqual({ ok: false, error: "Writing to Jira is switched off" });
      expect(fake.requests).toEqual([]);
    });

    // --- the door -------------------------------------------------------------------------------------------
    test("the door's attach takes words or base64, never both, never a path; unattach needs confirm", async () => {
      const { k } = await seed([]);
      const both = await D.runDoor("attach", { key: k, name: "a.txt", text: "x", data: "eA==" });
      expect(both.status).toBe(400);
      const none = await D.runDoor("attach", { key: k, name: "a.txt" });
      expect(none.status).toBe(400);
      const badData = await D.runDoor("attach", { key: k, name: "a.txt", data: "not base64!" });
      expect(badData.body.error).toMatch(/not base64/);
      const ok = await D.runDoor("attach", { key: k, name: "a.txt", text: "words" });
      expect(ok.status).toBe(200);
      expect((ok.body.state as Record<string, unknown>).added).toBe(true);
      const card = await D.runDoor("card", { key: k });
      const row = ((card.body.untrusted as { attachments: { fileId: string; name: string; mine?: boolean }[] }).attachments)[0]!;
      expect(row).toMatchObject({ name: "a.txt", mine: true });
      const noConfirm = await D.runDoor("unattach", { key: k, id: row.fileId });
      expect(noConfirm.status).toBe(400);
      expect(fake.requests.filter((x) => x.method === "DELETE")).toEqual([]);
      const gone = await D.runDoor("unattach", { key: k, id: row.fileId, confirm: true });
      expect(gone.status).toBe(200);
    });
  });
}

suite("cloud");
suite("datacenter");

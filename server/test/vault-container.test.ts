/*
 * Decision B: an agent's own `--as` container is signed in on its first visit,
 * and exactly the vault's cookies come out again when the task ends. The
 * window and main are fakes built on main's own pure helpers; invented hosts,
 * vaults and values only.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askBrowser, noteBrowserManager, noteBrowserReady, resetBrowserDrive, setBrowserSink, settleBrowser,
  signOutVaultLanes, type BrowserAsk,
} from "../src/browserdrive.ts";
import { configureLanes } from "../src/lanes.ts";
import { resetVaultContainers, signInsWhere } from "../src/vaultContainers.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vp = require("../../electron/vault-pull.js");

/* ---- a fake cookie jar with Chromium's rule: a cookie is name + domain + path;
   setting one already expired deletes that one and no other. */
type Jar = Map<string, string>;
const keyOf = (c: { name: string; domain?: string; url?: string; path?: string }) => {
  const host = c.domain || new URL(String(c.url)).hostname;
  return `${c.name}|${host}|${c.path || "/"}`;
};
function setIn(jar: Jar, c: Record<string, unknown>): void {
  const k = keyOf(c as { name: string });
  if (typeof c.expirationDate === "number" && c.expirationDate < Date.now() / 1000) jar.delete(k);
  else jar.set(k, String(c.value));
}

const VAULT_COOKIES = [
  { url: "https://acme.test/", name: "sid", value: "fake-1", domain: ".acme.test", path: "/", secure: true },
  { url: "https://app.acme.test/", name: "pref", value: "fake-2", path: "/app" },
];

let jars: Map<string, Jar>;
let profiles: { id: string; name: string; by: "person" | "agent" }[];
let tabs: { id: string; profile: string; container: string }[];
let pulls: Record<string, unknown>[];
let wipes: Record<string, unknown>[];
let reloads: string[];
/* What fake main answers a container pull before any cookie: null = go ahead. */
let mainSays: Record<string, unknown> | null;
/* True: the window cannot clean (a wipe answers not-done). */
let wipeFails = false;
/* What happens in the container's jar right after the sweep, before the window re-reads it (the open tab's page setting cookies, or a vault cookie that survived). */
let afterWipe: ((j: Jar) => void) | null = null;
/* Hashes of what fake main put into each container, in memory like the real one. */
let putHashes = new Map<string, Set<string>>();
/* True: the fake window honours `sweep` (the real one does; older tests model other cookies that stay). */
let sweepOn = false;
let tabN = 0;
let dir = "";

const jar = (id: string) => { let j = jars.get(id); if (!j) { j = new Map(); jars.set(id, j); } return j; };

async function fakeMain(pull: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = String(pull.container);
  if (!vp.containerPartition(id)) return { ok: false, code: "refused" };
  if (mainSays) return mainSays;
  /* Main's rule: signed in = the server still holds the vault's sign-in, never "the jar has a cookie". */
  if (pull.held === true) return { ok: false, code: "has-login" };
  const keys: unknown[] = [];
  const put = await vp.putLaneCookies(VAULT_COOKIES, {
    set: async (c: Record<string, unknown>) => { setIn(jar(id), c); const k = vp.cookieKeyOf(c); if (k) keys.push(k); const h = vp.cookieHash(c); if (h) { const b = putHashes.get(id) ?? new Set<string>(); b.add(h); putHashes.set(id, b); } },
    gone: () => false, late: () => false,
  });
  return { ok: true, site: pull.site, vault: "zen:abc/0", label: "Work", set: put.set, cookies: keys };
}

function answer(ask: BrowserAsk): Promise<{ ok: boolean; value?: unknown; error?: string }> | { ok: boolean; value?: unknown; error?: string } {
  const a = ask.args as Record<string, unknown>;
  if (a.vaultPull) { pulls.push(a.vaultPull as Record<string, unknown>); return fakeMain(a.vaultPull as Record<string, unknown>).then((value) => ({ ok: true, value })); }
  if (a.vaultWipe) {
    const w = a.vaultWipe as { container: string; cookies: unknown[] };
    wipes.push(w as unknown as Record<string, unknown>);
    /* The window's own check: an id its list holds without the flag is the person's. */
    if (profiles.some((p) => p.id === w.container && p.by === "person")) return { ok: true, value: { ok: false, code: "not-agent" } };
    if (wipeFails) return { ok: true, value: { ok: false } };
    const sweep = (a.vaultWipe as { sweep?: boolean; site?: string });
    return vp.wipeContainerCookies(w.cookies, { set: async (c: Record<string, unknown>) => setIn(jar(w.container), c) })
      .then(async (removed: number) => {
        if (sweepOn && sweep.sweep === true) {
          const j = jar(w.container);
          removed += await vp.sweepSiteCookies(String(sweep.site), {
            get: async () => [...j.keys()].map((k) => { const [name, domain, path] = k.split("|"); return { name, domain, path, secure: true }; }),
            remove: async (_u: string, name: string) => { for (const k of [...j.keys()]) if (k.startsWith(`${name}|`)) j.delete(k); },
          });
        }
        const j = jar(w.container);
        afterWipe?.(j);
        const proof = await vp.vaultLeftCount(String(sweep.site), putHashes.get(w.container), {
          get: async () => [...j.entries()].map(([k, value]) => { const [name, domain, path] = k.split("|"); return { name, domain, path, value, secure: true }; }),
        });
        return { ok: true, value: { ok: true, removed, ...proof } };
      });
  }
  if (ask.op === "reload") { reloads.push(String(a.page)); return { ok: true, value: { title: "Your profile" } }; }
  if (ask.op === "open" || ask.op === "newtab") {
    if (typeof a.page === "string") return { ok: true, value: { url: a.url, title: "acme.test" } };
    const wanted = typeof a.profile === "string" ? a.profile : "";
    if (!wanted) { const id = `t${tabN++}`; tabs.push({ id, profile: "", container: "" }); return { ok: true, value: { id, url: a.url } }; }
    let p = profiles.find((x) => x.name === wanted);
    let minted = false;
    if (!p) { p = { id: wanted.replace(/[^a-z0-9]/g, "").slice(0, 12), name: wanted, by: "agent" }; profiles.push(p); minted = true; }
    const id = `t${tabN++}`;
    tabs.push({ id, profile: p.name, container: p.id });
    const made = p.by === "agent" ? { agentMade: true } : {};
    return { ok: true, value: { id, url: a.url, title: "acme.test", profile: p.name, container: p.id, tabs: [{ id, title: "acme.test", url: a.url, active: false, profile: p.name }], ...(minted ? { minted: true } : {}), ...made } };
  }
  if (ask.op === "closetab") {
    tabs = typeof a.index === "number" ? tabs.filter((_, i) => i !== a.index) : tabs.filter((t) => t.id !== a.page);
    return { ok: true, value: tabs.map((t) => ({ id: t.id, profile: t.profile })) };
  }
  if (ask.op === "profiles" && typeof a.drop === "string") {
    profiles = profiles.filter((p) => p.name !== a.drop);
    return { ok: true, value: { dropped: a.drop } };
  }
  return { ok: true, value: {} };
}

function wire(): void {
  setBrowserSink({
    send: (ask: BrowserAsk) => { void Promise.resolve(answer(ask)).then((r) => settleBrowser(ask.id, r)); return true; },
    listeners: () => 1, live: () => true,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-vault-container-"));
  resetBrowserDrive();
  resetVaultContainers(join(dir, "book.json"));
  jars = new Map(); profiles = [{ id: "work", name: "work", by: "person" }]; tabs = [];
  pulls = []; wipes = []; reloads = []; mainSays = null; wipeFails = false; sweepOn = false; afterWipe = null; putHashes = new Map();
  wire();
  noteBrowserManager("win-c", true);
  noteBrowserReady("win-person", true);
  configureLanes({ manage: async () => ({ ok: true }), hosted: () => true, forget: () => undefined });
});
afterEach(() => { resetBrowserDrive(); resetVaultContainers(null); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
const open = (args: Record<string, unknown>) => askBrowser({ id: `vc-${n++}`, op: "open", args: { url: "https://acme.test/home", ...args } });
const vaultOf = (r: { value?: unknown }) => (r.value as { vault?: Record<string, unknown> } | undefined)?.vault;
const AS = { profile: "orbit-box", as: "orbit-box" };

describe("an agent's own --as container", () => {
  it("is signed in on its first visit, the page reloads, and the panel's record stays the relay's", async () => {
    const r = await open(AS);
    expect(vaultOf(r)).toEqual({ signedIn: true, site: "acme.test", vault: "Work", vaultId: "zen:abc/0" });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ container: "orbitbox", site: "acme.test", agent: "orbit-box", onVisit: true });
    expect(typeof pulls[0].deadlineAt).toBe("number");
    expect(reloads).toEqual([(r.value as { id: string }).id]);
    expect(r.value).not.toHaveProperty("minted");
    expect(r.value).not.toHaveProperty("container");
    expect(r.value).not.toHaveProperty("agentMade");
    expect(jar("orbitbox").size).toBe(2);
    /* The book on disk has names, domains, paths: never a value. */
    const book = readFileSync(join(dir, "book.json"), "utf8");
    expect(book).toContain("sid");
    expect(book).not.toContain("fake-1");
  });

  it("a second visit, and a subdomain, are not signed in again", async () => {
    const r = await open(AS);
    const tab = (r.value as { id: string }).id;
    expect(vaultOf(await open({ ...AS, page: tab }))).toBeUndefined();
    expect(vaultOf(await open({ as: "orbit-box", page: tab, url: "https://app.acme.test/" }))).toBeUndefined();
    expect(pulls).toHaveLength(1);
  });

  it("a container the person made, and the person's Default, are never signed in", async () => {
    const r = await open({ profile: "work", as: "work" });
    expect(vaultOf(r)?.signedIn).toBe(false);
    expect(String(vaultOf(r)?.why)).toContain("not made by your own open");
    expect(vaultOf(await open({}))).toBeUndefined();
    expect(vaultOf(await open({ shared: true, as: "orbit-box" }))).toBeUndefined();
    expect(pulls).toHaveLength(0);
  });

  it("another agent opening a container one agent made is not signed in", async () => {
    await open(AS);
    const r = await open({ profile: "orbit-box", as: "other-agent", url: "https://beta.test/" });
    expect(vaultOf(r)?.signedIn).toBe(false);
    expect(pulls).toHaveLength(1);
  });

  it("a sensitive site asks first: nothing goes in, the answer says browser_vault", async () => {
    mainSays = { ok: false, code: "sensitive", error: "acme.test is marked sensitive: ask for it with browser_vault; the person is asked" };
    const v = vaultOf(await open(AS));
    expect(v).toMatchObject({ signedIn: false, site: "acme.test" });
    expect(String(v?.why)).toContain("browser_vault");
    expect(jar("orbitbox").size).toBe(0);
    expect(signInsWhere(() => true)).toHaveLength(0);
  });

  it("read-only mode refuses it", async () => {
    mainSays = { ok: false, code: "refused", error: "the browser is in read-only mode, so it cannot sign a lane in from the vault" };
    expect(String(vaultOf(await open(AS))?.why)).toContain("read-only");
    expect(jar("orbitbox").size).toBe(0);
  });

  it("setting off: the reply is a plain open's", async () => {
    mainSays = { ok: false, code: "off" };
    const r = await open(AS);
    expect(vaultOf(r)).toBeUndefined();
    expect(reloads).toHaveLength(0);
  });

  it("no default vault: the answer says how to choose one", async () => {
    mainSays = { ok: false, code: "ambiguous", vaults: [{ id: "zen:a/0", label: "Work" }, { id: "zen:b/0", label: "Home" }] };
    const why = String(vaultOf(await open(AS))?.why);
    expect(why).toContain("--vault NAME");
    expect(why).toContain("\"Work\"");
    expect(why).toContain("default vault");
  });
});

describe("the vault's cookies come out at task end, and only those", () => {
  /* The agent's own login on the same site: another name, and the same name on another path. */
  const own = () => {
    setIn(jar("orbitbox"), { url: "https://acme.test/", name: "mine", value: "fake-own", path: "/" });
    setIn(jar("orbitbox"), { url: "https://acme.test/", name: "sid", value: "fake-own-2", domain: ".acme.test", path: "/other" });
  };
  const left = () => [...jar("orbitbox").keys()].sort();
  const KEPT = ["mine|acme.test|/", "sid|.acme.test|/other"];
  async function signedIn(): Promise<string> {
    const r = await open(AS);
    expect(vaultOf(r)?.signedIn).toBe(true);
    own();
    expect(jar("orbitbox").size).toBe(4);
    return (r.value as { id: string }).id;
  }

  it("done", async () => {
    await signedIn();
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(left()).toEqual(KEPT);
    expect(signInsWhere(() => true)).toHaveLength(0);
  });

  it("done also takes a cookie the page rotated, and a later open signs in again", async () => {
    sweepOn = true;
    await signedIn();
    jar("orbitbox").set("sid|.acme.test|/", "fake-rotated"); // not the listed key: a rotated login
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect([...jar("orbitbox").keys()].filter((k) => k.includes("acme.test"))).toEqual([]);
    expect(vaultOf(await open(AS))?.signedIn).toBe(true);
  });

  it("a re-open after done pulls again although anonymous cookies are in the jar", async () => {
    const tab = await signedIn();
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    setIn(jar("orbitbox"), { url: "https://acme.test/", name: "anon", value: "fake-anon", path: "/" });
    const before = pulls.length;
    const again = await open({ as: "orbit-box", page: tab });
    expect(pulls.length).toBe(before + 1);
    expect(pulls[pulls.length - 1].held).toBe(false);
    expect(vaultOf(again)?.signedIn).toBe(true);
    expect(vaultOf(again)?.already).toBeUndefined();
  });

  it("has-login is never silent: signedIn true, already true", async () => {
    await signedIn();
    const r = await open({ as: "orbit-box", page: (tabs[tabs.length - 1]).id, url: "https://acme.test/other" });
    void r;
    mainSays = { ok: false, code: "has-login" };
    const t2 = await open({ profile: "orbit-two", as: "orbit-two", url: "https://acme.test/x" });
    expect(vaultOf(t2)).toEqual({ signedIn: true, site: "acme.test", already: true });
  });

  it("a sign-in still on the book makes the re-open say already:true, with held true", async () => {
    const tab = await signedIn();
    wipeFails = true;
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    wipeFails = false;
    const again = await open({ as: "orbit-box", page: tab });
    expect(pulls[pulls.length - 1].held).toBe(true);
    expect(vaultOf(again)).toEqual({ signedIn: true, site: "acme.test", already: true });
  });

  it("a wipe that left a vault cookie keeps the sign-in on the book", async () => {
    await signedIn();
    afterWipe = (j) => j.set("sid|.acme.test|/", "fake-1");
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(signInsWhere(() => true)).toHaveLength(1);
  });

  it("a wipe with no book (evicted) cannot prove it: the sign-in record stays", async () => {
    await signedIn();
    afterWipe = (j) => { j.set("sid|.acme.test|/", "fake-1"); putHashes.clear(); };
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(signInsWhere(() => true)).toHaveLength(1);
  });

  it("a page's own cookie of the same name, other value, does not keep it: the next open signs in again", async () => {
    await signedIn();
    afterWipe = (j) => j.set("sid|.acme.test|/", "fake-anon");
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(signInsWhere(() => true)).toHaveLength(0);
    afterWipe = null;
    pulls = [];
    const again = await open(AS);
    expect(pulls[pulls.length - 1].held).toBe(false);
    expect(vaultOf(again)).toEqual(expect.objectContaining({ signedIn: true }));
    expect(vaultOf(again)).not.toHaveProperty("already");
  });

  it("with more than 200 other cookies a surviving vault cookie is still found", async () => {
    await signedIn();
    afterWipe = (j) => {
      for (let i = 0; i < 300; i++) j.set(`n${i}|acme.test|/`, `fake-x${i}`);
      j.set("sid|.acme.test|/", "fake-1");
    };
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(signInsWhere(() => true)).toHaveLength(1);
  });

  it("done forgets the visit even when the window could not clean", async () => {
    await signedIn();
    wipeFails = true;
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    wipeFails = false;
    expect(vaultOf(await open(AS))?.signedIn).toBe(true);
  });

  it("an own-tab re-open after done says the fresh sign-in, with or without --vault", async () => {
    const tab = await signedIn();
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    const again = await open({ as: "orbit-box", page: tab });
    expect(vaultOf(again)).toEqual({ signedIn: true, site: "acme.test", vault: "Work", vaultId: "zen:abc/0" });
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(vaultOf(await open({ as: "orbit-box", page: tab, vault: "Work" }))?.signedIn).toBe(true);
  });

  it("eval is refused while it holds sign-ins, with the why; allowed before and after done", async () => {
    const ev = () => askBrowser({ id: `vc-${n++}`, op: "eval", args: { as: "orbit-box", expression: "1" } });
    expect((await ev()).ok).toBe(true);
    await signedIn();
    const r = await ev();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("refused while this container holds sign-ins");
    expect(r.error).toContain("reading verbs");
    expect((await askBrowser({ id: `vc-${n++}`, op: "eval", args: { as: "someone-else", expression: "1" } })).ok).toBe(true);
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect((await ev()).ok).toBe(true);
  });

  it("eval is judged by the tab's own container: a blank second container is allowed", async () => {
    const signed = await signedIn();
    mainSays = { ok: false, code: "off" };
    const blank = (await open({ profile: "orbit-blank", as: "orbit-box" })).value as { id: string };
    const ev = (page: string, more: Record<string, unknown> = {}) =>
      askBrowser({ id: `vc-${n++}`, op: "eval", args: { as: "orbit-box", expression: "1", page, ...more } });
    expect((await ev(blank.id)).ok).toBe(true);
    expect((await ev(signed)).ok).toBe(false);
  });

  it("shared with a named tab in the signed container is still refused", async () => {
    const signed = await signedIn();
    const r = await askBrowser({ id: `vc-${n++}`, op: "eval", args: { as: "orbit-box", expression: "1", page: signed, shared: true } });
    expect(r.ok).toBe(false);
    expect((await askBrowser({ id: `vc-${n++}`, op: "eval", args: { as: "orbit-box", expression: "1", shared: true } })).ok).toBe(true);
  });

  it("the other verbs that read a login back out are refused as well; reading verbs pass", async () => {
    await signedIn();
    const run = (op: "cookies" | "storage" | "read") => askBrowser({ id: `vc-${n++}`, op, args: { as: "orbit-box" } });
    expect((await run("cookies")).ok).toBe(false);
    expect((await run("storage")).ok).toBe(false);
    expect((await run("read")).ok).toBe(true);
  });

  it("the open answer's title is the loaded page's, not the host", async () => {
    const r = await open(AS);
    expect((r.value as { title?: string }).title).toBe("Your profile");
  });

  it("the open answer's tab list carries the page title too, not the host", async () => {
    const r = await open(AS);
    const v = r.value as { id: string; tabs: { id: string; title: string }[] };
    expect(v.tabs.find((t) => t.id === v.id)?.title).toBe("Your profile");
  });

  it("the agent's session ends", async () => {
    await signedIn();
    await signOutVaultLanes("orbit-box", true, true);
    expect(left()).toEqual(KEPT);
  });

  it("its last tab in that container closes (not while another is open)", async () => {
    const first = await signedIn();
    const second = (await open({ ...AS, url: "https://beta.test/" })).value as { id: string };
    await askBrowser({ id: `vc-${n++}`, op: "closetab", args: { page: first, as: "orbit-box" } });
    expect(jar("orbitbox").has("sid|.acme.test|/")).toBe(true);
    expect(wipes).toHaveLength(0);
    await askBrowser({ id: `vc-${n++}`, op: "closetab", args: { page: second.id, as: "orbit-box" } });
    expect(left()).toEqual(KEPT);
  });

  it("a tab closed by index names no container: no one's sign-in is wiped", async () => {
    await signedIn();
    await askBrowser({ id: `vc-${n++}`, op: "closetab", args: { index: 0, as: "other-agent" } });
    expect(wipes).toHaveLength(0);
    expect(jar("orbitbox").has("sid|.acme.test|/")).toBe(true);
    expect(signInsWhere(() => true)).toHaveLength(1);
  });

  it("the container is dropped", async () => {
    await signedIn();
    await askBrowser({ id: `vc-${n++}`, op: "profiles", args: { drop: "orbit-box" } });
    expect(left()).toEqual(KEPT);
    expect(wipes).toHaveLength(1);
  });

  it("a restart: what a crash left is removed when a window can answer", async () => {
    await signedIn();
    /* The server dies: memory is gone, the book on disk is not. */
    resetBrowserDrive();
    resetVaultContainers(join(dir, "book.json"));
    expect(signInsWhere(() => true)).toHaveLength(1);
    wire();
    noteBrowserManager("win-after", true);
    for (let i = 0; i < 20 && signInsWhere(() => true).length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(left()).toEqual(KEPT);
    expect(signInsWhere(() => true)).toHaveLength(0);
  });

  it("a failed leftover wipe retries only the crash's ids, never a live sign-in", async () => {
    await signedIn();
    resetBrowserDrive();
    resetVaultContainers(join(dir, "book.json"));
    noteBrowserReady("win-person", true);
    /* The window cannot clean at first. */
    let fail = true;
    setBrowserSink({
      send: (ask: BrowserAsk) => {
        const r = fail && (ask.args as Record<string, unknown>).vaultWipe ? { ok: false } : answer(ask);
        void Promise.resolve(r).then((x) => settleBrowser(ask.id, x)); return true;
      },
      listeners: () => 1, live: () => true,
    });
    noteBrowserManager("win-a", true);
    await new Promise((r) => setTimeout(r, 30));
    expect(signInsWhere(() => true)).toHaveLength(1);
    /* A live agent signs in meanwhile; the window now works. */
    fail = false;
    const live = await open({ profile: "live-box", as: "live-box" });
    expect(vaultOf(live)?.signedIn).toBe(true);
    expect(signInsWhere((s) => s.owner === "live-box")).toHaveLength(1);
    noteBrowserManager("win-b", true);
    for (let i = 0; i < 20 && signInsWhere(() => true).length > 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(signInsWhere(() => true).map((s) => s.owner)).toEqual(["live-box"]);
  });

  it("after the task ends the site may be signed in again", async () => {
    const tab = await signedIn();
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    pulls = [];
    await open({ as: "orbit-box", page: tab });
    expect(pulls).toHaveLength(1);
  });
});

describe("an id the person's container took over", () => {
  /* The agent's container goes outside a drop (Settings ▸ Remove), and the
     person makes one whose name slugs to the same id. */
  const takeOver = () => { profiles = profiles.filter((p) => p.id !== "orbitbox"); profiles.push({ id: "orbitbox", name: "orbit box", by: "person" }); };

  it("is never signed in, and its record leaves the book", async () => {
    const r = await open(AS);
    expect(vaultOf(r)?.signedIn).toBe(true);
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    takeOver();
    pulls = [];
    const again = await open({ profile: "orbit box", as: "orbit-box" });
    expect(vaultOf(again)?.signedIn).toBe(false);
    expect(pulls).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(dir, "book.json"), "utf8")).made).toEqual({});
  });

  it("the task-end wipe keeps the person's cookies, and the sign-in leaves the book", async () => {
    await open(AS);
    takeOver();
    setIn(jar("orbitbox"), { url: "https://acme.test/", name: "sid", value: "fake-person", domain: ".acme.test", path: "/" });
    await askBrowser({ id: `vc-${n++}`, op: "done", args: { as: "orbit-box" } });
    expect(jar("orbitbox").get("sid|.acme.test|/")).toBe("fake-person");
    expect(signInsWhere(() => true)).toHaveLength(0);
  });

  it("an open the panel answers without the flag drops the record, with no wipe", async () => {
    await open(AS);
    takeOver();
    await open({ profile: "orbit box", as: "someone" });
    expect(signInsWhere(() => true)).toHaveLength(0);
    expect(wipes).toHaveLength(0);
    expect(jar("orbitbox").size).toBe(2);
  });
});

describe("a fresh mint under an id already in the book", () => {
  it("replaces the owner and drops the old sign-ins without a wipe", async () => {
    await open(AS);
    expect(signInsWhere(() => true)).toHaveLength(1);
    /* The panel lost the first one (no drop), and agent B mints the same id. */
    profiles = profiles.filter((p) => p.id !== "orbitbox");
    pulls = [];
    const r = await open({ profile: "orbit-box", as: "beta-agent" });
    expect(vaultOf(r)?.signedIn).toBe(true);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ container: "orbitbox", agent: "beta-agent" });
    expect(wipes).toHaveLength(0);
    expect(signInsWhere(() => true).map((s) => s.owner)).toEqual(["beta-agent"]);
    /* Agent A's next open is not signed in to B's container. */
    pulls = [];
    const a = await open({ profile: "orbit-box", as: "orbit-box", url: "https://beta.test/" });
    expect(vaultOf(a)?.signedIn).toBe(false);
    expect(pulls).toHaveLength(0);
  });
});

describe("main's wipe proves itself", () => {
  it("vaultLeftCount counts only cookies with the vault's name, domain, path and value, and returns no value", async () => {
    const hashes = new Set([vp.cookieHash({ name: "sid", domain: ".acme.test", path: "/", value: "fake-1" })]);
    const jarList = [{ name: "sid", domain: ".acme.test", path: "/", value: "fake-1" }, { name: "sid", domain: ".acme.test", path: "/", value: "fake-anon" }, { name: "x", domain: "acme.test", path: "/", value: "fake-2" }];
    const got = await vp.vaultLeftCount("acme.test", hashes, { get: async () => jarList });
    expect(got).toEqual({ vaultLeft: 1, left: 3 });
    expect(JSON.stringify(got)).not.toContain("fake");
    expect(await vp.vaultLeftCount("acme.test", hashes, { get: async () => { throw new Error("x"); } })).toEqual({ vaultLeft: null, left: 0 });
    const big = Array.from({ length: 500 }, (_, i) => ({ name: `n${i}`, domain: "acme.test", path: "/", value: "v" })).concat(jarList.slice(0, 1));
    expect((await vp.vaultLeftCount("acme.test", hashes, { get: async () => big })).vaultLeft).toBe(1);
  });
  it("the hash matches what Chromium hands back: dotted domain, host-only, and never a page's same-name cookie", async () => {
    const set1 = vp.cookieHash({ name: "sid", domain: "Acme.test", value: "fake-1" });
    const set2 = vp.cookieHash({ name: "hid", url: "https://acme.test/", value: "fake-2" });
    const hashes = new Set([set1, set2]);
    const jar = [
      { name: "sid", domain: ".acme.test", path: "/", value: "fake-1" },
      { name: "hid", domain: "acme.test", hostOnly: true, path: "/", value: "fake-2" },
      { name: "sid", domain: ".acme.test", path: "/", value: "fake-page" },
    ];
    expect(await vp.vaultLeftCount("acme.test", hashes, { get: async () => jar })).toEqual({ vaultLeft: 2, left: 3 });
  });
  it("vaultLeftCount prunes the book to what is still in the jar", async () => {
    const a = vp.cookieHash({ name: "sid", domain: "acme.test", value: "fake-1" });
    const b = vp.cookieHash({ name: "gone", domain: "acme.test", value: "fake-2" });
    const hashes = new Set([a, b]);
    await vp.vaultLeftCount("acme.test", hashes, { get: async () => [{ name: "sid", domain: ".acme.test", path: "/", value: "fake-1" }] });
    expect([...hashes]).toEqual([a]);
  });
  it("a missing book is unknown, not zero: vaultLeft null, and the log says the proof was unknown", async () => {
    const got = await vp.vaultLeftCount("acme.test", undefined, { get: async () => [{ name: "sid", domain: ".acme.test", path: "/", value: "fake-1" }] });
    expect(got.vaultLeft).toBeNull();
    const line = vp.appendPullLog(dir, { event: "signout", site: "acme.test", agent: "a", lane: "container:x", count: 0, left: 1, vaultLeft: null });
    expect(line.proof).toBe("unknown");
    expect(line).not.toHaveProperty("vaultLeft");
  });
  it("a cookie set from a url with a path and no path matches on read-back (Chromium's default path)", async () => {
    const put: Record<string, unknown>[] = [];
    await vp.putLaneCookies([{ url: "https://acme.test/x/y", name: "sid", value: "fake-1" }], { set: async (c: Record<string, unknown>) => { put.push(c); }, gone: () => false, late: () => false });
    expect(put[0].path).toBe("/x");
    const hashes = new Set([vp.cookieHash(put[0])]);
    const got = await vp.vaultLeftCount("acme.test", hashes, { get: async () => [{ name: "sid", domain: "acme.test", path: "/x", value: "fake-1" }] });
    expect(got.vaultLeft).toBe(1);
  });
  it("a pull replaces the book and a missing book keeps the sign-in record", async () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    expect(src).toContain("new Set(hashes.slice(0, 2000))");
    expect(src).not.toContain("book.size < 2000");
  });
  it("main drops a container's book when it is dropped, and caps it", () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    expect(src).toContain("vaultPutHashes.delete(k)");
    expect(src).toContain("vaultPutHashes.size > 200");
  });
  it("main answers with left and names, and a pull reads held, not cookies", () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    const wipe = src.slice(src.indexOf('ipcMain.handle("ag:vaultWipe"'), src.indexOf('ipcMain.handle("ag:vaultPull"'));
    expect(wipe).toContain("removed, left, vaultLeft");
    const pull = src.slice(src.indexOf("const pullIntoContainer"), src.indexOf('/* Task end for a container'));
    expect(pull).toContain("req?.held === true");
    expect(pull).not.toContain("cookies.get({ domain: site })");
  });
});

describe("a wipe leaves nothing, host-only and __Host- included", () => {
  /* What the vault helper hands main: host-only cookies carry a url and no domain. */
  const MIXED = [
    { url: "https://acme.test/", name: "dom", value: "fake-1", domain: ".acme.test", path: "/", secure: true },
    { url: "https://acme.test/", name: "user_session", value: "fake-2", path: "/", secure: true },
    { url: "https://acme.test/", name: "__Host-user_session_same_site", value: "fake-3", path: "/", secure: true },
    { url: "https://acme.test/", name: "_gh_sess", value: "fake-4", path: "/" },
  ];
  async function put(): Promise<{ j: Jar; keys: unknown[] }> {
    const j: Jar = new Map(); const keys: unknown[] = [];
    await vp.putLaneCookies(MIXED, { set: async (c: Record<string, unknown>) => { setIn(j, c); const k = vp.cookieKeyOf(c); if (k) keys.push(k); }, gone: () => false, late: () => false });
    expect(j.size).toBe(4);
    return { j, keys };
  }
  const get = (j: Jar) => async () => [...j.keys()].map((k) => { const [name, domain, path] = k.split("|"); return { name, domain, path, secure: true }; });

  it("the listed-key wipe alone removes every one of them", async () => {
    const { j, keys } = await put();
    const removed = await vp.wipeContainerCookies(keys, { set: async (c: Record<string, unknown>) => setIn(j, c) });
    expect(removed).toBe(4);
    expect([...j.keys()]).toEqual([]);
    expect((await vp.vaultLeftCount("acme.test", new Set(), { get: async () => [] })).left).toBe(0);
  });

  it("the sweep removes host-only and __Host- cookies too", async () => {
    const { j } = await put();
    const removed = await vp.sweepSiteCookies("acme.test", {
      get: get(j),
      remove: async (_u: string, name: string) => { for (const k of [...j.keys()]) if (k.startsWith(`${name}|`)) j.delete(k); },
    });
    expect(removed).toBe(4);
    expect(j.size).toBe(0);
  });

  it("the window's relay forwards sweep and held, or main never sweeps and never sees the book", () => {
    const src = readFileSync(join(import.meta.dir, "../../web/src/lib/laneManager.ts"), "utf8");
    expect(src).toContain("wipe.sweep === true");
    expect(src).toContain("held: pull.held === true");
  });
});

describe("main's exact wipe", () => {
  it("deletes by name + domain (or host-only) + path, already expired, never a value", () => {
    expect(vp.cookieKeyOf({ url: "https://app.acme.test/", name: "pref", value: "fake", path: "/app" }))
      .toEqual({ name: "pref", domain: "app.acme.test", path: "/app", secure: false, hostOnly: true });
    expect(vp.wipeCookieOf({ name: "sid", domain: ".acme.test", path: "/", secure: true, hostOnly: false }))
      .toEqual({ url: "https://acme.test/", name: "sid", value: "", path: "/", secure: true, domain: ".acme.test", expirationDate: 1 });
    expect(vp.wipeCookieOf({ name: "pref", domain: "app.acme.test", path: "/app", secure: false, hostOnly: true }))
      .not.toHaveProperty("domain");
  });

  it("only an agent's container id has a partition; the person's Default never does", () => {
    expect(vp.containerPartition("orbitbox")).toBe("persist:agentglass-browser-orbitbox");
    expect(vp.containerPartition("")).toBeNull();
    expect(vp.containerPartition("../x")).toBeNull();
    expect(vp.containerPartition(undefined)).toBeNull();
  });
});

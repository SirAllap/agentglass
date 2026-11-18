/*
 * Sign-in on a first visit (ON by default). The window and main are fakes: they
 * answer codes and counts, never a value. Invented hosts and vaults only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentAskRefusal, askBrowser, isVaultLane, noteBrowserManager, noteBrowserReady, parseAsk,
  resetBrowserDrive, setBrowserSink, settleBrowser, type BrowserAsk,
} from "../src/browserdrive.ts";
import { configureLanes, laneKnown, laneRecord, openLane } from "../src/lanes.ts";
import { siteOf } from "../src/cookieimport.ts";
import {
  __setVaultKeyStore, mostUsedSites, readSettings, visitSuggestSensitive, type KeyStoreState, type VaultKeyStore,
} from "../src/loginvault.ts";
import { runCookieReader } from "../src/cookieread.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vp = require("../../electron/vault-pull.js");

const AGENT = "orbit-1";

describe("main's decision before any spawn", () => {
  const index = (on: boolean, rows: Record<string, boolean>) => vp.visitIndexFrom({
    ok: true, signInOnVisit: on,
    vaults: [{ vault: "zen:abc/0", sites: Object.entries(rows).map(([site, sensitive]) => ({ site, sensitive })) }],
  });

  it("off / index failed / sealed off / none / has-login / sensitive / pull", () => {
    const idx = index(true, { "github.com": false, "bank.test": true });
    expect(vp.onVisitDecision({ marker: false, index: idx }, "github.com")).toEqual({ ok: false, code: "off" });
    expect(vp.onVisitDecision({ marker: true, index: "failed" }, "github.com").code).toBe("index");
    expect(vp.onVisitDecision({ marker: true, index: index(false, { "github.com": false }) }, "github.com").code).toBe("off");
    expect(vp.onVisitDecision({ marker: true, index: idx }, "acme.test").code).toBe("none");
    expect(vp.onVisitDecision({ marker: true, index: idx, hasLogin: true }, "github.com").code).toBe("has-login");
    expect(vp.onVisitDecision({ marker: true, index: idx }, "bank.test").code).toBe("sensitive");
    expect(vp.onVisitDecision({ marker: true, index: idx }, "github.com")).toBeNull();
    /* One key everywhere: a subdomain hits the registrable site's row. */
    expect(vp.onVisitDecision({ marker: true, index: idx }, siteOf("gist.github.com"))).toBeNull();
  });

  it("an unreadable vault-list is the failed index", () => {
    expect(vp.visitIndexFrom({ ok: false, code: "locked" })).toBe("failed");
    expect(vp.visitIndexFrom(null)).toBe("failed");
  });

  const counted = (readonly: boolean, marker: boolean) => {
    const c = { reads: 0, checks: 0, off: 0 };
    const deps = {
      readonly, marker: () => marker,
      index: async () => { c.reads += 1; return index(true, { "acme.test": false }); },
      hasLogin: async () => { c.checks += 1; return false; },
      markOff: () => { c.off += 1; },
    };
    return { c, deps };
  };

  it("main's off marker: no index read, no login check, no spawn", async () => {
    const { c, deps } = counted(false, false);
    expect(await vp.visitGate(deps, "acme.test")).toEqual({ ok: false, code: "off" });
    expect(c).toEqual({ reads: 0, checks: 0, off: 0 });
  });

  it("read-only mode refuses it before anything is read", async () => {
    const { c, deps } = counted(true, true);
    const no = await vp.visitGate(deps, "acme.test");
    expect(no.code).toBe("refused");
    expect(no.error).toContain("read-only");
    expect(c.reads).toBe(0);
  });

  it("on by default (no marker): it goes on to the pull", async () => {
    const { c, deps } = counted(false, true);
    expect(await vp.visitGate(deps, "acme.test")).toBeNull();
    expect(c.reads).toBe(1);
  });

  it("the sealed setting off is the truth: off, and main writes its off marker", async () => {
    let off = 0;
    const no = await vp.visitGate({
      marker: () => true, index: async () => index(false, { "acme.test": false }),
      hasLogin: async () => false, markOff: () => { off += 1; },
    }, "acme.test");
    expect(no.code).toBe("off");
    expect(off).toBe(1);
  });

  it("a lane that already holds a login for the site keeps it", async () => {
    const no = await vp.visitGate({
      marker: () => true, index: async () => index(true, { "acme.test": false }),
      hasLogin: async () => true, markOff: () => undefined,
    }, "acme.test");
    expect(no.code).toBe("has-login");
  });

  it("a sensitive site is never signed in on visit: the agent is sent to the verb, where the person is asked", async () => {
    const no = await vp.visitGate({
      marker: () => true, index: async () => index(true, { "bank.test": true }),
      hasLogin: async () => false, markOff: () => undefined,
    }, "bank.test");
    expect(no.code).toBe("sensitive");
    expect(no.error).toContain("browser_vault");
    expect(no.error).toContain("the person is asked");
  });

  it("only an ephemeral lane: main still refuses any other lane", () => {
    expect(vp.pullRefusal({ readonly: false, lane: { ephemeral: false }, site: "acme.test" })).toContain("ephemeral");
    expect(vp.pullRefusal({ readonly: true, lane: { ephemeral: true }, site: "acme.test" })).toContain("read-only");
  });

  it("counts the sites a sign-in on visit could reach", () => {
    expect(vp.visitSiteCount({ ok: true, vaults: [{ vault: "a", sites: [{ site: "x.test" }, { site: "y.test", sensitive: true }] }, { vault: "b", sites: [{ site: "x.test" }] }] })).toBe(1);
  });
});

describe("main's deadline", () => {
  const cookie = (name: string) => ({ url: "https://acme.test/", name, value: "fake", domain: "acme.test", path: "/" });

  it("past the deadline before the first cookie: nothing is set", async () => {
    let sets = 0;
    const put = await vp.putLaneCookies([cookie("a"), cookie("b")], { set: async () => { sets += 1; }, gone: () => false, late: () => true });
    expect(put.stop).toBe("late");
    expect(sets).toBe(0);
  });

  it("the deadline passes between two cookies: the second is not set", async () => {
    let sets = 0; let now = 0;
    const put = await vp.putLaneCookies([cookie("a"), cookie("b")], {
      set: async () => { sets += 1; now = 99; }, gone: () => false, late: () => now > 10,
    });
    expect(put.stop).toBe("late");
    expect(sets).toBe(1);
    expect(put.set).toBe(1);
  });

  it("main wipes and answers late whenever putLaneCookies stops for it, and checks around the page fill", () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    const pull = src.slice(src.indexOf('ipcMain.handle("ag:vaultPull"'), src.indexOf('ipcMain.handle("ag:vaultImport"'));
    const tooLate = pull.slice(pull.indexOf("const tooLate"), pull.indexOf("const put = await putLaneCookies"));
    expect(tooLate).toContain("wipeEphemeralPartition(partition)");
    expect(tooLate).toContain('why: "too late"');
    expect(tooLate).toContain('code: "late"');
    expect(pull).toContain('if (put.stop === "late") return tooLate();');
    const fill = pull.indexOf("fillLaneGuest(");
    expect(pull.lastIndexOf("if (late()) return tooLate();", fill)).toBeGreaterThan(pull.indexOf("const put = await putLaneCookies"));
    expect(pull.indexOf("if (late()) return tooLate();", fill)).toBeLessThan(pull.indexOf('event: "pull"'));
    /* Before the guard and before the first cookie, the check is there too. */
    expect(pull.indexOf("if (late())")).toBeLessThan(pull.indexOf("reportVaultLane(lane"));
    expect(vp.visitDeadline(60_000, 1000)).toBe(26_000);
    expect(vp.visitDeadline(undefined, 0)).toBe(25_000);
  });

  it("the server's deadlineAt wins when the ask is read late: a 6 s late ask sets no cookie", async () => {
    /* The server sends at t=1000 and fixes deadlineAt there; the busy window
       reads it 6 s later, and the helper takes 19.5 s. */
    const sent = 1000;
    const deadlineAt = sent + 25_000;
    let now = sent + 6_000;
    const deadline = vp.visitDeadline(25_000, now, deadlineAt);
    expect(deadline).toBe(deadlineAt);
    now += 19_500;
    let sets = 0;
    const put = await vp.putLaneCookies([cookie("a"), cookie("b")], { set: async () => { sets += 1; }, gone: () => false, late: () => now > deadline });
    expect(put.stop).toBe("late");
    expect(sets).toBe(0);
    /* Without deadlineAt (arrival + 25 s) the same ask would have set both. */
    const own = vp.visitDeadline(25_000, sent + 6_000);
    const old = await vp.putLaneCookies([cookie("a"), cookie("b")], { set: async () => undefined, gone: () => false, late: () => now > own });
    expect(old.set).toBe(2);
    /* A deadlineAt later than arrival + budget never lengthens it; junk is ignored. */
    expect(vp.visitDeadline(25_000, 0, 99_000)).toBe(25_000);
    expect(vp.visitDeadline(25_000, 0, "soon")).toBe(25_000);
  });

  it("main reads deadlineAt, and an ask already past it stops before the gate and any spawn", () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    const pull = src.slice(src.indexOf('ipcMain.handle("ag:vaultPull"'), src.indexOf('ipcMain.handle("ag:vaultImport"'));
    expect(pull).toContain("visitDeadline(req?.budgetMs, Date.now(), req?.deadlineAt)");
    expect(pull.indexOf("if (onVisit && late())")).toBeGreaterThan(-1);
    expect(pull.indexOf("if (onVisit && late())")).toBeLessThan(pull.indexOf("visitGate("));
  });

  it("on visit, main decides before pullRefusal and before any spawn", () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    const pull = src.slice(src.indexOf('ipcMain.handle("ag:vaultPull"'), src.indexOf('ipcMain.handle("ag:vaultImport"'));
    expect(pull.indexOf("visitGate(")).toBeLessThan(pull.indexOf("pullRefusal("));
    expect(pull.indexOf("visitGate(")).toBeLessThan(pull.indexOf("runCookieReader("));
    /* A stale index that still says sensitive: refused on visit, no dialog. */
    expect(pull.indexOf("onVisit && got.sensitive")).toBeLessThan(pull.indexOf("askSensitive("));
  });
});

describe("log and settings, main side", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-vault-visit-log-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the pull log keeps cause visit|verb and drops anything else", () => {
    expect(vp.appendPullLog(dir, { event: "pull", site: "acme.test", agent: "a", lane: "l1", count: 1, cause: "visit" }, 1).cause).toBe("visit");
    expect(vp.appendPullLog(dir, { event: "pull", site: "acme.test", agent: "a", lane: "l1", count: 1, cause: "verb" }, 1).cause).toBe("verb");
    expect("cause" in vp.appendPullLog(dir, { event: "pull", site: "acme.test", agent: "a", lane: "l1", count: 1, cause: "evil" }, 1)).toBe(false);
  });

  it("turning sign-in on visit ON has exactly one dialog, Cancel the default; OFF has none", () => {
    const on = vp.settingsConfirmDialogs({ signInOnVisit: true }, { visitSites: 7 });
    expect(on).toHaveLength(1);
    expect(on[0].buttons[on[0].defaultId]).toBe("Cancel");
    expect(on[0].cancelId).toBe(on[0].defaultId);
    expect(on[0].detail).toContain("(7 sites)");
    expect(vp.settingsConfirmDialogs({ signInOnVisit: false })).toHaveLength(0);
  });
});

describe("the sensitive-sites panel words, and the most-used pick", () => {
  it("visitSuggestSensitive", () => {
    for (const s of ["mail.example.com", "slack.com", "github.com", "pay.example.org"]) expect(visitSuggestSensitive(s)).toBe(true);
    for (const s of ["example.com", "auth0.com"]) expect(visitSuggestSensitive(s)).toBe(false);
  });

  it("the 10 sites with the most cookies, of 12", () => {
    const sites = Array.from({ length: 12 }, (_, i) => ({ site: `s${String(i).padStart(2, "0")}.test`, cookies: i + 1 }));
    const picked = mostUsedSites([{ sites }]);
    expect(picked).toHaveLength(10);
    expect(picked[0]).toBe("s11.test");
    expect(picked).not.toContain("s00.test");
    expect(picked).not.toContain("s01.test");
    /* A site in two vaults counts both. */
    expect(mostUsedSites([{ sites: [{ site: "a.test", cookies: 3 }] }, { sites: [{ site: "a.test", cookies: 3 }, { site: "b.test", cookies: 5 }] }], 1)).toEqual(["a.test"]);
  });
});

describe("the vault-settings helper keeps signInOnVisit", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-vault-visit-"));
  const prevDir = process.env.AGX_VAULT_DIR;
  const store: VaultKeyStore & { held: string | null } = {
    held: null, state: async (): Promise<KeyStoreState> => "ready",
    get: async () => store.held, put: async (v: string) => { store.held = v; },
  };
  beforeEach(() => { process.env.AGX_VAULT_DIR = dir; __setVaultKeyStore(store); });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
    __setVaultKeyStore(null);
  });
  async function helper(argv: string[]): Promise<Record<string, unknown>> {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string, cb?: () => void) => { out.push(String(chunk)); cb?.(); return true; };
    try { await runCookieReader(argv); } finally { (process.stdout as { write: unknown }).write = write; }
    return JSON.parse(out.join("").trim().split("\n").pop() || "{}");
  }

  it("the default vault is the person's: set through the helper, read back, refused when no such vault, cleared with null", async () => {
    const { writeVault, vaultIdOf } = await import("../src/loginvault.ts");
    const id = vaultIdOf("zen:abcd1234", "1");
    await writeVault({
      v: 1, id, source: { profile: "zen:abcd1234", container: "1", label: "Zen — main" }, importedAt: 1_900_000_000,
      cookies: [{ url: "https://acme.test/", name: "sid", value: "invented", path: "/", secure: true, httpOnly: true, sameSite: "lax", domain: ".acme.test" }],
      storage: {},
    }, siteOf);
    expect((await helper(["vault-list"])).defaultVault).toBeNull();
    expect((await helper(["vault-settings", "--set", JSON.stringify({ defaultVault: "zen:nope/0" })])).ok).toBe(false);
    expect((await helper(["vault-list"])).defaultVault).toBeNull();
    expect((await helper(["vault-settings", "--set", JSON.stringify({ defaultVault: id })])).ok).toBe(true);
    expect((await helper(["vault-list"])).defaultVault).toBe(id);
    expect((await readSettings()).defaultVault).toBe(id);
    expect((await helper(["vault-settings", "--set", JSON.stringify({ defaultVault: null })])).ok).toBe(true);
    expect((await helper(["vault-list"])).defaultVault).toBeNull();
  });

  it("open takes --vault in the CLI and vault in the MCP tool, and the refusal names it only because of that", () => {
    const cli = readFileSync(join(import.meta.dir, "../../bin/agentglass-browser"), "utf8");
    const mcp = readFileSync(join(import.meta.dir, "../../bin/agentglass-browser-mcp"), "utf8");
    const open = cli.slice(cli.indexOf('sub.add_parser("open"'), cli.indexOf('sub.add_parser("read"'));
    expect(open).toContain('"--vault"');
    expect(cli).toMatch(/if a\.cmd == "open" and getattr\(a, "vault", None\):\n\s+body\["vault"\] = a\.vault\n/);
    const tool = mcp.slice(mcp.indexOf('"name": "browser_open"'), mcp.indexOf('"name": "browser_read"'));
    expect(tool).toContain('"vault"');
    expect(mcp).toContain('body["vault"] = args["vault"].strip()');
  });

  it("on by default, also for a settings file with no key (upgrade), and it round-trips", async () => {
    expect((await readSettings()).signInOnVisit).toBe(true);
    expect((await helper(["vault-settings", "--set", JSON.stringify({ signOutAtEnd: true })])).ok).toBe(true);
    expect((await readSettings()).signInOnVisit).toBe(true);
    expect((await helper(["vault-list"])).signInOnVisit).toBe(true);
    await helper(["vault-settings", "--set", JSON.stringify({ signInOnVisit: false })]);
    expect((await helper(["vault-list"])).signInOnVisit).toBe(false);
    await helper(["vault-settings", "--set", JSON.stringify({ signInOnVisit: true })]);
    expect((await helper(["vault-list"])).signInOnVisit).toBe(true);
    await helper(["vault-settings", "--set", JSON.stringify({ signInOnVisit: false })]);
    expect((await helper(["vault-list"])).signInOnVisit).toBe(false);
  });
});

describe("parse and worker gate", () => {
  it("lane new --ephemeral --vault X carries the vault; other containers refuse it", () => {
    const r = parseAsk("lane", { action: "new", ephemeral: true, vault: " Work " });
    expect("ask" in r && r.ask.args).toMatchObject({ action: "new", container: "ephemeral", vault: "Work" });
    expect("error" in parseAsk("lane", { action: "new", vault: "Work" })).toBe(true);
  });

  it("a worker may open an ephemeral lane only with --vault; a template tab is still refused", () => {
    expect(agentAskRefusal({ action: "new", ephemeral: true, vault: "Work", as: "wk" }, "wk", "lane")).toBeNull();
    expect(agentAskRefusal({ action: "new", ephemeral: true, as: "wk" }, "wk", "lane")).toContain("template");
    expect(agentAskRefusal({ action: "new", ephemeral: true, vault: " ", as: "wk" }, "wk", "lane")).toContain("template");
    expect(agentAskRefusal({ url: "https://acme.test/", ephemeral: true, profile: "wk", as: "wk" }, "wk", "newtab")).toContain("template");
  });
});

/* ---------------------------------------------------- the relay's on-visit step */

let pulls: Record<string, unknown>[] = [];
let opens = 0;
/* What fake main answers a pull: an object, or null for no answer. */
let answer: Record<string, unknown> | null = null;
/* How long fake main takes to answer a pull, and what crossed, in order. */
let pullDelay = 0;
let events: string[] = [];
const OPEN_VALUE = { tab: "t1", url: "https://acme.test/", title: "Acme" };

beforeEach(() => {
  resetBrowserDrive();
  pulls = [];
  opens = 0;
  pullDelay = 0;
  events = [];
  answer = { ok: false, code: "off" };
  setBrowserSink({
    send: (ask: BrowserAsk) => {
      const pull = (ask.args as { vaultPull?: Record<string, unknown> }).vaultPull;
      if (pull) {
        pulls.push(pull);
        events.push("pull");
        const a = answer;
        const done = () => { events.push("pull-done"); settleBrowser(ask.id, a ? { ok: true, value: a } : { ok: false, error: "timed out" }); };
        if (pullDelay > 0) setTimeout(done, pullDelay); else queueMicrotask(done);
        return true;
      }
      if (ask.op === "open" || ask.op === "newtab") { opens += 1; events.push("open"); }
      queueMicrotask(() => settleBrowser(ask.id, { ok: true, value: { ...OPEN_VALUE } }));
      return true;
    },
    listeners: () => 1,
    live: () => true,
  });
  noteBrowserManager("win-visit", true);
  configureLanes({ manage: async () => ({ ok: true }), hosted: () => true, forget: () => undefined });
});
afterEach(() => resetBrowserDrive());

async function lane(container: "ephemeral" | "private" = "ephemeral", vault?: string): Promise<string> {
  const r = await openLane(AGENT, container, undefined, vault);
  if (!r.ok) throw new Error(r.error);
  noteBrowserReady(`host-${r.lane.id}`, true, [r.lane.id]);
  return r.lane.id;
}
let n = 0;
const open = (id: string, url: string, op: "open" | "newtab" = "open") => askBrowser({ id: `o-${n++}`, op, args: { url, lane: id, as: AGENT } });

describe("a container the agent's own open did not make is never signed in", () => {
  const asOpen = (args: Record<string, unknown>) => askBrowser({ id: `c-${n++}`, op: "open", args: { url: "https://github.com/settings/profile", ...args } });
  const noteOf = (r: { value?: unknown }) => (r.value as { vault?: { signedIn: boolean; site: string; why: string } }).vault;
  /* The person's window with the browser view open: a tab mint lands there. */
  beforeEach(() => noteBrowserReady("win-person", true));

  it("first visit: no pull, and the answer says why and how to get a signed-in lane", async () => {
    answer = { ok: true, site: "github.com", vault: "zen:abc/0", set: 2 };
    const r = await asOpen({ profile: "autosign-test", as: "autosign-test" });
    expect(pulls).toHaveLength(0);
    const v = noteOf(r)!;
    expect(v).toMatchObject({ signedIn: false, site: "github.com" });
    expect(v.why).toContain("not made by your own open");
    expect(v.why).toContain('lane new --ephemeral --vault "<name>", then open https://github.com/settings/profile --lane <id>');
  });

  it("said once per container and site; a page-addressed open of the same container is the same one", async () => {
    await asOpen({ profile: "autosign-test", as: "autosign-test" });
    expect(noteOf(await asOpen({ page: "t1", as: "autosign-test" }))).toBeUndefined();
    expect(noteOf(await asOpen({ url: "https://gist.github.com/", page: "t1", as: "AutoSign-Test" }))).toBeUndefined();
    expect(noteOf(await asOpen({ url: "https://acme.test/", page: "t1", as: "autosign-test" }))?.site).toBe("acme.test");
    expect(noteOf(await asOpen({ profile: "other-agent" }))?.site).toBe("github.com");
    expect(pulls).toHaveLength(0);
  });

  it("the person's Default container, and a lane, get no container note", async () => {
    expect(noteOf(await asOpen({}))).toBeUndefined();
    expect(noteOf(await asOpen({ shared: true, as: "orbit-shared" }))).toBeUndefined();
    expect(noteOf(await asOpen({ as: "(default)" }))).toBeUndefined();
    expect(noteOf(await asOpen({ profile: "" }))).toBeUndefined();
    const plain = await lane("private");
    expect(noteOf(await open(plain, "https://github.com/"))).toBeUndefined();
    expect(pulls).toHaveLength(0);
  });
});

describe("the on-visit step in open/newtab", () => {
  it("asks once per lane per site: a second open and a subdomain ask nothing", async () => {
    const id = await lane();
    await open(id, "https://github.com/");
    await open(id, "https://github.com/settings");
    await open(id, "https://gist.github.com/", "newtab");
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ lane: id, site: "github.com", agent: AGENT, onVisit: true, budgetMs: 25_000 });
    /* Fixed when the server sent it: now + 25 s, not when main reads it. */
    expect(Math.abs((pulls[0]!.deadlineAt as number) - (Date.now() + 25_000))).toBeLessThan(5_000);
    expect(opens).toBe(3);
  });

  it("with it on, the Default container and the person's containers are never signed in", async () => {
    answer = { ok: true, site: "acme.test", vault: "zen:abc/0", set: 2, failed: 0, sensitive: false };
    for (const c of ["private", "shared", "named"] as const) {
      const r = await openLane(c === "shared" ? undefined : AGENT, c, c === "named" ? "Work" : undefined);
      if (!r.ok) throw new Error(r.error);
      noteBrowserReady(`host-${r.lane.id}`, true, [r.lane.id]);
      await open(r.lane.id, "https://acme.test/");
    }
    await askBrowser({ id: "o-nolane", op: "open", args: { url: "https://acme.test/" } });
    await askBrowser({ id: "o-shared", op: "newtab", args: { url: "https://acme.test/", shared: true } });
    expect(pulls).toHaveLength(0);
  });

  it("setting off: the reply is deep-equal to a plain open's, and nothing is marked or closed", async () => {
    const id = await lane();
    const plain = await lane("private");
    const off = await open(id, "https://acme.test/");
    const bare = await open(plain, "https://acme.test/");
    expect(pulls).toHaveLength(1);
    expect(off).toEqual(bare);
    expect(isVaultLane(id)).toBe(false);
    expect(laneKnown(id)).toBe(true);
  });

  it("none adds no vault field; sensitive, index and ambiguous navigate with a why", async () => {
    const id = await lane();
    for (const code of ["none"]) {
      answer = { ok: false, code };
      const r = await open(id, `https://www.${code}.test/`);
      expect(r.ok).toBe(true);
      expect((r.value as Record<string, unknown>).vault).toBeUndefined();
    }
    for (const [code, extra] of [["sensitive", {}], ["index", {}], ["ambiguous", { vaults: [{ id: "zen:a/0", label: "Work" }, { id: "zen:b/0", label: "Home" }] }]] as const) {
      answer = { ok: false, code, error: `fake ${code}`, ...extra };
      const r = await open(id, `https://www.${code}.test/`);
      expect(r.ok).toBe(true);
      const v = (r.value as { vault: { signedIn: boolean; site: string; why: string } }).vault;
      expect(v.signedIn).toBe(false);
      expect(v.site).toBe(`${code}.test`);
      if (code === "ambiguous") expect(v.why).toContain("--vault");
      expect(laneKnown(id)).toBe(true);
    }
  });

  it("a sign-in: the reply says signedIn and which vault", async () => {
    answer = { ok: true, site: "acme.test", vault: "zen:abc/0", set: 2, failed: 0, sensitive: false };
    /* The person knows the box by the name Settings shows; the id rides beside it. */
    const dir = mkdtempSync(join(tmpdir(), "agx-vault-visit-name-"));
    const prev = process.env.AGX_VAULT_DIR;
    process.env.AGX_VAULT_DIR = dir;
    writeFileSync(join(dir, "index.json"), JSON.stringify({ v: 1, vaults: { "zen:abc/0": { label: "Zen — Orbit", file: "x.vault", sites: 1 } } }));
    try {
      const id = await lane();
      const r = await open(id, "https://acme.test/");
      expect((r.value as { vault: unknown }).vault).toEqual({ signedIn: true, site: "acme.test", vault: "Zen — Orbit", vaultId: "zen:abc/0" });
      expect(isVaultLane(id)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prev;
    }
  });

  it("two first opens at once: the second waits for the running sign-in and gets its answer", async () => {
    answer = { ok: true, site: "acme.test", vault: "orbit", set: 2 };
    pullDelay = 30;
    const id = await lane();
    const [a, b] = await Promise.all([open(id, "https://acme.test/"), open(id, "https://www.acme.test/", "newtab")]);
    expect(pulls).toHaveLength(1);
    expect(events).toEqual(["pull", "pull-done", "open", "open"]);
    for (const r of [a, b]) expect((r.value as { vault: { signedIn: boolean } }).vault.signedIn).toBe(true);
  });

  it("no answer: navigates, does not close, marks the lane, and never asks again for that site", async () => {
    answer = null;
    const id = await lane();
    const r = await open(id, "https://acme.test/");
    expect(r.ok).toBe(true);
    expect((r.value as { vault: { why: string } }).vault.why).toContain("did not finish in time");
    expect(laneKnown(id)).toBe(true);
    expect(isVaultLane(id)).toBe(true);
    await open(id, "https://acme.test/");
    expect(pulls).toHaveLength(1);
  });

  it("late and no-guard navigate and do not close; closed fails the open", async () => {
    for (const code of ["late", "no-guard"]) {
      answer = { ok: false, code, error: `fake ${code}` };
      const id = await lane();
      const r = await open(id, "https://acme.test/");
      expect(r.ok).toBe(true);
      expect(laneKnown(id)).toBe(true);
    }
    answer = { ok: false, code: "closed", error: "fake closed" };
    const id = await lane();
    const before = opens;
    const r = await open(id, "https://acme.test/");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`no lane called ${id}`);
    expect(opens).toBe(before);
  });

  it("the verb path still closes the lane on no answer", async () => {
    answer = null;
    const id = await lane();
    const r = await askBrowser({ id: "v-1", op: "lane", args: { action: "vault", id, site: "acme.test", as: AGENT } });
    expect(r.error).toContain("the lane was closed");
    expect(laneKnown(id)).toBe(false);
    expect(pulls[0]!.onVisit).toBeUndefined();
  });

  it("the verb path names the vault by its label, the id beside it", async () => {
    answer = { ok: true, site: "acme.test", vault: "zen:abc/0", label: "Zen — Orbit", set: 2, failed: 0, sensitive: false };
    const dir = mkdtempSync(join(tmpdir(), "agx-vault-verb-name-"));
    const prev = process.env.AGX_VAULT_DIR;
    process.env.AGX_VAULT_DIR = dir;
    writeFileSync(join(dir, "index.json"), JSON.stringify({ v: 1, vaults: { "zen:abc/0": { label: "Zen — Orbit", file: "x.vault", sites: 1 } } }));
    try {
      const id = await lane();
      const r = await askBrowser({ id: "v-2", op: "lane", args: { action: "vault", id, site: "acme.test", as: AGENT } });
      expect(r.value).toMatchObject({ vault: "Zen — Orbit", vaultId: "zen:abc/0" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prev;
    }
  });

  it("open --vault X pulls from X, and wins over the lane's own vault", async () => {
    const id = await lane("ephemeral", "Home");
    await askBrowser({ id: `ov-${n++}`, op: "open", args: { url: "https://acme.test/", lane: id, as: AGENT, vault: "Work" } });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ site: "acme.test", vault: "Work" });
  });

  it("re-open --vault X after an ambiguous first visit pulls again; once signed in it does not", async () => {
    const id = await lane();
    answer = { ok: false, code: "ambiguous", error: "fake ambiguous", vaults: [{ id: "zen:a/0", label: "Work" }, { id: "zen:b/0", label: "Home" }] };
    await open(id, "https://acme.test/");
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.vault).toBeUndefined();
    /* A plain re-open does not ask again. */
    await open(id, "https://acme.test/");
    expect(pulls).toHaveLength(1);
    answer = { ok: true, site: "acme.test", vault: "zen:a/0", set: 2, failed: 0, sensitive: false };
    const re = (vault: string) => askBrowser({ id: `ov-${n++}`, op: "open", args: { url: "https://acme.test/", lane: id, as: AGENT, vault } });
    const r = await re("Work");
    expect(pulls).toHaveLength(2);
    expect(pulls[1]).toMatchObject({ site: "acme.test", vault: "Work" });
    expect((r.value as { vault: { signedIn: boolean } }).vault.signedIn).toBe(true);
    await re("Work");
    expect(pulls).toHaveLength(2);
  });

  it("lane new --ephemeral --vault X saves the vault and passes it", async () => {
    const id = await lane("ephemeral", "Work");
    expect(laneRecord(id)?.vault).toBe("Work");
    await open(id, "https://acme.test/");
    expect(pulls[0]).toMatchObject({ vault: "Work" });
  });
});

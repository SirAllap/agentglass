/*
 * Electron main's side of the login vault (electron/vault-pull.js): who may
 * pull, what reaches cookies.set, what the pull log may hold. Invented hosts.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vp = require("../../electron/vault-pull.js");

const dir = mkdtempSync(join(tmpdir(), "agx-vault-pull-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vault pull, main side", () => {
  it("refuses read-only mode, a missing lane and a persistent profile (F1)", () => {
    expect(vp.pullRefusal({ readonly: true, lane: { ephemeral: true }, site: "acme.test" })).toContain("read-only");
    expect(vp.pullRefusal({ readonly: false, lane: undefined, site: "acme.test" })).toContain("no lane");
    expect(vp.pullRefusal({ readonly: false, lane: { ephemeral: false }, site: "acme.test" })).toContain("persistent");
    expect(vp.pullRefusal({ readonly: false, lane: { ephemeral: true }, site: "Not A Site/" })).toContain("one site");
    expect(vp.pullRefusal({ readonly: false, lane: { ephemeral: true }, site: "acme.test" })).toBeNull();
  });

  it("partitioned cookies do not go through cookies.set; unknown fields are dropped", () => {
    expect(vp.toLaneCookie({ url: "https://acme.test/", name: "p", value: "x", partitionKey: { topLevelSite: "https://orbit.test" } })).toBeNull();
    expect(vp.toLaneCookie({ url: "https://acme.test/", name: "s", value: "x", extra: 1, secure: true })).toEqual({ url: "https://acme.test/", name: "s", value: "x", secure: true, path: "/" });
  });

  it("the pull log holds site, agent, lane, time, count, and is 0600", () => {
    vp.appendPullLog(dir, { event: "pull", site: "acme.test", agent: "builder", lane: "l1", vault: "zen:a/1", count: 3, value: "invented-secret" }, 100);
    const text = readFileSync(join(dir, "pulls.jsonl"), "utf8");
    expect(text).not.toContain("invented-secret");
    expect(JSON.parse(text.trim())).toEqual({ at: 100, event: "pull", site: "acme.test", agent: "builder", lane: "l1", vault: "zen:a/1", count: 3 });
    expect(statSync(join(dir, "pulls.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("main's book finds the lanes that hold a vault, for Remove and Empty (F2)", () => {
    const b = vp.createVaultLanes();
    b.mark("l1", "agentglass-browser-eph-l1", "a", "acme.test", "zen:a/1");
    b.mark("l2", "agentglass-browser-eph-l2", "b", "orbit.test", "zen:a/2");
    expect(b.holding("zen:a/1").map((l: { lane: string }) => l.lane)).toEqual(["l1"]);
    expect(b.holding().map((l: { lane: string }) => l.lane).sort()).toEqual(["l1", "l2"]);
    expect(b.drop("l1").sites.get("acme.test")).toBe("zen:a/1");
    expect(b.has("l1")).toBe(false);
  });

  it("the vault dir matches loginvault.ts", () => {
    expect(vp.vaultDirFor({ AGX_VAULT_DIR: "/x" }, "/h")).toBe("/x");
    expect(vp.vaultDirFor({}, "/h")).toBe("/h/.local/share/agentglass/vaults");
  });
});

describe("vault pull, through the lane's page", () => {
  const chip = {
    url: "https://widgets.orbit.test/", name: "sid", value: "fake-value-1", domain: ".widgets.orbit.test", path: "/",
    secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 2000000000,
    partitionKey: { topLevelSite: "https://acme.test", hasCrossSiteAncestor: false },
  };
  it("a partitioned cookie becomes Network.setCookie with its key (CHIPS)", () => {
    expect(vp.toCdpCookie(chip)).toEqual({
      name: "sid", value: "fake-value-1", url: "https://widgets.orbit.test/", path: "/", secure: true, httpOnly: true,
      partitionKey: { topLevelSite: "https://acme.test", hasCrossSiteAncestor: false },
      domain: ".widgets.orbit.test", sameSite: "None", expires: 2000000000,
    });
    // ...and is never handed to cookies.set as is.
    expect(vp.toLaneCookie(chip)).toBeNull();
  });
  it("refuses one CDP would refuse: not Secure, or a key that is not a site", () => {
    expect(vp.toCdpCookie({ ...chip, secure: false })).toBeNull();
    expect(vp.toCdpCookie({ ...chip, partitionKey: { topLevelSite: "acme.test/x" } })).toBeNull();
    expect(vp.toCdpCookie({ ...chip, partitionKey: undefined })).toBeNull();
  });
  it("a host-only cookie carries no domain; a session one no expiry", () => {
    const c = vp.toCdpCookie({ ...chip, domain: "widgets.orbit.test", expirationDate: undefined, sameSite: "unspecified" });
    expect(c.domain).toBeUndefined();
    expect(c.expires).toBeUndefined();
    expect(c.sameSite).toBeUndefined();
  });
  it("storage: http(s) origin only, string values only, empty is nothing", () => {
    expect(vp.toLaneStorage({ origin: "https://acme.test", local: { a: "1", b: 2 } })).toEqual({ origin: "https://acme.test", local: { a: "1" } });
    expect(vp.toLaneStorage({ origin: "file:///etc", local: { a: "1" } })).toBeNull();
    expect(vp.toLaneStorage({ origin: "https://acme.test/path", local: { a: "1" } })).toBeNull();
    expect(vp.toLaneStorage({ origin: "https://acme.test", local: {} })).toBeNull();
  });
  it("the storage script fills only its own origin and never overwrites a key", () => {
    const src = vp.storageScript({ origin: "https://acme.test", local: { a: "1", b: "x\"y" } });
    const store = new Map([["b", "site wrote this"]]);
    const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const run = (origin: string) => new Function("location", "localStorage", `return ${src}`)({ origin }, localStorage);
    expect(run("https://orbit.test")).toBe(0);
    expect(store.has("a")).toBe(false);
    expect(run("https://acme.test")).toBe(1);
    expect(store.get("a")).toBe("1");
    expect(store.get("b")).toBe("site wrote this");
  });
});

describe("vault security, main side (run 7)", () => {
  it("finding 2: taking the sensitive mark off needs main's confirm; marking does not", () => {
    expect(vp.settingsNeedConfirm({ site: "bank.test", sensitive: false })).toBe(true);
    expect(vp.settingsNeedConfirm({ site: "bank.test", sensitive: true })).toBe(false);
    expect(vp.settingsNeedConfirm({ site: "bank.test", needsStorage: false })).toBe(false);
    const d = vp.sensitiveOffDialog("bank.test");
    expect(d.message).toContain("bank.test");
    expect(d.buttons[d.defaultId]).toBe("Keep sensitive");
    expect(d.cancelId).toBe(d.defaultId);
  });

  it("finding 3: main tells the server about the lane before the first cookie, window pulls too", () => {
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    const pull = src.slice(src.indexOf('ipcMain.handle("ag:vaultPull"'), src.indexOf('ipcMain.handle("ag:vaultImport"'));
    const report = pull.indexOf("reportVaultLane(lane");
    expect(report).toBeGreaterThan(0);
    expect(report).toBeLessThan(pull.indexOf("ses.cookies.set"));
    expect(report).toBeLessThan(pull.indexOf("fillLaneGuest("));
    expect(pull.indexOf("vaultLanes.mark(")).toBeLessThan(pull.indexOf("ses.cookies.set"));
  });

  it("finding 6: Remove or Empty moves the epoch a waiting pull checks", () => {
    const book = vp.createVaultLanes();
    const before = book.epoch();
    book.bump();
    expect(book.epoch()).not.toBe(before);
    const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
    const pull = src.slice(src.indexOf('ipcMain.handle("ag:vaultPull"'), src.indexOf('ipcMain.handle("ag:vaultImport"'));
    expect(pull.indexOf("vaultLanes.epoch() !== epoch")).toBeGreaterThan(pull.indexOf("askSensitive("));
    expect(pull.indexOf("vaultLanes.epoch() !== epoch")).toBeLessThan(pull.indexOf("ses.cookies.set"));
    const remove = src.slice(src.indexOf('ipcMain.handle("ag:vaultRemove"'), src.indexOf('ipcMain.handle("ag:vaultUseInMyBrowser"'));
    expect(remove.indexOf("vaultLanes.bump()")).toBeLessThan(remove.indexOf('"vault-remove"'));
  });

  it("finding 7: Use in my browser names the sensitive sites and says it is the person's own browser", () => {
    const d = vp.useInBrowserDialog(["acme.test", "bank.test"], ["bank.test"]);
    expect(d.detail).toContain("Sensitive: bank.test");
    expect(d.detail).toContain("your own browser");
    expect(d.buttons[d.defaultId]).toBe("Cancel");
    expect(vp.useInBrowserDialog([], []).detail).toContain("your own browser");
  });
});

describe("vault security, main side (run 8)", () => {
  const src = readFileSync(join(import.meta.dir, "../../electron/main.js"), "utf8");
  const pull = src.slice(src.indexOf('ipcMain.handle("ag:vaultPull"'), src.indexOf('ipcMain.handle("ag:vaultImport"'));

  it("new 2: turning sign-out off needs main's confirm; turning it on does not", () => {
    expect(vp.settingsNeedConfirm({ signOutAtEnd: false })).toBe(true);
    expect(vp.settingsNeedConfirm({ signOutAtEnd: true })).toBe(false);
    const ds = vp.settingsConfirmDialogs({ site: "bank.test", sensitive: false, signOutAtEnd: false });
    expect(ds).toHaveLength(2);
    const d = vp.settingsConfirmDialogs({ signOutAtEnd: false })[0];
    expect(d.message).toContain("sign");
    expect(d.buttons[d.defaultId]).toBe("Keep signing out");
    expect(d.cancelId).toBe(d.defaultId);
    const set = src.slice(src.indexOf('ipcMain.handle("ag:vaultSettings"'), src.indexOf('ipcMain.handle("ag:vaultRemove"'));
    expect(set).toContain("settingsConfirmDialogs(ask, info)");
    expect(set.indexOf("settingsConfirmDialogs(ask, info)")).toBeLessThan(set.indexOf('"vault-settings"'));
  });

  it("new 3: the lane is checked again after the yes and before each set", () => {
    const alive = "laneGone()";
    const after = pull.indexOf("askSensitive(");
    const first = pull.indexOf(alive, after);
    expect(first).toBeGreaterThan(after);
    expect(first).toBeLessThan(pull.indexOf("reportVaultLane(lane"));
    /* The loop is putLaneCookies, which checks `gone` before each set. */
    expect(pull).toMatch(/putLaneCookies\(got\.cookies \|\| \[\], \{ set: \(.*c\) => ses\.cookies\.set\(/);
    expect(pull).toContain("gone: laneGone");
    expect(pull.slice(pull.indexOf("ses.cookies.set"), pull.indexOf("fillLaneGuest("))).toContain(alive);
    expect(pull).toContain('why: "lane closed"');
  });

  it("new 4: a lane that closes while partitioned cookies go in keeps nothing and logs aborted", () => {
    const fill = src.slice(src.indexOf("async function fillLaneGuest("), src.indexOf("function onVaultLaneGuest("));
    const after = fill.slice(fill.indexOf("await setChipsOnGuest("));
    expect(after.slice(0, after.indexOf("vaultPending.set("))).toContain("laneHosts.has(id)");
    const tail = pull.slice(pull.indexOf("await fillLaneGuest("));
    expect(tail.slice(0, tail.indexOf('event: "pull"'))).toContain("laneGone()");
    expect(tail.slice(0, tail.indexOf('event: "pull"'))).toContain('event: "aborted"');
  });
});

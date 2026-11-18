/*
 * One fixture per cause from the login-vault plan. Every row is invented
 * (acme, orbit hosts) and built here; no real cookie is read.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv } from "node:crypto";
import { chromiumPartitionKey, firefoxPartitionKey, parseOriginAttributes, planImport } from "../src/cookieimport.ts";
import { __setKeyringLookup, chromiumKey, chromiumVerdict, chromiumWhy, deriveKey, readChromium } from "../src/chromiumcookies.ts";
import { findProfiles } from "../src/cookiesources.ts";
import { readFirefox, readFirefoxAll, readFirefoxSession } from "../src/cookiesources.ts";
import { writeFileSync } from "node:fs";
import { mozLz4Json } from "../src/mozlz4.ts";

const NOW = 1_900_000_000;
const scratch = mkdtempSync(join(tmpdir(), "agx-vault-causes-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type FfRow = { host: string; name: string; value: string; expiry: number; secure?: number; sameSite?: number; oa?: string };
/** A Firefox-shaped cookies.sqlite (schema 17: expiry in ms). */
function firefoxDb(name: string, rows: FfRow[]): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cookies.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT, name TEXT, value TEXT, path TEXT,
    expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT NOT NULL DEFAULT '')`);
  db.exec("PRAGMA user_version = 17");
  const ins = db.prepare("INSERT INTO moz_cookies (host,name,value,path,expiry,isSecure,isHttpOnly,sameSite,originAttributes) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const r of rows) ins.run(r.host, r.name, r.value, "/", r.expiry, r.secure ?? 1, 1, r.sameSite ?? 1, r.oa ?? "");
  db.close();
  return path;
}

const CHROME_KEY = deriveKey(Buffer.from("an invented keyring password"));
function chromeEnc(value: string, key = CHROME_KEY): Buffer {
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v11"), c.update(value, "utf8"), c.final()]);
}
const chromeMicros = (sec: number) => (sec + 11_644_473_600) * 1_000_000;
type CrRow = { host: string; name: string; value: string; expires: number; top?: string; persistent?: number };
/** A Chromium-shaped Cookies database at `dir/rel`. */
function chromiumDb(dir: string, rows: CrRow[], rel = "Cookies", key = CHROME_KEY): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec(`CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT, is_persistent INTEGER)`);
  const ins = db.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of rows) ins.run(r.host, r.name, chromeEnc(r.value, key), "", "/", r.expires ? chromeMicros(r.expires) : 0, 1, 1, -1, r.top ?? "", r.persistent ?? 1);
  db.close();
  return path;
}

describe("cause 2: a container is a jar, not a partition", () => {
  it("splits userContextId from partitionKey", () => {
    expect(parseOriginAttributes("")).toEqual({ container: "0", other: "" });
    expect(parseOriginAttributes("^userContextId=3")).toEqual({ container: "3", other: "" });
    expect(parseOriginAttributes("^userContextId=2&partitionKey=%28https%2Cacme.test%29"))
      .toEqual({ container: "2", partitionKey: "(https,acme.test)", other: "" });
    expect(parseOriginAttributes("^firstPartyDomain=orbit.test").other).toBe("firstPartyDomain=orbit.test");
  });

  it("imports a container's first-party login into that container's plan only", () => {
    const db = firefoxDb("containers", [
      { host: ".acme.test", name: "home", value: "invented-0", expiry: (NOW + 999) * 1000 },
      { host: ".acme.test", name: "work", value: "invented-1", expiry: (NOW + 999) * 1000, oa: "^userContextId=1" },
      { host: ".orbit.test", name: "work2", value: "invented-2", expiry: (NOW + 999) * 1000, oa: "^userContextId=1" },
    ]);
    const rows = readFirefox(db);
    const none = planImport(rows, "firefox", { sites: ["acme.test", "orbit.test"], nowSeconds: NOW });
    const one = planImport(rows, "firefox", { sites: ["acme.test", "orbit.test"], nowSeconds: NOW, container: "1" });
    expect(none.install.map((c) => c.name)).toEqual(["home"]);
    expect(none.skipped["other-container"]).toBe(2);
    expect(one.install.map((c) => c.name).sort()).toEqual(["work", "work2"]);
    expect(one.skipped.partitioned).toBe(0);
    // No container attribute rides along into the cookie itself.
    expect(JSON.stringify(one.install)).not.toContain("userContextId");
  });
});

describe("cause 4: SameSite=None without Secure", () => {
  it("becomes unspecified instead of a refused set; secure None stays None", () => {
    const db = firefoxDb("samesite", [
      { host: "acme.test", name: "loose", value: "invented-a", expiry: (NOW + 999) * 1000, secure: 0, sameSite: 0 },
      { host: "acme.test", name: "tight", value: "invented-b", expiry: (NOW + 999) * 1000, secure: 1, sameSite: 0 },
    ]);
    const plan = planImport(readFirefox(db), "firefox", { sites: ["acme.test"], nowSeconds: NOW });
    const by = Object.fromEntries(plan.install.map((c) => [c.name, c.sameSite]));
    expect(by).toEqual({ loose: "unspecified", tight: "no_restriction" });
  });
});

describe("cause 5: partitioned (CHIPS) cookies keep their partition", () => {
  it("maps Firefox and Chromium partition keys to CDP's shape", () => {
    expect(firefoxPartitionKey("(https,acme.test)")).toEqual({ topLevelSite: "https://acme.test", hasCrossSiteAncestor: false });
    expect(firefoxPartitionKey("(https,acme.test,8443)")).toEqual({ topLevelSite: "https://acme.test:8443", hasCrossSiteAncestor: false });
    expect(firefoxPartitionKey("(https,acme.test,f)")).toEqual({ topLevelSite: "https://acme.test", hasCrossSiteAncestor: true });
    expect(firefoxPartitionKey("garbage")).toBeNull();
    expect(chromiumPartitionKey("https://orbit.test")).toEqual({ topLevelSite: "https://orbit.test", hasCrossSiteAncestor: false });
  });

  it("Firefox: kept with its key for the vault, still skipped for cookies.set", () => {
    const db = firefoxDb("chips-ff", [
      { host: "widget.orbit.test", name: "emb", value: "invented-p", expiry: (NOW + 999) * 1000, oa: "^partitionKey=%28https%2Cacme.test%29" },
    ]);
    const rows = readFirefox(db);
    const jar = planImport(rows, "firefox", { sites: ["orbit.test"], nowSeconds: NOW });
    expect(jar.install).toEqual([]);
    expect(jar.skipped.partitioned).toBe(1);
    const vault = planImport(rows, "firefox", { sites: ["orbit.test"], nowSeconds: NOW, keepPartitioned: true });
    expect(vault.install[0]!.partitionKey).toEqual({ topLevelSite: "https://acme.test", hasCrossSiteAncestor: false });
  });

  it("Chromium: top_frame_site_key becomes the partition key", () => {
    const db = chromiumDb(join(scratch, "chips-cr"), [
      { host: "widget.orbit.test", name: "emb", value: "invented-c", expires: NOW + 999, top: "https://acme.test" },
    ]);
    const read = readChromium(db, CHROME_KEY);
    const vault = planImport(read.rows, "chromium", { sites: ["orbit.test"], nowSeconds: NOW, keepPartitioned: true });
    expect(vault.install.map((c) => [c.name, c.partitionKey])).toEqual([["emb", { topLevelSite: "https://acme.test", hasCrossSiteAncestor: false }]]);
  });
});

/** A mozLz4 file whose LZ4 block is one all-literals sequence: valid, uncompressed. */
function mozLz4(json: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(json), "utf8");
  const len: number[] = [];
  let n = body.length;
  if (n >= 15) { n -= 15; while (n >= 255) { len.push(255); n -= 255; } len.push(n); }
  const head = Buffer.alloc(12);
  Buffer.from("mozLz40\0", "latin1").copy(head);
  head.writeUInt32LE(body.length, 8);
  return Buffer.concat([head, Buffer.from([(Math.min(body.length, 15)) << 4, ...len]), body]);
}

describe("cause 3: session cookies from the session store", () => {
  const dir = join(scratch, "session");
  const state = {
    cookies: [
      { host: ".acme.test", name: "sess", value: "invented-s", path: "/", secure: true, httponly: true, sameSite: 1, originAttributes: { userContextId: 0 } },
      { host: "orbit.test", name: "csess", value: "invented-t", path: "/", secure: true, originAttributes: { userContextId: 2 } },
      { host: ".acme.test", name: "dup", value: "invented-d", path: "/", secure: true, originAttributes: { userContextId: 0 } },
      { host: "acme.test", name: "priv", value: "invented-x", path: "/", originAttributes: { privateBrowsingId: 1 } },
    ],
  };

  it("reads recovery.jsonlz4 (mozLz4) and dedupes against cookies.sqlite", () => {
    const db = firefoxDb("session", [{ host: ".acme.test", name: "dup", value: "invented-d", expiry: (NOW + 999) * 1000 }]);
    mkdirSync(join(dir, "sessionstore-backups"), { recursive: true });
    writeFileSync(join(dir, "sessionstore-backups", "recovery.jsonlz4"), mozLz4(state));
    expect(mozLz4Json<typeof state>(mozLz4(state)).cookies.length).toBe(4);
    const session = readFirefoxSession(dir);
    expect(session.map((r) => [r.name, r.container, r.expires])).toEqual([["sess", "0", 0], ["csess", "2", 0], ["dup", "0", 0]]);
    const all = readFirefoxAll(db, dir);
    expect(all.filter((r) => r.name === "dup").length).toBe(1);
  });

  it("the vault keeps them as session cookies; the person's jar still refuses", () => {
    const rows = readFirefoxSession(dir);
    const jar = planImport(rows, "firefox", { sites: ["acme.test"], nowSeconds: NOW });
    expect(jar.install).toEqual([]);
    expect(jar.skipped["session-only"]).toBe(2);
    const vault = planImport(rows, "firefox", { sites: ["acme.test"], nowSeconds: NOW, keepSession: true });
    expect(vault.install.map((c) => c.name).sort()).toEqual(["dup", "sess"]);
    expect(vault.install.every((c) => !("expirationDate" in c))).toBe(true);
    const work = planImport(rows, "firefox", { sites: ["orbit.test"], nowSeconds: NOW, keepSession: true, container: "2" });
    expect(work.install.map((c) => c.name)).toEqual(["csess"]);
  });

  it("no session store is no rows, not an error", () => {
    expect(readFirefoxSession(join(scratch, "nowhere"))).toEqual([]);
  });
});

describe("cause 6: keyring states are told apart", () => {
  const PW = Buffer.from("an invented keyring password");
  let jar = "";
  const db = () => jar || (jar = chromiumDb(join(scratch, "keyring"), [{ host: ".acme.test", name: "sid", value: "invented-k", expires: NOW + 999 }], "Cookies", deriveKey(PW)));
  afterAll(() => __setKeyringLookup(null));

  async function verdictWith(answer: Awaited<ReturnType<Parameters<typeof __setKeyringLookup>[0] & {}>>) {
    __setKeyringLookup(async () => answer);
    const key = await chromiumKey("chrome");
    const read = readChromium(db(), deriveKey(key.password));
    return { state: key.state, verdict: chromiumVerdict(key.state, read.rows.length, read.failed) };
  }

  it("found + right key opens; found + wrong key says wrong key", async () => {
    expect(await verdictWith({ state: "found", value: PW })).toEqual({ state: "found", verdict: "ok" });
    expect(await verdictWith({ state: "found", value: Buffer.from("not it") })).toEqual({ state: "found", verdict: "wrong-key" });
  });

  it("no answer and locked are named, never a silent 'would not decrypt'", async () => {
    expect(await verdictWith({ state: "no-answer" })).toEqual({ state: "no-answer", verdict: "no-answer" });
    expect(await verdictWith({ state: "locked" })).toEqual({ state: "locked", verdict: "locked" });
    expect(await verdictWith({ state: "absent" })).toEqual({ state: "absent", verdict: "no-key" });
    expect(chromiumWhy("locked", "Orbit Browser")).toContain("locked");
    expect(chromiumWhy("no-answer", "Orbit Browser")).toContain("No keyring answered");
  });

  it("locked wins over absent across the two attribute asks", async () => {
    const answers = [{ state: "absent" as const }, { state: "locked" as const }];
    let i = 0;
    __setKeyringLookup(async () => answers[i++]!);
    expect((await chromiumKey("chrome")).state).toBe("locked");
  });
});

describe("cause 6: more Chromium browsers and Network/Cookies", () => {
  it("finds Edge, Vivaldi, Opera (profile in the base dir) and a Network/Cookies jar", () => {
    const home = join(scratch, "home");
    chromiumDb(join(home, ".config/microsoft-edge/Default"), [], "Network/Cookies");
    chromiumDb(join(home, ".config/vivaldi/Profile 1"), []);
    chromiumDb(join(home, ".config/opera"), []);
    const found = findProfiles("linux", home).map((p) => [p.id, p.keyring, p.db.slice(home.length)]);
    expect(found).toEqual([
      ["edge:Default", "microsoft-edge", "/.config/microsoft-edge/Default/Network/Cookies"],
      ["vivaldi:Profile 1", "vivaldi", "/.config/vivaldi/Profile 1/Cookies"],
      ["opera:opera", "opera", "/.config/opera/Cookies"],
    ]);
  });
});

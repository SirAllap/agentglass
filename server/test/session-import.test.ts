/*
 * `session import --from firefox-profile` brings a whole login over, and the
 * two cookies the picker's importer drops are the two this keeps: a session
 * cookie (no expiry) and every attribute of a `__Host-` one. Measured against
 * the strict site, those two are what a sensitive action needs.
 *
 * The CLI reads the profile in its own process (Python + sqlite3), so this
 * builds a real cookies.sqlite in the Firefox shape and asserts the exact
 * `cookies --set` payloads the CLI sends — the values included, to prove they
 * arrive, and the summary line, to prove they are never printed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsk, redactAskForTest, type BrowserOp } from "../src/browserdrive.ts";
import { startBrowserStub, runCli } from "./fixtures/browser-stub.ts";

const HAVE_PY = !!Bun.which("python3");
const DAY = 86_400_000;

/** A Firefox cookies.sqlite (schema 17: expiry in ms), with a signed-in
 *  session for orbit.example plus a cookie for another site. */
function fakeProfile(dir: string): string {
  const db = new Database(join(dir, "cookies.sqlite"));
  db.run("PRAGMA user_version = 17");
  db.run(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT DEFAULT '',
    name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER,
    creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, rawSameSite INTEGER)`);
  const soon = Date.now() + 30 * DAY;
  const add = (c: Partial<Record<string, unknown>>) => db.run(
    `INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite)
     VALUES ($oa, $n, $v, $h, $p, $e, $s, $ho, $ss)`,
    { $oa: c.oa ?? "", $n: c.n, $v: c.v, $h: c.h, $p: c.p ?? "/", $e: c.e ?? 0, $s: c.s ?? 0, $ho: c.ho ?? 0, $ss: c.ss ?? 256 } as never);
  // The persistent, host-only, secure, httpOnly session id.
  add({ n: "__Host-orbit_sid", v: "sid-not-printed", h: "www.orbit.example", e: soon, s: 1, ho: 1, ss: 1 });
  // The SESSION cookie the picker drops (expiry 0) — sudo depends on it.
  add({ n: "orbit_sess", v: "sess-not-printed", h: "www.orbit.example", e: 0, s: 1, ho: 1, ss: 1 });
  // A domain cookie for the parent, SameSite=Strict.
  add({ n: "__Secure-orbit_same_site", v: "ss-not-printed", h: ".orbit.example", e: soon, s: 1, ho: 1, ss: 2 });
  // An insecure SameSite=None cookie — the None must be dropped, not the cookie.
  add({ n: "orbit_pref", v: "dark", h: ".orbit.example", e: soon, s: 0, ho: 0, ss: 0 });
  // Not this domain, an expired one, and a container cookie: all skipped.
  add({ n: "other", v: "x", h: "www.elsewhere.example", e: soon, s: 1, ho: 1 });
  add({ n: "stale", v: "x", h: "www.orbit.example", e: Date.now() - DAY, s: 1, ho: 1 });
  add({ n: "contained", v: "x", h: "www.orbit.example", e: soon, s: 1, ho: 1, oa: "^userContextId=2" });
  db.close();
  return dir;
}

/** Every call the CLI made, as the audit log would hold it: the same parse and
 *  the same redaction the server applies before `persistAudit`. A call the
 *  parser refuses is kept raw, so a value in it still fails the assertion. */
function audited(calls: { op: string; body: Record<string, unknown> }[]): string {
  return calls.map((c) => {
    const p = parseAsk(c.op, c.body);
    return JSON.stringify("ask" in p ? redactAskForTest(c.op as BrowserOp, p.ask.args) : c.body);
  }).join("\n");
}

let stub: ReturnType<typeof startBrowserStub>, profile = "";
beforeAll(() => {
  stub = startBrowserStub(() => ({ ok: true, value: {} }));
  profile = fakeProfile(mkdtempSync(join(tmpdir(), "agx-ffprofile-")));
});
afterAll(() => { stub.stop(); rmSync(profile, { recursive: true, force: true }); });

test.skipIf(!HAVE_PY)("every live cookie for the domain arrives, session cookie included, with its attributes", async () => {
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", profile, "--domain", "orbit.example"]);
  expect(r.code, r.stderr).toBe(0);
  const sets = stub.calls.filter((c) => c.op === "cookies").map((c) => c.body.set as Record<string, unknown>);
  const by = Object.fromEntries(sets.map((s) => [s.name, s]));

  expect(Object.keys(by).sort()).toEqual(["__Host-orbit_sid", "__Secure-orbit_same_site", "orbit_pref", "orbit_sess"]);
  // Host-only, secure, httpOnly, and NO expiry left off by accident.
  expect(by["__Host-orbit_sid"]).toMatchObject({ host: "www.orbit.example", secure: true, httpOnly: true, sameSite: "Lax" });
  expect(by["__Host-orbit_sid"]).not.toHaveProperty("domain");
  expect(typeof by["__Host-orbit_sid"]!.expires).toBe("number");
  // The session cookie the picker drops: kept, and kept as a session cookie.
  expect(by.orbit_sess).toMatchObject({ name: "orbit_sess", secure: true, httpOnly: true });
  expect(by.orbit_sess).not.toHaveProperty("expires");
  // A domain cookie carries the dot; Strict survives.
  expect(by["__Secure-orbit_same_site"]).toMatchObject({ domain: ".orbit.example", sameSite: "Strict" });
  // SameSite=None on an insecure cookie: the None is dropped, the cookie is not.
  expect(by.orbit_pref).not.toHaveProperty("sameSite");
  expect(by.orbit_pref).toMatchObject({ value: "dark", domain: ".orbit.example" });

  // The summary names counts, never a value.
  expect(r.stdout).toContain("orbit.example: 4 cookies imported");
  expect(r.stdout).toContain("1 partitioned/container skipped");
  expect(r.stdout).toContain("1 expired skipped");
  for (const secret of ["sid-not-printed", "sess-not-printed", "ss-not-printed"]) {
    expect(r.stdout + r.stderr, "a cookie value was printed").not.toContain(secret);
  }
});

test.skipIf(!HAVE_PY)("--no-subdomains takes only the exact host's cookies, and --align-ua sets the UA", async () => {
  stub.calls.length = 0;
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", profile,
    "--domain", "www.orbit.example", "--no-subdomains", "--align-ua"]);
  expect(r.code, r.stderr).toBe(0);
  const names = stub.calls.filter((c) => c.op === "cookies").map((c) => (c.body.set as { name: string }).name);
  // The .orbit.example domain cookies are a different host, excluded now.
  expect(names.sort()).toEqual(["__Host-orbit_sid", "orbit_sess"]);
  const ua = stub.calls.find((c) => c.op === "emulate")?.body.userAgent as string;
  expect(ua).toContain("Firefox/");
});

test.skipIf(!HAVE_PY)("a domain with no cookies says so and fails, without touching the browser", async () => {
  stub.calls.length = 0;
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", profile, "--domain", "nothing.example"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no live cookies for nothing.example");
  expect(stub.calls.filter((c) => c.op === "cookies")).toHaveLength(0);
});

/** A profile with NextGen localStorage for one origin: a plain key, a UTF-16
 *  key, and a snappy-compressed one (compression_type 1) that must be skipped
 *  rather than written as garbage. */
function withLocalStorage(dir: string, originDir: string): void {
  const lsDir = join(dir, "storage", "default", originDir, "ls");
  mkdirSync(lsDir, { recursive: true });
  const db = new Database(join(lsDir, "data.sqlite"));
  db.run(`CREATE TABLE data (key TEXT PRIMARY KEY, utf16_length INTEGER, conversion_type INTEGER,
    compression_type INTEGER, last_access_time INTEGER, value BLOB)`);
  db.run("INSERT INTO data (key, conversion_type, compression_type, value) VALUES (?, 1, 0, ?)", ["orbit_device_key", "dev-not-printed"]);
  db.run("INSERT INTO data (key, conversion_type, compression_type, value) VALUES (?, 0, 0, ?)",
    ["greeting", Buffer.from("hola", "utf-16le")]);
  db.run("INSERT INTO data (key, conversion_type, compression_type, value) VALUES (?, 1, 1, ?)", ["big", Buffer.from([0x01, 0x02, 0x03])]);
  db.close();
}

test.skipIf(!HAVE_PY)("localStorage for the origin the tab is on is written; a compressed value is skipped, another origin is deferred", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-ffls-"));
  fakeProfile(dir);
  withLocalStorage(dir, "https+++www.orbit.example");
  withLocalStorage(dir, "https+++app.orbit.example");
  const s = startBrowserStub((op, body) => {
    if (op === "eval" && body.js === "location.origin") return { ok: true, value: { value: "https://www.orbit.example" } };
    return { ok: true, value: {} };
  });
  try {
    const r = await runCli(s.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", dir, "--domain", "orbit.example"]);
    expect(r.code, r.stderr).toBe(0);
    // The origin the tab is on: its keys written, the compressed one left out.
    const sets = s.calls.filter((c) => c.op === "storage" && c.body.set === true);
    expect(Object.fromEntries(sets.map((c) => [c.body.key, c.body.value])))
      .toEqual({ orbit_device_key: "dev-not-printed", greeting: "hola" });
    expect(sets.every((c) => c.body.where === "local")).toBe(true);
    expect(r.stdout).toContain("2 localStorage keys");
    expect(r.stdout).toContain("compressed localStorage skipped");
    // The other origin cannot be written from this tab, and is named for a second pass.
    expect(r.stderr).toContain("https://app.orbit.example");
    // A value never printed.
    expect(r.stdout + r.stderr).not.toContain("dev-not-printed");
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!HAVE_PY)("no imported value reaches the audit log, a stored one included", async () => {
  /*
   * The stored values used to travel inside an `eval` script, and `eval` has
   * no value position the audit can blank: an opaque token that is not
   * token-SHAPED went into the log verbatim. Every call the import makes is
   * put through the audit's own redaction here, not only its stdout.
   */
  const dir = mkdtempSync(join(tmpdir(), "agx-ffls-"));
  fakeProfile(dir);
  withLocalStorage(dir, "https+++www.orbit.example");
  const s = startBrowserStub((op, body) => {
    if (op === "eval" && body.js === "location.origin") return { ok: true, value: { value: "https://www.orbit.example" } };
    return { ok: true, value: {} };
  });
  try {
    const r = await runCli(s.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", dir, "--domain", "orbit.example"]);
    expect(r.code, r.stderr).toBe(0);
    expect(s.calls.some((c) => c.op === "storage")).toBe(true);
    const log = audited(s.calls);
    for (const value of ["sid-not-printed", "sess-not-printed", "ss-not-printed", "dev-not-printed", "hola"]) {
      expect(log, `${value} reached the audit log`).not.toContain(value);
    }
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!HAVE_PY)("session load writes storage through the same redacted path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-sessload-"));
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({
    cookies: [{ name: "orbit_sid", value: "cookie-not-in-audit", domain: ".orbit.example", path: "/", secure: true }],
    origins: [{
      origin: "https://www.orbit.example",
      localStorage: [{ name: "orbit_device_key", value: "local-not-in-audit" }],
      sessionStorage: [{ name: "orbit_tab", value: "session-not-in-audit" }],
    }],
  }));
  const s = startBrowserStub(() => ({ ok: true, value: {} }));
  try {
    const r = await runCli(s.url, ["--page", "tab-1", "session", "load", file]);
    expect(r.code, r.stderr).toBe(0);
    const sets = s.calls.filter((c) => c.op === "storage").map((c) => [c.body.where, c.body.key, c.body.value]);
    expect(sets).toEqual([["local", "orbit_device_key", "local-not-in-audit"], ["session", "orbit_tab", "session-not-in-audit"]]);
    const log = audited(s.calls);
    for (const value of ["cookie-not-in-audit", "local-not-in-audit", "session-not-in-audit"]) {
      expect(log, `${value} reached the audit log`).not.toContain(value);
    }
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!HAVE_PY)("an unknown source is refused by name", async () => {
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "chrome-profile", profile, "--domain", "orbit.example"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("firefox-profile");
});

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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsk, redactAskForTest, type BrowserOp } from "../src/browserdrive.ts";
import { startBrowserStub, runCli, runMcpTool } from "./fixtures/browser-stub.ts";

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

test.skipIf(!HAVE_PY)("the MCP's set_storage_state writes storage through the same redacted path", async () => {
  /*
   * The MCP twin of `session load` is a second door to the same write, and it
   * was built beside the fix above rather than on it: one `eval` script per
   * origin, every value inside it, so the audit kept them word for word. The
   * lock covers both clients, and the origin check that stays an `eval` must
   * carry no value at all.
   */
  const dir = mkdtempSync(join(tmpdir(), "agx-mcpload-"));
  const s = startBrowserStub((op, body) => {
    if (op === "eval" && body.js === "location.origin") return { ok: true, value: { value: "https://www.orbit.example" } };
    // What the old one-script write answered, so the leak is what fails, not the count.
    if (op === "eval") return { ok: true, value: { value: { written: true, at: "https://www.orbit.example" } } };
    return { ok: true, value: {} };
  });
  try {
    const state = {
      cookies: [{ name: "orbit_sid", value: "cookie-not-in-audit", domain: ".orbit.example", path: "/", secure: true }],
      origins: [{
        origin: "https://www.orbit.example",
        localStorage: [{ name: "orbit_device_key", value: "local-not-in-audit" }],
        sessionStorage: [{ name: "orbit_tab", value: "session-not-in-audit" }],
      }],
    };
    const r = await runMcpTool(s.url, dir, "browser_set_storage_state", { page: "tab-1", state });
    expect(r?.isError, JSON.stringify(r)).toBeFalsy();
    expect(r!.content[0]!.text).toContain("1 localStorage keys, 1 sessionStorage keys");
    const log = audited(s.calls);
    for (const value of ["cookie-not-in-audit", "local-not-in-audit", "session-not-in-audit"]) {
      expect(log, `${value} reached the audit log`).not.toContain(value);
    }
    const sets = s.calls.filter((c) => c.op === "storage").map((c) => [c.body.where, c.body.key, c.body.value, c.body.page]);
    expect(sets).toEqual([["local", "orbit_device_key", "local-not-in-audit", "tab-1"], ["session", "orbit_tab", "session-not-in-audit", "tab-1"]]);
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!HAVE_PY)("an unknown source is refused by name", async () => {
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "chrome-profile", profile, "--domain", "orbit.example"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("firefox-profile");
});

test.skipIf(!HAVE_PY)("--domain must name one site: a top-level domain, a public suffix or a URL is refused before the profile is read", async () => {
  /*
   * The matcher takes subdomains by default, so `--domain com` matched every
   * .com login in the profile and copied all of them, cookies and storage —
   * the opposite of bringing one login over. A URL matched nothing, silently.
   * The profile path does not exist: a refusal that came after reading it
   * would say "could not read" and exit 1.
   */
  const missing = join(tmpdir(), "agx-no-such-profile");
  for (const [domain, says] of [
    ["com", "top-level"], [".com", "top-level"], ["co.uk", "public suffix"], ["github.io", "public suffix"],
    ["https://www.orbit.example/", "bare site name"], ["orbit.example:8443", "bare site name"],
    ["*.orbit.example", "bare site name"], ["orbit.example?x", "bare site name"],
  ] as const) {
    stub.calls.length = 0;
    const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", missing, "--domain", domain]);
    expect(r.code, `${domain}: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain(says);
    expect(stub.calls, `${domain} reached the browser`).toHaveLength(0);
  }
  // A site under a public suffix is a site, localhost is one too, and so is a
  // single-label host when only that exact host is asked for.
  for (const args of [["acme.co.uk"], ["localhost"], ["intranet", "--no-subdomains"]]) {
    const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", profile, "--domain", ...args]);
    expect(r.stderr).toContain(`no live cookies for ${args[0]}`);
  }
});

test.skipIf(!HAVE_PY)("--domain is matched the way it is meant, not the way it was typed", async () => {
  /* A stray space, a trailing dot or capitals passed the check and then
     matched nothing, which is the silent miss the check is there to stop. */
  stub.calls.length = 0;
  const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", profile,
    "--domain", " ORBIT.example. "]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("orbit.example: 4 cookies imported");
});

test("the CLI's public suffixes include every one the picker groups by", async () => {
  /* Two lists in two languages: the Python CLI cannot import the TypeScript
     one, so this keeps the copy from drifting behind the original. */
  const ts = await Bun.file(join(import.meta.dir, "../src/cookieimport.ts")).text();
  const py = await Bun.file(join(import.meta.dir, "../../bin/agentglass-browser")).text();
  const tsBlock = ts.match(/const TWO_LABEL_SUFFIXES = new Set\(\[([^\]]*)\]\)/);
  const pyBlock = py.match(/_PUBLIC_SUFFIXES = frozenset\(\{([^}]*)\}\)/);
  expect(tsBlock).not.toBeNull();
  expect(pyBlock).not.toBeNull();
  const names = (s: string) => [...s.matchAll(/"([a-z.]+)"/g)].map((m) => m[1]);
  const inPy = new Set(names(pyBlock![1]!));
  expect(names(tsBlock![1]!).length).toBeGreaterThan(10);
  for (const suffix of names(tsBlock![1]!)) expect(inPy.has(suffix), suffix).toBe(true);
});

test.skipIf(!HAVE_PY)("the private copy of the profile is gone afterwards, when the import worked and when the copy failed", async () => {
  /* The copy holds every cookie value in the profile. A copy that raised
     halfway left its directory behind, because the caller's cleanup only
     starts once the copy has returned. A directory where cookies.sqlite
     should be makes the copy fail the same way on any machine, root included. */
  const tmp = mkdtempSync(join(tmpdir(), "agx-importtmp-"));
  const broken = mkdtempSync(join(tmpdir(), "agx-ffbroken-"));
  mkdirSync(join(broken, "cookies.sqlite"));
  const left = () => readdirSync(tmp).filter((n) => n.startsWith("agx-import-"));
  try {
    const ok = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", profile,
      "--domain", "orbit.example"], { TMPDIR: tmp });
    expect(ok.code, ok.stderr).toBe(0);
    expect(left()).toEqual([]);
    const failed = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", broken,
      "--domain", "orbit.example"], { TMPDIR: tmp });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("could not read");
    expect(left()).toEqual([]);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(broken, { recursive: true, force: true }); }
});

test.skipIf(!HAVE_PY)("a stored key the tab refuses is named, the rest still land, and the counts say what did", async () => {
  /* Storage goes one key per call now, so a refusal is per key: it must not
     silently drop every key after it, and the summary must not count a key
     that never landed. A non-string value is written as the browser's own
     setItem would have made it a string, not refused. */
  const dir = mkdtempSync(join(tmpdir(), "agx-sessload-"));
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({
    cookies: [],
    origins: [{
      origin: "https://www.orbit.example",
      localStorage: [{ name: "refused", value: "a" }, { name: "count", value: 42 }, { name: "after", value: "b" }],
      sessionStorage: [{ name: "tab", value: "c" }],
    }],
  }));
  const s = startBrowserStub((op, body) =>
    op === "storage" && body.key === "refused" ? { ok: false, error: "the page refused that write" } : { ok: true, value: {} });
  try {
    const r = await runCli(s.url, ["--page", "tab-1", "session", "load", file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refused: the page refused that write");
    const sets = s.calls.filter((c) => c.op === "storage").map((c) => [c.body.key, c.body.value]);
    expect(sets).toEqual([["refused", "a"], ["count", "42"], ["after", "b"], ["tab", "c"]]);
    expect(r.stdout).toContain("2 localStorage keys, 1 sessionStorage keys restored");
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!HAVE_PY)("an origin whose localStorage cannot be read is named and skipped, not a traceback after the cookies landed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-ffls-"));
  fakeProfile(dir);
  // A directory where the database should be: the copy fails on any machine.
  mkdirSync(join(dir, "storage", "default", "https+++www.orbit.example", "ls", "data.sqlite"), { recursive: true });
  try {
    const r = await runCli(stub.url, ["--page", "tab-1", "session", "import", "--from", "firefox-profile", dir, "--domain", "orbit.example"]);
    expect(r.stderr).not.toContain("Traceback");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("orbit.example: 4 cookies imported");
    expect(r.stderr).toContain("localStorage for https://www.orbit.example: could not read");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

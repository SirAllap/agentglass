/*
 * The answer has to survive the pipe, not just the terminal.
 *
 * Reported from the app: "the cookie reader did not answer: its answer was
 * 219264 bytes and did not parse". Run by hand with the output redirected to a
 * file, the same command produced 360,266 bytes of valid JSON. The difference
 * is the destination: a write to a file is synchronous, a write to a PIPE is
 * queued — and `cookieentry.ts` calls `process.exit()` the moment the reader
 * returns, which discards whatever is still queued.
 *
 * So this test exists to use a pipe. A test that captured stdout any other way
 * would pass while the app was broken, which is exactly what happened for as
 * long as this had two hundred sites' worth of cookies to say.
 *
 * The fixture is a real Firefox-shaped cookies.sqlite with enough rows to
 * overflow a pipe buffer, because the bug does not appear below 64 KiB.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agx-cookiepipe-"));
const profile = join(home, ".mozilla", "firefox", "abcd1234.default-release");
const SITES = Array.from({ length: 120 }, (_, i) => `site${i}.test`);

beforeAll(() => {
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(home, ".mozilla", "firefox", "profiles.ini"),
    "[Profile0]\nName=default-release\nIsRelative=1\nPath=abcd1234.default-release\nDefault=1\n",
  );
  const db = new Database(join(profile, "cookies.sqlite"));
  // `originAttributes` too: the reader selects it, and a fixture missing a
  // column fails as "no such column" rather than as the thing under test.
  db.exec(`CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY, host TEXT, name TEXT, value TEXT, path TEXT,
    expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER,
    originAttributes TEXT NOT NULL DEFAULT ''
  )`);
  const put = db.query(
    "INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?,?,?,?,?,?,?,?)",
  );
  // Big values on purpose: a session cookie is routinely a kilobyte, and the
  // failure needs the total to be well past a pipe buffer.
  const value = "v".repeat(1400);
  const expiry = Math.floor(Date.now() / 1000) + 86_400;
  const tx = db.transaction(() => {
    for (const site of SITES) {
      for (let n = 0; n < 3; n++) {
        put.run(`.${site}`, `c${n}`, `${value}${n}`, "/", expiry, 1, 0, 0);
      }
    }
  });
  tx();
  db.close();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The reader, spawned exactly as the desktop shell spawns it: stdout piped. */
async function readThroughAPipe(args: string[]) {
  const child = Bun.spawn(
    ["bun", "run", new URL("../src/cookieread.ts", import.meta.url).pathname, ...args],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
}

describe("what comes back through a pipe", () => {
  it("finds the profile at all", async () => {
    const out = await readThroughAPipe(["list"]);
    const answer = JSON.parse(out.trim().split("\n").pop() || "");
    expect(answer.ok).toBe(true);
    expect(answer.sources.length).toBeGreaterThan(0);
  });

  it("arrives whole when the answer is bigger than a pipe buffer", async () => {
    const list = JSON.parse((await readThroughAPipe(["list"])).trim().split("\n").pop() || "");
    const id = list.sources[0].id as string;

    const out = await readThroughAPipe(["read", "--source", id, "--sites", SITES.join(",")]);

    // The size is the point. Under 64 KiB this passes whether or not the fix is
    // there, so the fixture is checked as well as the answer.
    expect(out.length).toBeGreaterThan(64 * 1024);

    const line = out.trim().split("\n").pop() || "";
    let answer: { ok: boolean; cookies: unknown[] };
    try {
      answer = JSON.parse(line);
    } catch {
      throw new Error(
        `the answer did not parse: ${out.length} bytes arrived, and the last line ended "…${line.slice(-60)}". `
        + "That is the process exiting before stdout had drained.",
      );
    }
    expect(answer.ok).toBe(true);
    expect(answer.cookies.length).toBe(SITES.length * 3);
  });
});

describe("how the reader writes", () => {
  const src = Bun.file(new URL("../src/cookieread.ts", import.meta.url));

  it("waits for the bytes to leave before it returns", async () => {
    const text = await src.text();
    // The callback form is what makes the write awaitable; without it there is
    // nothing for the exit to wait on.
    expect(text).toMatch(/process\.stdout\.write\(.*=> resolve\(\)\)/);
    // And every caller has to actually wait.
    const unawaited = [...text.matchAll(/(^|[^t] )say\(/gm)].filter((m) => !m[0].includes("await"));
    expect(unawaited.map((m) => m[0])).toEqual([]);
  });
});

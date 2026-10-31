/*
 * A token that heals: agentglass-ui, agentglass-agent and the MCP servers.
 *
 * A pane keeps the AGENTGLASS_TOKEN it was opened with, and reinstalling the
 * app mints a new one, so in a long session every write answered "the server
 * did not accept this token" until somebody opened a new pane. Each of these
 * now asks again ONCE with the token the app wrote to agentglass/token, after
 * a 401 only, and only when that token is not the one just refused.
 *
 * What it must never do is turn a refusal into a yes with a stronger
 * credential: a 403 means the token was accepted and the act refused, and a
 * seat's or a plugin's minted token is narrower than the machine token in the
 * file. Those cases send one request and report it.
 *
 * And agentglass-ui used to answer every 401/403 with that one sentence,
 * which hid the server's own reason ("Go is the person's here: ...").
 *
 * A stand-in server, not the real one: what is under test is which credential
 * each one presents, how many times, and what it says.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;
const CURRENT = "the-token-the-app-has-now";
const STALE = "issued-before-the-reinstall";
const REASON = "Go is the person's here: this project is not in Autopilot";

let home = "", origin = "", server: ReturnType<typeof Bun.serve> | null = null;
/** Every Authorization header presented, in order. */
let presented: (string | null)[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agx-token-retry-"));
  mkdirSync(join(home, "agentglass"), { recursive: true });
  server = Bun.serve({
    port: 0,
    fetch(req) {
      presented.push(req.headers.get("authorization"));
      if (req.headers.get("authorization") !== `Bearer ${CURRENT}`) {
        return Response.json({ ok: false, error: "unauthorized — pass ?token= or Authorization: Bearer" }, { status: 401 });
      }
      // Accepted, and the act refused: the shape of a Go that is the person's.
      if (new URL(req.url).pathname.endsWith("/go")) return Response.json({ ok: false, error: REASON }, { status: 403 });
      return Response.json({ ok: true, plans: [] });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ }
});

const writeToken = (value: string) => writeFileSync(join(home, "agentglass", "token"), value + "\n", { mode: 0o600 });

/** Spawned and awaited, never spawnSync: the stand-in server is this process. */
async function spawn(cmd: string[], env: Record<string, string | undefined>) {
  presented = [];
  const base: Record<string, string | undefined> = { ...process.env, AGENTGLASS_SERVER: origin, XDG_CONFIG_HOME: home };
  delete base.AGENTGLASS_TOKEN;
  delete base.AGENTGLASS_SEAT;
  const p = Bun.spawn(cmd, { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

const ui = (env: Record<string, string | undefined>, ...args: string[]) =>
  spawn(["python3", BIN("agentglass-ui"), "flight-plan", "plan", ...(args.length ? args : ["list"])], env);

/** One GET through a bin's own request path, loaded as a module: (status) or the HTTPError's code. */
function viaModule(bin: string, env: Record<string, string | undefined>) {
  const call = bin === "agentglass-cockpit-mcp"
    ? `print(json.dumps(ns["get"]("/flight-plan/plans")[0]))`
    : `
import urllib.request, urllib.error
try:
    with ns["urlopen_fresh"](urllib.request.Request(${JSON.stringify(origin)} + "/flight-plan/plans"), 5) as r:
        print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
`;
  const src = `
import json, os, sys
p = ${JSON.stringify(BIN(bin))}
ns = {"__name__": "probe", "__file__": p}
exec(compile(open(p).read(), p, "exec"), ns)
${call}`;
  return spawn(["python3", "-c", src], env);
}

describe.if(HAVE_PY)("a token from before the reinstall", () => {
  test("agentglass-ui asks once more with the file's token, and the command works", async () => {
    writeToken(CURRENT);
    const r = await ui({ AGENTGLASS_TOKEN: STALE });
    expect(r.code, r.out + r.err).toBe(0);
    expect(presented).toEqual([`Bearer ${STALE}`, `Bearer ${CURRENT}`]);
  });

  test("a second 401 is reported, after exactly two requests", async () => {
    writeToken("also-from-before");
    const r = await ui({ AGENTGLASS_TOKEN: STALE });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toContain("the server did not accept this token");
    expect(presented).toEqual([`Bearer ${STALE}`, "Bearer also-from-before"]);
  });

  test("no retry when the file holds the token just refused", async () => {
    writeToken(STALE);
    const r = await ui({});
    expect(r.code).toBe(1);
    expect(presented).toEqual([`Bearer ${STALE}`]);
  });

  test("a 403 carries the server's own sentence, and is never retried with another token", async () => {
    writeToken("the-machine-token-on-disk");
    const r = await ui({ AGENTGLASS_TOKEN: CURRENT }, "go", "fp_orbit1");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toBe(REASON);
    expect(presented).toEqual([`Bearer ${CURRENT}`]);
  });

  test("a seat's or a plugin's minted token never falls back to the machine token in the file", async () => {
    writeToken(CURRENT);
    for (const env of [{ AGENTGLASS_TOKEN: "st_seatTokenFromBefore" }, { AGENTGLASS_TOKEN: "pg_pluginToken" }, { AGENTGLASS_TOKEN: STALE, AGENTGLASS_SEAT: "/home/me/code/orbit" }]) {
      const r = await ui(env);
      expect(r.code, JSON.stringify(env)).toBe(1);
      expect(presented, JSON.stringify(env)).toHaveLength(1);
    }
  });

  for (const bin of ["agentglass-agent", "agentglass-browser-mcp", "agentglass-cockpit-mcp"]) {
    test(`${bin}: retried once with the file's token, at most two requests`, async () => {
      writeToken(CURRENT);
      let r = await viaModule(bin, { AGENTGLASS_TOKEN: STALE });
      expect(r.out.trim(), r.err).toBe("200");
      expect(presented).toEqual([`Bearer ${STALE}`, `Bearer ${CURRENT}`]);
      writeToken("also-from-before");
      r = await viaModule(bin, { AGENTGLASS_TOKEN: STALE });
      expect(r.out.trim(), r.err).toBe("401");
      expect(presented).toHaveLength(2);
    });
  }

  test("an MCP server started with no token in its environment takes the file's, on the first request", async () => {
    writeToken(CURRENT);
    for (const bin of ["agentglass-browser-mcp", "agentglass-cockpit-mcp"]) {
      const r = await viaModule(bin, {});
      expect(r.out.trim(), `${bin} ${r.err}`).toBe("200");
      expect(presented).toEqual([`Bearer ${CURRENT}`]);
    }
  });

  test("the three copies of the retry are one text", () => {
    const fn = (bin: string) => {
      const src = readFileSync(BIN(bin), "utf8");
      const start = src.indexOf("def _token_file(");
      const end = src.indexOf("\n\n\n", src.indexOf("def urlopen_fresh("));
      expect(start, bin).toBeGreaterThan(-1);
      return src.slice(start, end);
    };
    const canon = fn("agentglass-ui");
    expect(canon).toContain("e.code != 401");
    expect(fn("agentglass-agent")).toBe(canon);
    expect(fn("agentglass-browser-mcp")).toBe(canon);
  });
});

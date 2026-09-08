#!/usr/bin/env bun
/**
 * Does the sidecar come up, and answer, on THIS operating system?
 *
 * `electron/package.json` has declared an `nsis` target for Windows and a `dmg`
 * for macOS for five releases, and neither has ever been executed — not by CI,
 * not by anyone (#193). What that cost was not the bugs: it was that a dozen
 * of them accumulated invisibly and were found by a person installing the app,
 * which is the most expensive detector there is. Every one was a
 * first-ten-minutes failure of the kind a boot and four requests would have
 * caught: an env var split on the wrong character, a prefix test with a
 * hardcoded `/`, a shell that does not exist there.
 *
 * So this boots the server and asks it four questions. It does not build an
 * installer — that is strictly better and much slower, and this should not wait
 * for it.
 *
 * A bun script rather than shell steps, because the shells differ exactly where
 * the bugs are: `windows-latest` runs PowerShell, `&` does not background,
 * `curl` is an alias for `Invoke-WebRequest`, and `$(seq 1 30)` is nothing at
 * all. A workflow written twice is a workflow where the Windows half rots
 * quietly, which is the failure this file exists to end.
 *
 *   bun scripts/platformsmoke.ts
 */
import { spawn } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "agx-platform-"));
const port = 4870 + Math.floor(Math.random() * 40);
const S = `http://127.0.0.1:${port}`;

const server = spawn({
  cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
  env: {
    ...process.env,
    AGENTGLASS_PORT: String(port),
    AGENTGLASS_DB: join(home, "platform.db"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    AGENTGLASS_STATE_DIR: join(home, "state"),
    AGENTGLASS_TOKEN: "",
    // The transcript sweep reads the operator's own ~/.claude, which is neither
    // this app's doing nor reproducible on a runner.
    AGENTGLASS_SCAN_DISABLED: "1",
    AGENTGLASS_DIE_WITH_PARENT: "1",
  },
  stdout: "inherit",
  stderr: "inherit",
});

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
};

/** A route answers 200 with the JSON shape the panels read. */
async function endpoint(name: string, path: string, shape: (body: any) => string | null) {
  try {
    const r = await fetch(S + path);
    if (r.status !== 200) return record(name, false, `HTTP ${r.status}`);
    const body = await r.json();
    const wrong = shape(body);
    record(name, !wrong, wrong ?? "200, and the shape the panel expects");
  } catch (e) {
    record(name, false, `no answer: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The terminal either works or says it does not — never a crash, never a hang.
 *
 * Two honest answers, one per platform. Where a PTY exists the socket opens and
 * the first control frame is `ready`. On Windows there is no POSIX PTY backend,
 * and the route refuses before the upgrade with `403` and a reason in the body
 * — the same contract one layer earlier, and the shape #98 will change when it
 * lands as ConPTY or as a deliberate disable. What fails this check is a 500, a
 * socket that opens and dies with `fatal`, or silence.
 */
async function terminalContract(): Promise<void> {
  const name = "GET /terminal/pty (the terminal works, or says it does not)";
  let refusal: { status: number; body: string } | null = null;
  try {
    const probe = await fetch(`${S}/terminal/pty`, { headers: { upgrade: "websocket" } });
    if (probe.status === 403) refusal = { status: 403, body: (await probe.text()).slice(0, 200) };
    else if (probe.status >= 500) return record(name, false, `HTTP ${probe.status} — a refusal is fine, a crash is not`);
  } catch { /* an upgrade the fetch client will not follow; the socket below is the real test */ }

  if (refusal) {
    const said = /disabled|not available/i.test(refusal.body);
    return record(name, said, said
      ? `refused cleanly: ${refusal.body}`
      : `403 with no reason a user could act on: ${refusal.body}`);
  }

  await new Promise<void>((done) => {
    const ws = new WebSocket(`${S.replace("http", "ws")}/terminal/pty`);
    const settle = (ok: boolean, detail: string) => {
      clearTimeout(timer);
      record(name, ok, detail);
      try { ws.close(); } catch { /* already gone */ }
      done();
    };
    const timer = setTimeout(() => settle(false, "no frame within 15s — neither working nor saying so"), 15_000);
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      let frame: any;
      try { frame = JSON.parse(raw); } catch { return; } // shell output, not a control frame
      if (frame?.t === "ready") settle(true, `socket opened, shell ${frame.shell ?? "?"} in ${frame.cwd ?? "?"}`);
      else if (frame?.t === "fatal") settle(false, `socket opened then died: ${frame.error}`);
    };
    ws.onerror = () => settle(false, "socket error before any frame");
    ws.onclose = (ev) => { if (ev.code !== 1000) settle(false, `socket closed early (${ev.code} ${ev.reason || "no reason"})`); };
  });
}

let failed = false;
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${S}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await Bun.sleep(500);
  }
  if (!up) {
    console.log(`\n✗ platform: the sidecar never answered /health on ${process.platform} — nothing below could run`);
    process.exit(1);
  }
  record("GET /health", true, `the sidecar boots on ${process.platform}/${process.arch}`);

  await endpoint("GET /stats", "/stats?window=3600000",
    (b) => (b && typeof b === "object" && "totals" in b ? null : "200, but no totals in the body"));
  await endpoint("GET /projects", "/projects",
    (b) => (Array.isArray(b) || (b && typeof b === "object") ? null : "200, but neither a list nor an object"));
  await endpoint("GET /git/repos?all=1", "/git/repos?all=1",
    (b) => (Array.isArray(b) || (b && typeof b === "object") ? null : "200, but neither a list nor an object"));
  await terminalContract();

  failed = results.some((r) => !r.ok);
  console.log(failed
    ? `\n✗ platform: ${results.filter((r) => !r.ok).length} of ${results.length} checks failed on ${process.platform}`
    : `\n✓ platform: ${results.length} checks pass on ${process.platform}/${process.arch}`);
} finally {
  try { server.kill(); } catch { /* already gone */ }
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

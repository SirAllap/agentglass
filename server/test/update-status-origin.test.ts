/*
 * Who may read the build's identity, and how much of it.
 *
 * `/update/status` was gated to the packaged shell's custom scheme, reads and
 * all. The reason was sound — the full answer names the clone on disk, names
 * the remote it pulls from, and carries the tail of the last update log, none
 * of which a phone on the wifi has any business seeing. The cost was not
 * noticed: the About pane is the only place the version is written down, and it
 * asks this endpoint for it. From `bun run dev`, from single-port mode, from a
 * paired phone — every browser there is — the request came back 403 and the
 * pane sat on "Reading version…" forever. An About tab that cannot say what
 * version you are running is the one thing an About tab is for.
 *
 * So the gate redacts rather than refuses: identity for anyone the outer origin
 * gate already let in, provenance and the update button for the desktop shell
 * alone. These tests pin both halves, because widening this by accident is how
 * the install path ends up on a phone screen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

/** Stands in for the developer's home directory in the build record. If this
 *  string reaches a browser, the redaction failed. */
const SECRET_SRC = "/home/somebody/src/agentglass-private";
/** A path, not a URL: `git ls-remote` fails on it instantly, so the desktop
 *  request below never touches the network. */
const FAKE_ORIGIN = "/nonexistent/agentglass.git";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-update-origin-"));
  // buildInfo() prefers a staged build record over asking git, which is what
  // gives this test a known source path and origin to look for.
  mkdirSync(join(dir, "electron", "staging"), { recursive: true });
  // Stamped from a dirty tree on purpose: the identity half of this answer has
  // to reach a phone (it is the only place the build is written down) while the
  // file list — somebody's work in flight — must not.
  writeFileSync(join(dir, "electron", "staging", "build-info.json"), JSON.stringify({
    version: "9.9.9", commit: "c0ffee1234567890", builtAt: "2026-01-01T00:00:00Z",
    source: SECRET_SRC, origin: FAKE_ORIGIN, baseTag: "v9.9.9", distance: 0,
    stamp: "c0ffee1+dirty.abc1234", tree: "a".repeat(64), dirty: true,
    dirtyFiles: ["M web/src/components/SecretFeature.tsx"],
  }));
  // The stamp from a previous run. Its tail is raw script output — paths and
  // all — and it is read from $HOME, which is why HOME is redirected here.
  mkdirSync(join(dir, ".cache", "agentglass"), { recursive: true });
  writeFileSync(join(dir, ".cache", "agentglass", "last-update.json"), JSON.stringify({
    at: "2026-01-02T00:00:00Z", ok: false, tail: `fatal: could not read ${SECRET_SRC}`,
  }));

  const port = 4910 + Math.floor(Math.random() * 20);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir, // so buildInfo() finds the staged record above
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
/** The dev server's origin — and every other browser origin: a page cannot be
 *  served under the packaged shell's scheme, which is the whole point of it. */
const status = (origin: string) =>
  fetch(base + "/update/status", { headers: { Origin: origin } });
const BROWSER = "http://localhost:5173";
const DESKTOP = "agentglass://app";

describe("a browser asking for the version", () => {
  test("is answered, not refused", async () => {
    const r = await status(BROWSER);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Json;
    expect(j.ok).toBe(true);
    // The three lines the About pane puts on screen.
    expect(j.info.version).toBe("9.9.9");
    expect(j.info.commit).toBe("c0ffee1234567890");
    expect(j.info.builtAt).toBe("2026-01-01T00:00:00Z");
  });

  test("is told the build is not a commit, without being told whose work is in it", async () => {
    // `commit` alone is the field that lied: it names a commit whose tree is
    // not what shipped. The stamp is what the About row renders, so it has to
    // cross — a phone reading `c0ffee1` for this build would be told the same
    // untruth the desktop was. The file list is the part that stays home.
    const j = (await status(BROWSER).then((r) => r.json())) as Json;
    expect(j.info.stamp).toBe("c0ffee1+dirty.abc1234");
    expect(j.info.dirty).toBe(true);
    expect(j.info.dirtyCount).toBe(1);
    expect(j.info.dirtyFiles).toEqual([]);
    expect(JSON.stringify(j)).not.toContain("SecretFeature");
  });

  test("is told nothing about where this build lives", async () => {
    const j = (await status(BROWSER).then((r) => r.json())) as Json;
    expect(j.info.source).toBe("");
    expect(j.info.origin).toBe("");
    // The log tail is unstructured script output; it quotes paths verbatim.
    expect(j.last).toBeUndefined();
    // Belt and braces: whatever else the shape grows, the path stays out of it.
    expect(JSON.stringify(j)).not.toContain(SECRET_SRC);
    expect(JSON.stringify(j)).not.toContain(FAKE_ORIGIN);
  });

  test("is not offered an update it could not install anyway", async () => {
    const j = (await status(BROWSER).then((r) => r.json())) as Json;
    expect(j.available).toBe(false);
    expect(j.behind).toBe(0);
    // Says why the button is missing, rather than leaving a blank pane.
    expect(j.blocked).toBeTruthy();
    expect(String(j.blocked)).toMatch(/desktop/i);
  });

  test("can read the notes for the release it is running", async () => {
    // The other half of the pane: About offers a "Release notes" button
    // whenever the build descends from a tag, so refusing this left a browser
    // with a button that could only ever fail. There is no clone and no
    // reachable origin here, so the answer is an honest refusal about the
    // notes — what matters is that it is an answer and not a 403.
    const r = await fetch(base + "/update/notes?tag=v9.9.9", { headers: { Origin: BROWSER } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Json;
    expect(j.tag).toBe("v9.9.9");
    expect(JSON.stringify(j)).not.toContain(SECRET_SRC);
    expect(JSON.stringify(j)).not.toContain(FAKE_ORIGIN);
  });

  test("still cannot start one", async () => {
    // The gate that matters most is untouched: reading is not running.
    const r = await fetch(base + "/update/run", {
      method: "POST", headers: { Origin: BROWSER, "content-type": "application/json" }, body: "{}",
    });
    expect(r.status).toBe(403);
  });
});

describe("the desktop shell asking", () => {
  test("still gets the whole answer", async () => {
    const j = (await status(DESKTOP).then((r) => r.json())) as Json;
    expect(j.info.source).toBe(SECRET_SRC);
    expect(j.info.origin).toBe(FAKE_ORIGIN);
    expect(j.last?.tail).toContain(SECRET_SRC);
  });

  test("including which uncommitted files the running build carries", async () => {
    // The question that had no answer the day an install shipped another
    // session's electron/main.js: whose work is in the app I am looking at.
    const j = (await status(DESKTOP).then((r) => r.json())) as Json;
    expect(j.info.dirtyFiles).toEqual(["M web/src/components/SecretFeature.tsx"]);
    expect(j.info.tree).toHaveLength(64);
  });
});

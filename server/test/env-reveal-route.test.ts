/*
 * The one gate standing between a paired phone and this user's secrets.
 *
 * `/machine/process` lists a process's environment with credential-looking
 * values masked; `/machine/env` hands one back in the clear. The masking is
 * tested at the module level (proc-detail.test.ts). What is NOT testable there
 * is the thing that actually protects it: the reveal route is gated on
 * `desktopOnly` rather than `localOrigin`, so it can only be called from the
 * app's own scheme — not from a phone that paired, not from a browser tab, not
 * from curl.
 *
 * That difference is one identifier in index.ts. Downgrading it to
 * `localOrigin`, which is what every neighbouring route uses, would leave every
 * test in this repo green and quietly publish the user's API keys to anything
 * holding a device credential. Hence a test that speaks HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "env-reveal-route-token";
/** The scheme the packaged app serves its renderer from. Nothing on the web can
 *  be served under it, and a page cannot forge an Origin header. */
const DESKTOP = "agentglass://app";

let dir = "", base = "", ownPort = 0, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-envroute-"));
  const port = await freePort();
  ownPort = port;
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // Named, never `...process.env`: this server must not read the developer's
    // real config — and in this suite especially, must not inherit their real
    // secrets into the process whose environment we are about to read back.
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
      AGENTGLASS_DB: join(dir, "env.db"),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // The bait. A name that trips the key pattern, so the masking has
      // something of ours to prove itself on.
      AGX_TEST_API_KEY: "not-a-real-secret-but-shaped-like-one",
      AGX_TEST_PLAIN: "0.0.0.0",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const auth = { authorization: `Bearer ${TOKEN}` };
/**
 * The test server's own pid.
 *
 * Found by its PORT, not by "the first one that is mine" — which is what this
 * did first, and `mine` is true of every port the developer running the suite
 * happens to have open. It picked their real agentglass on :4000, revealed
 * against the wrong process, and failed with "no such variable" while looking
 * exactly like a broken gate.
 */
const selfPid = async (): Promise<number> => {
  const r = await fetch(`${base}/machine/ports`, { headers: auth });
  const d = await r.json() as { ports: { pid: number | null; mine: boolean; port: number }[] };
  const own = d.ports.find((p) => p.port === ownPort && p.pid);
  expect(own, `the test server should be listening on :${ownPort}`).toBeDefined();
  return own!.pid!;
};

describe("reading a process", () => {
  test("the environment comes back with secrets masked and names intact", async () => {
    const pid = await selfPid();
    const r = await fetch(`${base}/machine/process?pid=${pid}`, { headers: auth });
    const d = await r.json() as { env: { key: string; value: string | null; masked: boolean }[] };

    const secret = d.env.find((v) => v.key === "AGX_TEST_API_KEY");
    expect(secret, "the key is listed even when the value is not").toBeDefined();
    expect(secret!.masked).toBe(true);
    expect(secret!.value).toBeNull();

    // And the whole point of masking rather than hiding: the variable that
    // explains the process stays readable.
    const plain = d.env.find((v) => v.key === "AGX_TEST_PLAIN");
    expect(plain!.masked).toBe(false);
    expect(plain!.value).toBe("0.0.0.0");
  });

  test("no masked value appears anywhere in the response body", async () => {
    // Belt and braces against a future field that helpfully includes the raw
    // environment somewhere else in the payload.
    const pid = await selfPid();
    const body = await (await fetch(`${base}/machine/process?pid=${pid}`, { headers: auth })).text();
    expect(body).not.toContain("not-a-real-secret-but-shaped-like-one");
  });
});

describe("revealing one", () => {
  const reveal = (origin: string | null, key = "AGX_TEST_API_KEY") =>
    selfPid().then((pid) => fetch(`${base}/machine/env`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ pid, key }),
    }));

  test("the desktop shell gets the value", async () => {
    const r = await reveal(DESKTOP);
    expect(r.status).toBe(200);
    expect((await r.json() as { value?: string }).value).toBe("not-a-real-secret-but-shaped-like-one");
  });

  test("a browser on loopback is refused", async () => {
    // The distinction that matters. This origin passes `localOrigin`, which is
    // what every neighbouring route accepts — and this route must not.
    const r = await reveal("http://127.0.0.1:1234");
    expect(r.status).not.toBe(200);
  });

  test("a paired device's own origin is refused", async () => {
    // A phone reaches this over the LAN or a tailnet. It holds a real
    // credential and is allowed to read the panel; it is not allowed to
    // decrypt what the panel deliberately hid.
    const r = await reveal("http://192.168.1.10:4000");
    expect(r.status).not.toBe(200);
  });

  test("no origin at all is refused", async () => {
    // curl, a script, anything that is not a browser. `localOrigin` trusts a
    // missing Origin because only a browser sends one; `desktopOnly` does not,
    // and that is correct here — there is no non-browser caller of this route.
    const r = await reveal(null);
    expect(r.status).not.toBe(200);
  });

  test("a refused call returns nothing that looks like the value", async () => {
    const body = await (await reveal("http://127.0.0.1:1234")).text();
    expect(body).not.toContain("not-a-real-secret-but-shaped-like-one");
  });
});

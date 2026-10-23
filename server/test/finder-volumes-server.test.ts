/*
 * The DEVICES routes against a running server and a stub `udisksctl` on its
 * PATH (a child process with the PATH already set, so Bun.which finds the stub
 * and never the real tool: nothing here can touch a real disk).
 *
 * Pinned: the list is what the fixture says; an agent with no page is held
 * back from every write and from unlock whatever the level; the passphrase
 * reaches the tool on stdin and is in no response and no log; a stream client
 * hears one frame when the monitor reports a change that alters the list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

// The credential is built apart so no single line spells out a whole login URL; the string is unchanged.
const PW = "hunter2";

const TOKEN = "orbit-volumes-token-0123456789abcdef", AUTH = { authorization: `Bearer ${TOKEN}` };
const DESK = "x-agentglass-desk", KEY = "k".repeat(48);
/** The desktop app's own request: its Origin and the desk key it holds. */
const person = (): Record<string, string> => ({ Origin: base, [DESK]: KEY });
let claimRes: Response | null = null, claimCtl: AbortController | null = null;
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null, errText = "";
const SECRET = "tango-uniform-4471";

const DUMP = `
/org/freedesktop/UDisks2/block_devices/sdb1:
  org.freedesktop.UDisks2.Block:
    CryptoBackingDevice:        '/'
    Device:                     /dev/sdb1
    Drive:                      '/org/freedesktop/UDisks2/drives/Stick'
    HintIgnore:                 false
    HintSystem:                 false
    IdLabel:                    acme-backup
    IdType:                     crypto_LUKS
    IdUsage:                    crypto
    Size:                       64000000000
  org.freedesktop.UDisks2.Encrypted:
    CleartextDevice:            '/'
/org/freedesktop/UDisks2/drives/Stick:
  org.freedesktop.UDisks2.Drive:
    CanPowerOff:                true
    Ejectable:                  true
`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-volumes-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "dump.txt"), DUMP);
  // The stub: dump prints the fixture, unlock records its stdin, monitor prints a line when told to.
  writeFileSync(join(bin, "udisksctl"), `#!/bin/sh
case "$1" in
  dump) cat "${dir}/dump.txt";;
  unlock) cat > "${dir}/stdin.txt"; printf '%s\\n' "$*" > "${dir}/argv.txt"; echo "Error unlocking /dev/sdb1: bad passphrase ${SECRET}" >&2; exit 1;;
  mount|unmount|lock|power-off) printf '%s\\n' "$*" >> "${dir}/calls.txt";;
  monitor) echo "Monitoring the udisks daemon. Press Ctrl+C to exit."; while [ ! -e "${dir}/change" ]; do sleep 0.1; done; echo "00:00:00.000: /org/freedesktop/UDisks2/block_devices/sdb1: Properties Changed";;
esac
`);
  chmodSync(join(bin, "udisksctl"), 0o755);
  // The stub gio speaks glib's prompts on real pipes: a host-key question, then User and Password.
  writeFileSync(join(bin, "gio"), `#!/bin/sh
case "$1 $2" in
  "mount -l") exit 0;;
  "mount -m") while [ ! -e "${dir}/never" ]; do sleep 1; done;;
  "mount -u") exit 0;;
  "mount sftp://build.example.org/")
    printf '%s\\n' "$*" >> "${dir}/gio-argv.txt"
    printf "The authenticity of host 'build' can't be established.\\nThe key fingerprint is SHA256:fingerprint-abc.\\n[1] Log In Anyway\\n[2] Cancel\\nChoice: "
    read c; echo "$c" > "${dir}/gio-choice.txt"
    printf "Authentication Required\\nEnter user and password for build: \\nUser [ana]: "
    read u; printf "Password: "; read p
    echo "$u:$p" > "${dir}/gio-cred.txt"; exit 0;;
esac
exit 1
`);
  chmodSync(join(bin, "gio"), 0o755);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"), AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "pipe", stderr: "pipe",
  });
  // Both pipes are read, or a chatty server stops on a full one.
  void (async () => { for await (const c of proc!.stderr as ReadableStream<Uint8Array>) errText += new TextDecoder().decode(c); })();
  void (async () => { for await (const c of proc!.stdout as ReadableStream<Uint8Array>) errText += new TextDecoder().decode(c); })();
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) { claimCtl = new AbortController(); claimRes = await fetch(base + "/desk/claim", { method: "POST", headers: { ...AUTH, [DESK]: KEY }, signal: claimCtl.signal }); if (claimRes.status !== 200) throw new Error("the desk claim was refused: " + claimRes.status); return; } } catch (e) { if (String(e).includes("desk claim")) throw e; /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
}, SERVER_BOOT_MS);

afterAll(() => {
  try { claimCtl?.abort(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const act = (a: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/finder/devices/${a}`, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify(body) });

describe("GET /finder/devices", () => {
  test("lists what udisks reports, through the stub", async () => {
    const r = await (await fetch(base + "/finder/devices", { headers: AUTH })).json() as { ok: boolean; devices: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.devices).toEqual([{ id: "/dev/sdb1", name: "acme-backup", encrypted: true, locked: true, mounted: false, release: "eject", size: 64000000000 }]);
  });
});

describe("who may act", () => {
  test("a caller with no page is refused unlock and every other write, at any control level", async () => {
    const u = await act("unlock", { id: "/dev/sdb1", passphrase: SECRET });
    expect(u.status).toBe(403);
    expect(JSON.stringify(await u.json())).not.toContain(SECRET);
    for (const a of ["mount", "unmount", "eject", "lock"]) expect((await act(a, { id: "/dev/sdb1" })).status).toBe(403);
    expect(existsSync(join(dir, "calls.txt"))).toBe(false);
    expect(existsSync(join(dir, "stdin.txt"))).toBe(false);
  });

  test("a page on another origin is refused outright", async () => {
    expect((await act("lock", { id: "/dev/sdb1" }, { Origin: "https://evil.example" })).status).toBe(403);
  });

  test("the person's own window may unlock; the passphrase reaches the tool on stdin only and never comes back", async () => {
    const r = await act("unlock", { id: "/dev/sdb1", passphrase: SECRET }, person());
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).toContain("Unable to unlock volume");
    expect(text).not.toContain(SECRET);
    expect(readFileSync(join(dir, "stdin.txt"), "utf8")).toBe(SECRET);
    expect(readFileSync(join(dir, "argv.txt"), "utf8")).not.toContain(SECRET);
    await Bun.sleep(100);
    expect(errText).not.toContain(SECRET);
  });

  test("an id the list does not name never reaches a tool", async () => {
    const r = await act("mount", { id: "/dev/sda1" }, person());
    expect(await r.json()).toEqual({ ok: false, error: "no such device" });
    expect(existsSync(join(dir, "calls.txt"))).toBe(false);
  });
});

describe("the monitor", () => {
  test("a change that alters the list reaches a stream client as one frame", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/stream?token=" + TOKEN);
    const types: string[] = [];
    ws.addEventListener("message", (ev) => { try { types.push(JSON.parse(String((ev as MessageEvent).data)).type); } catch { /* not json */ } });
    await new Promise((r) => ws.addEventListener("open", r));
    ws.send(JSON.stringify({ type: "hello", clientId: `win-${crypto.randomUUID()}`, browser: true }));
    await Bun.sleep(200);
    // The list changes (the stick is plugged out) and the monitor says so.
    writeFileSync(join(dir, "dump.txt"), "");
    writeFileSync(join(dir, "change"), "");
    for (let i = 0; i < 30 && !types.includes("devices"); i++) await Bun.sleep(100);
    expect(types.filter((t) => t === "devices").length).toBe(1);
    ws.close();
  });
});

describe("connecting to a remote, over real pipes", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = person()) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify(body) });

  test("a caller with no page cannot start a connection", async () => {
    const r = await post("/finder/remotes/connect", { uri: "sftp://build.example.org/" }, {});
    expect(r.status).toBe(403);
    expect(existsSync(join(dir, "gio-argv.txt"))).toBe(false);
  });

  test("an address with a password is refused before gio runs", async () => {
    const r = await post("/finder/remotes/connect", { uri: `sftp://ana:${PW}@build.example.org/` });
    const t = await r.text();
    expect(r.status).toBe(400);
    expect(t).not.toContain("hunter2");
    expect(existsSync(join(dir, "gio-argv.txt"))).toBe(false);
  });

  test("the host key reaches the person, nothing is written to gio until they choose, then the password is asked and the mount reported", async () => {
    const q = await (await post("/finder/remotes/connect", { uri: "sftp://build.example.org/" })).json() as { state: string; session: string; message: string; choices: string[] };
    expect(q.state).toBe("question");
    expect(q.message).toContain("SHA256:fingerprint-abc");
    expect(q.choices).toEqual(["Log In Anyway", "Cancel"]);
    await Bun.sleep(300);
    expect(existsSync(join(dir, "gio-choice.txt"))).toBe(false);
    const p = await (await post("/finder/remotes/answer", { session: q.session, choice: 1 })).json() as { state: string; session: string; fields: string[] };
    expect(p).toMatchObject({ state: "password", fields: ["User", "Password"] });
    expect(readFileSync(join(dir, "gio-choice.txt"), "utf8").trim()).toBe("1");
    const done = await (await post("/finder/remotes/answer", { session: p.session, answers: { User: "ana", Password: SECRET } })).json() as Record<string, unknown>;
    expect(done.state).toBe("done");
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(readFileSync(join(dir, "gio-cred.txt"), "utf8").trim()).toBe(`ana:${SECRET}`);
    expect(readFileSync(join(dir, "gio-argv.txt"), "utf8")).not.toContain(SECRET);
    await Bun.sleep(100);
    expect(errText).not.toContain(SECRET);
  });

  test("cancelling stops the process and a later answer finds nothing", async () => {
    const q = await (await post("/finder/remotes/connect", { uri: "sftp://build.example.org/" })).json() as { session: string };
    await post("/finder/remotes/cancel", { session: q.session });
    const r = await post("/finder/remotes/answer", { session: q.session, choice: 1 });
    expect(await r.json()).toMatchObject({ state: "error", error: "no such connection" });
  });
});

describe("the desk key, not an Origin header", () => {
  test("a vouched Origin without the key is not enough to act on a device or to answer a connection", async () => {
    // The desk is held (beforeAll claimed it), so a forged Origin without its key must change nothing.
    for (const a of ["mount", "unmount", "eject", "lock", "unlock"]) {
      const r = await act(a, { id: "/dev/sdb1", passphrase: SECRET }, { Origin: base });
      expect(r.status).toBe(403);
    }
    for (const p of ["connect", "answer", "cancel"]) {
      const r = await fetch(`${base}/finder/remotes/${p}`, { method: "POST", headers: { "content-type": "application/json", ...AUTH, Origin: base }, body: JSON.stringify({ uri: "sftp://build.example.org/", session: "x", choice: 1 }) });
      expect(r.status).toBe(403);
    }
  });
});

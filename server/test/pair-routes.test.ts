/*
 * Pairing a phone, over HTTP, against a real server with the token gate live.
 *
 * The unit tests pin the protocol; this pins the thing the protocol is for —
 * that at the end of it a device holds a credential the server accepts, that
 * the credential is bounded by what was granted, and that forgetting the device
 * ends it. Driven end to end because the interesting failures are at the joins:
 * an exemption that does not cover a step, a scope checked in the wrong place,
 * a credential that arrives but is not accepted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createECDH, hkdfSync, createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFO } from "../src/pairing.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

/** The phone: a keypair that never leaves this closure, and the unwrap. */
function phone() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return {
    pub: e.getPublicKey().toString("base64url"),
    open(w: { pub: string; iv: string; data: string }, ticket: string): string {
      const shared = e.computeSecret(Buffer.from(w.pub, "base64url"));
      const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(ticket, "utf8"), Buffer.from(INFO, "utf8"), 32));
      const body = Buffer.from(w.data, "base64url");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(w.iv, "base64url"));
      d.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-pairsrv-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, never `...process.env`: `bun test` shares one
    // process across files, so the parent's environment is whatever every
    // suite before this one happened to leave on it.
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // The whole point: the gate has to be live, or every request below passes
      // for the wrong reason.
      AGENTGLASS_TOKEN: TOKEN,
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

/** Every answer below is JSON this file already knows the shape of; the point
 *  of each assertion is the value, not the parse. */
type Json = Record<string, any>;
const jsonOf = (r: Response): Promise<Json> => r.json() as Promise<Json>;

const post = (path: string, body: unknown, token?: string, origin?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });

/* The Origin the desktop renderer sends, which /pair/accept now requires.
 *
 * Accepting a device is the human half of pairing, and a bare machine token is
 * not proof of one: the token file is readable by anything running as the user,
 * so an agent could otherwise ask for a ticket, accept its own ticket, and mint
 * a device with any label — then release its own held call through the device
 * branch, with the audit line reading as a phone somebody had approved.
 * These tests are the desk, so they send what the desk sends. */
const DESK = "agentglass://app";
const get = (path: string, token?: string) =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** Machine ▸ invite, phone ▸ claim, machine ▸ accept, phone ▸ collect. */
async function pair(scope: "read" | "answer" | "full", label = "iPhone") {
  const p = phone();
  const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
  const claimed = await jsonOf(await post("/pair/claim", { ticket: t.id, code: t.code, label, pub: p.pub }));
  expect(claimed.ok).toBe(true);
  const acc = await jsonOf(await post("/pair/accept", { ticket: t.id, scope }, TOKEN, DESK));
  expect(acc.ok).toBe(true);
  const got = await jsonOf(await get(`/pair/collect?ticket=${t.id}&secret=${encodeURIComponent(claimed.secret)}`));
  expect(got.state).toBe("accepted");
  return { token: p.open(got.wrapped, t.id), ticket: t, deviceId: acc.device.id as string };
}

describe("starting an invitation", () => {
  test("needs the machine's own credential — a paired phone cannot invite another", () => {
    // Otherwise the first device through the door can quietly add the rest,
    // and the confirmation step that makes this safe happens somewhere nobody
    // at the machine is looking.
    return post("/pair/ticket", {}).then(async (r) => {
      expect(r.status).toBe(403);
      expect((await jsonOf(r)).ok).toBe(false);
    });
  });

  test("the code and the ticket are different things", async () => {
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
    expect(t.ok).toBe(true);
    expect(t.code).toMatch(/^[0-9]{6}$/);
    expect(t.id).not.toContain(t.code);
  });
});

describe("the phone's side, with no credential at all", () => {
  test("can ask whether an invitation is open, and be told when it is not", async () => {
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
    expect((await jsonOf(await get(`/pair/info?ticket=${t.id}`))).ok).toBe(true);
    expect((await jsonOf(await get("/pair/info?ticket=made-up"))).ok).toBe(false);
  });

  test("a wrong code is refused and counts against the five", async () => {
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
    const wrong = t.code === "000000" ? "111111" : "000000";
    const r = await post("/pair/claim", { ticket: t.id, code: wrong, label: "x", pub: phone().pub });
    expect(r.status).toBe(401);
    const j = await jsonOf(r);
    expect(j.ok).toBe(false);
    expect(j.left).toBe(4);
    expect(j.error).toContain("4 tries left");
  });

  test("everything else about the surface is still shut to it", async () => {
    // The exemption is the pairing prefix and nothing more. If it leaked, a
    // device would not need to pair at all.
    for (const path of ["/sessions", "/gate/pending", "/remote/status"]) {
      expect((await get(path)).status, path).toBe(401);
    }
  });
});

describe("what a paired phone can do", () => {
  test("an answering phone reads, decides gates, and cannot merge or open a shell", async () => {
    const { token } = await pair("answer", "iPhone");

    // It is a real credential: the gate accepts it where it accepted nothing.
    expect((await get("/gate/pending", token)).status).toBe(200);
    expect((await get("/sessions", token)).status).toBe(200);

    // A gate decision reaches the handler — 200 or a 400 about the gate, but
    // never the 403 that means "your device may not".
    const decide = await post("/gate/decide", { id: "no-such-gate", decision: "allow" }, token);
    expect(decide.status).not.toBe(403);

    // And the things a phone has no business doing say so, by name.
    const merge = await post("/prs/merge", { root: dir, number: 1, method: "squash" }, token);
    expect(merge.status).toBe(403);
    const why = await jsonOf(merge);
    expect(why.scope).toBe("answer");
    expect(why.needs).toBe("full");
    expect(why.error).toContain("/prs/merge");

    for (const path of ["/git/push", "/git/reset", "/docker/rm", "/chat/attach"]) {
      expect((await post(path, { root: dir }, token)).status, path).toBe(403);
    }
  });

  test("a look-only phone cannot decide a gate either", async () => {
    const { token } = await pair("read", "an old tablet");
    expect((await get("/sessions", token)).status).toBe(200);
    const r = await post("/gate/decide", { id: "x", decision: "allow" }, token);
    expect(r.status).toBe(403);
    expect((await jsonOf(r)).needs).toBe("answer");
  });

  test("a scope the server does not recognise lands on the narrow one", async () => {
    // A typo in a scope name must not be how a phone ends up with a terminal.
    const p = phone();
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
    const c = await jsonOf(await post("/pair/claim", { ticket: t.id, code: t.code, label: "typo", pub: p.pub }));
    const acc = await jsonOf(await post("/pair/accept", { ticket: t.id, scope: "administrator" }, TOKEN, DESK));
    expect(acc.device.scope).toBe("answer");
    const got = await jsonOf(await get(`/pair/collect?ticket=${t.id}&secret=${encodeURIComponent(c.secret)}`));
    const token = p.open(got.wrapped, t.id);
    expect((await post("/prs/merge", { root: dir, number: 1, method: "squash" }, token)).status).toBe(403);
  });

  test("a full device is the machine", async () => {
    const { token } = await pair("full", "my laptop");
    // Reaches the handler rather than the gate: what comes back is about the
    // pull request, not about the device.
    expect((await post("/prs/merge", { root: dir, number: 1, method: "squash" }, token)).status).not.toBe(403);
  });

  test("it knows what it is, which is how it learns it was forgotten", async () => {
    const { token, deviceId } = await pair("answer", "Pixel");
    const me = await jsonOf(await get("/pair/whoami", token));
    expect(me).toMatchObject({ paired: true, machine: false, scope: "answer", label: "Pixel", id: deviceId });
  });
});

describe("taking one back", () => {
  test("forgetting one device stops it, and leaves the others alone", async () => {
    const a = await pair("answer", "the lost phone");
    const b = await pair("answer", "the phone in my hand");
    expect((await get("/sessions", a.token)).status).toBe(200);

    const r = await jsonOf(await post("/pair/forget", { id: a.deviceId }, TOKEN));
    expect(r.ok).toBe(true);

    expect((await get("/sessions", a.token)).status).toBe(401);
    expect((await get("/sessions", b.token)).status).toBe(200);
    // …and the machine itself was never in question.
    expect((await get("/sessions", TOKEN)).status).toBe(200);
  });

  test("only from the machine — a phone cannot disconnect the desk", async () => {
    const { token, deviceId } = await pair("full", "a device with everything");
    // Even at `full`: this is not a scope, it is a place. The button lives on
    // the side of the desk the user is sitting at.
    const r = await post("/pair/forget", { id: deviceId }, token);
    expect(r.status).toBe(403);
    expect((await get("/sessions", token)).status).toBe(200);
  });

  test("the machine's own token is not something pairing can revoke", async () => {
    const r = await post("/pair/forget", { id: "anything-at-all" }, TOKEN);
    expect(r.status).toBe(404);
    expect((await get("/sessions", TOKEN)).status).toBe(200);
  });
});

describe("what the machine sees", () => {
  test("the pending list and the device list are for this machine only", async () => {
    // The pending list carries the code. Serving it to anything that merely
    // holds a device credential would hand a paired phone the six digits it is
    // supposed to have needed a person for.
    const { token } = await pair("full", "a device with everything");
    expect((await get("/pair/state?ticket=", token)).status).toBe(403);
    expect((await get("/pair/state?ticket=", TOKEN)).status).toBe(200);
  });

  test("names what is paired, and what it may do", async () => {
    const s = await jsonOf(await get("/pair/state?ticket=", TOKEN));
    const labels = s.devices.map((d: { label: string }) => d.label);
    expect(labels).toContain("the phone in my hand");
    expect(labels).not.toContain("the lost phone"); // revoked
    // Everything the pane draws, and nothing else.
    for (const d of s.devices) {
      expect(Object.keys(d).sort()).toEqual(
        expect.arrayContaining(["createdAt", "id", "label", "scope"]),
      );
    }
  });

  test("and does NOT name the credential hash", async () => {
    // This route used to answer the stored row verbatim, hash and all. It is
    // not brute-forceable — 32 random bytes through SHA-256 — but it is the
    // reason devices.json is written 0600, and there is no reason for it to be
    // in a browser's memory, in whatever logs the response, or in the next
    // screenshot of the Remote pane. No client ever read it.
    const s = await jsonOf(await get("/pair/state?ticket=", TOKEN));
    expect(s.devices.length).toBeGreaterThan(0);
    expect(s.devices.some((d: { hash?: string }) => d.hash !== undefined)).toBe(false);
    expect(JSON.stringify(s)).not.toContain("hash");

    // Nor does the accept that mints one.
    const p = phone();
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
    await post("/pair/claim", { ticket: t.id, code: t.code, label: "a fresh phone", pub: p.pub });
    const acc = await jsonOf(await post("/pair/accept", { ticket: t.id, scope: "answer" }, TOKEN, DESK));
    expect(acc.device.id).toBeString();
    expect(acc.device.hash).toBeUndefined();
    expect(JSON.stringify(acc)).not.toContain("hash");
  });

  test("a request waiting on a person shows who is asking and the same code", async () => {
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN));
    await post("/pair/claim", { ticket: t.id, code: t.code, label: "someone's phone", pub: phone().pub });
    const s = await jsonOf(await get(`/pair/state?ticket=${t.id}`, TOKEN));
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]).toMatchObject({ id: t.id, code: t.code, label: "someone's phone" });
    // Declining grants nothing.
    expect((await jsonOf(await post("/pair/reject", { ticket: t.id }, TOKEN))).ok).toBe(true);
  });
});

describe("the status pane no longer serves a key", () => {
  test("nothing in /remote/status is the token, for any caller", async () => {
    // The QR used to be `?token=<the machine's secret>`, so this answer had to
    // carry it. Pairing replaced that, and a URL that grants a terminal is
    // exactly what ends up in a screenshot of this pane.
    const body = await (await get("/remote/status", TOKEN)).text();
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("?token=");
  });

describe("the ceremony a machine token cannot complete on its own", () => {
  /*
   * This is the door that made the gate fix worse than the bug.
   *
   * An agent runs as the user, so it holds the machine token — the file is
   * 0600 and it is already that user. Before this, it could ask for a ticket,
   * accept its own ticket, and mint a paired device with any label it chose.
   * It then released its own held tool call through the device branch, which
   * needs no Origin at all, and the audit line read as a named phone somebody
   * had once approved. An audit log that invents a human is worse than one
   * that merely cannot tell you which machine it was.
   *
   * Refusing here does not make this a security boundary — a process running
   * as you can still append a row to devices.json, and SECURITY.md says so.
   * What it removes is the accident: the helpful agent, and the injected one
   * following an instruction it read in a pull request.
   */
  test("a bare machine token cannot accept a pairing ticket", async () => {
    const ph = phone();
    const t = await jsonOf(await post("/pair/ticket", {}, TOKEN, DESK));
    const claimed = await jsonOf(await post("/pair/claim", { ticket: t.id, code: t.code, label: "Not a phone", pub: ph.pub }));
    expect(claimed.ok).toBe(true);

    // No Origin: a shell, holding the token it can read off the disk.
    const refused = await post("/pair/accept", { ticket: t.id, scope: "answer" }, TOKEN);
    expect(refused.status).toBe(403);

    // The desk, one header apart, still completes the SAME ticket — the guard
    // answers before the ticket is spent, so a refusal costs the person nothing.
    // This half matters more than the refusal: breaking pairing would be worse
    // than the bug being closed.
    const ok = await jsonOf(await post("/pair/accept", { ticket: t.id, scope: "answer" }, TOKEN, DESK));
    expect(ok.ok).toBe(true);
  });
});
});

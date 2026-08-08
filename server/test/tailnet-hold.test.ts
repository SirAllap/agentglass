/*
 * A failed `tailscale status` is not "this machine has no tailnet name".
 *
 * The bug, in the order it happened. `tsCmd` returned null on every failure
 * mode — no binary, a daemon mid-restart, a slow socket, a busy binary — and
 * `refreshTailscale` then assigned `{ names, https }` UNCONDITIONALLY, with
 * `names` filled only on success. So one failing probe emptied the set.
 *
 * That set is not decoration. `trustedName` in index.ts reads it to decide
 * whether to upgrade a WebSocket, and the phone deliberately states its MagicDNS
 * origin — mobile/src/lib/live.ts explains at length that a native socket must,
 * or the upgrade is refused. Meanwhile the REST poll sends no Origin at all and
 * kept working. So the shape of the failure was: he is out, tailscaled restarts,
 * the 120s tick lands in the blip, /stream is refused, the queue keeps
 * refreshing on its 20s poll — the app looks alive and has quietly stopped
 * buzzing. It healed on the next successful tick, up to two minutes later, with
 * nothing said anywhere.
 *
 * ── how this is driven ────────────────────────────────────────────────────
 * With a real `tailscale` on PATH: a shell script in a temp directory that reads
 * a mode file and either prints a status body or fails the way tailscaled does
 * when it is not running. No seam, so what is pinned is the code that ships.
 *
 * `process.env.PATH` is set per test and put back immediately, because `bun
 * test` shares one process across files. The stub directory holds exactly one
 * file — `tailscale` — so nothing else's `Bun.which` can see anything new.
 *
 * And it works at all only because tsCmd passes the PATH explicitly: measured,
 * `Bun.which(cmd)` resolves against the PATH the process STARTED with, and a
 * later `process.env.PATH` is ignored. A stub put on PATH at runtime was
 * silently bypassed and the real binary answered — twice, before it was noticed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-tailnet-"));
const bin = join(dir, "bin");
const NAME = "test-box.example-tailnet.ts.net";

writeFileSync(join(dir, "status.json"), JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "test-box", DNSName: `${NAME}.` },
}));
// Serve fronting port 4000, which is what the `https` half is read out of.
writeFileSync(join(dir, "serve.json"), JSON.stringify({
  Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4000" } } } },
}));
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "tailscale"), `#!/usr/bin/env bash
mode=$(cat ${JSON.stringify(join(dir, "mode"))} 2>/dev/null || echo ok)
if [ "$mode" = fail ]; then
  # Exactly what the real binary does with no daemon to talk to: a line on
  # stderr, NOTHING on stdout, a non-zero exit.
  echo "failed to connect to local tailscaled" >&2
  exit 1
fi
case "$1" in
  status) cat ${JSON.stringify(join(dir, "status.json"))};;
  serve)  cat ${JSON.stringify(join(dir, "serve.json"))};;
  *) echo '{}';;
esac
`);
chmodSync(join(bin, "tailscale"), 0o755);

const R = await import("../src/remote.ts");

const realPath = process.env.PATH ?? "";
/** Put the stub in front for one call, and take it straight back out. */
const withStub = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.PATH = `${bin}:${realPath}`;
  try { return await fn(); } finally { process.env.PATH = realPath; }
};
/** …and with NO tailscale reachable at all. An empty PATH cannot resolve one. */
const withNoTailscale = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.PATH = join(dir, "empty");
  try { return await fn(); } finally { process.env.PATH = realPath; }
};
const mode = (m: "ok" | "fail") => writeFileSync(join(dir, "mode"), m);
const probe = (now?: number) => withStub(() => R.refreshTailscale(4000, now));

beforeEach(() => { R.__resetTailnet(); mode("ok"); });
afterEach(() => { process.env.PATH = realPath; });
afterAll(() => { R.__resetTailnet(); rmSync(dir, { recursive: true, force: true }); });

describe("a probe that could not ask", () => {
  it("keeps the trusted name, so the phone's upgrade survives a restart", async () => {
    // THE regression. Before the fix this second assertion was an empty set,
    // and an empty set is a refused WebSocket.
    await probe();
    expect([...R.tailnetNames()]).toEqual([NAME]);

    mode("fail");
    const r = await probe();
    expect(r.ok).toBe(false);
    expect([...R.tailnetNames()]).toEqual([NAME]);
  });

  it("asks again sooner than a successful one, and backs off", async () => {
    const ok = await probe();
    expect(ok.nextMs).toBe(R.TAILNET_OK_MS);

    mode("fail");
    // A failure is the state most worth leaving: every second of it spends the
    // hold's deadline. 120s of waiting to retry was the other half of the bug.
    expect((await probe()).nextMs).toBe(10_000);
    expect((await probe()).nextMs).toBe(20_000);
    expect((await probe()).nextMs).toBe(40_000);
    expect((await probe()).nextMs).toBe(60_000);
    expect((await probe()).nextMs).toBe(60_000);
  });

  it("says WHY, so 'no tailnet' and 'could not ask' stop looking identical", async () => {
    await probe();
    expect(R.tailnetHealth().problem).toBeUndefined();

    mode("fail");
    await probe();
    const h = R.tailnetHealth();
    expect(h.problem).toBeTruthy();
    expect(h.names).toEqual([NAME]);
    expect(h.fails).toBe(1);
    expect(h.dropped).toBeUndefined();
  });

  it("carries that onto /remote/status, which is where anyone would see it", async () => {
    mode("fail");
    await probe();
    const st = R.remoteStatus({ bind: "0.0.0.0", port: 4000, trustLan: true, token: "x", webUi: true, addresses: [], which: () => null });
    expect(st.tailnet.problem).toBeTruthy();
  });
});

describe("the staleness budget", () => {
  it("lets the name go once the hold has run too long", async () => {
    // A trust cache with no deadline is a name that outlives the tailnet it
    // came from. The grace is measured from the last ANSWER, not the last
    // attempt, or a retry every ten seconds would renew it for ever.
    const t = 1_800_000_000_000;
    await probe(t);
    mode("fail");
    expect((await probe(t + 60_000)).dropped).toBe(false);
    expect([...R.tailnetNames()]).toEqual([NAME]);

    const gone = await probe(t + 11 * 60_000);
    expect(gone.dropped).toBe(true);
    expect([...R.tailnetNames()]).toEqual([]);
    // And the empty set is still not silent: it says it was dropped, which is a
    // different fact from "this machine has no tailnet".
    expect(R.tailnetHealth().dropped).toBe(true);
  });

  it("is spent only while we cannot ask, never while we can", async () => {
    const t = 1_800_000_000_000;
    await probe(t);
    // Logged out, or removed from the tailnet: a real status body with no name
    // in it. Exit code deliberately not consulted — the BODY is the answer.
    writeFileSync(join(dir, "status.json"), JSON.stringify({ BackendState: "Stopped", Self: null }));
    const r = await probe(t + 1000);
    expect(r.ok).toBe(true);
    expect([...R.tailnetNames()]).toEqual([]);
    expect(R.tailnetHealth().dropped).toBeUndefined();
    writeFileSync(join(dir, "status.json"), JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NAME}.` } }));
  });
});

describe("no tailscale at all", () => {
  it("is an answer, not a hold — retrying cannot produce a name", async () => {
    await probe();
    expect([...R.tailnetNames()]).toEqual([NAME]);

    const r = await withNoTailscale(() => R.refreshTailscale(4000));
    expect(r.ok).toBe(true);
    expect(r.nextMs).toBe(R.TAILNET_OK_MS);
    expect([...R.tailnetNames()]).toEqual([]);
    expect(R.tailnetHealth()).toMatchObject({ installed: false, names: [] });
  });
});

describe("the serve offer", () => {
  it("appears in the address list while serve is fronting our port", async () => {
    await probe();
    const st = R.remoteStatus({ bind: "0.0.0.0", port: 4000, trustLan: true, token: "x", webUi: true, addresses: [], which: () => null });
    expect(st.addresses[0]).toMatchObject({ address: NAME, secure: true, url: `https://${NAME}/` });
  });

  it("goes away when serve says it is off, because `{}` is an answer", async () => {
    await probe();
    writeFileSync(join(dir, "serve.json"), "{}");
    await probe();
    expect(R.remoteStatus({ bind: "0.0.0.0", port: 4000, trustLan: true, token: "x", webUi: true, addresses: [], which: () => null }).addresses).toEqual([]);
    writeFileSync(join(dir, "serve.json"), JSON.stringify({
      Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4000" } } } },
    }));
  });
});

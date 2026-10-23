/*
 * "Turn on HTTPS" runs `tailscale serve --bg <port>` for the person, so nobody
 * has to open a terminal to pair a phone.
 *
 * Driven like tailnet-hold.test.ts: a real `tailscale` shell script on PATH
 * that reads a mode file, so what is pinned is the code that ships. The stderr
 * texts are the ones the real binary prints when Serve is off, when the user is
 * not the operator, and when the tailnet has no HTTPS certificates.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-serve-"));
const bin = join(dir, "bin");
const NAME = "test-box.example-tailnet.ts.net";
const ENABLE = "https://login.tailscale.com/f/serve?node=n123";

writeFileSync(join(dir, "status.json"), JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "test-box", DNSName: `${NAME}.` },
}));
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "tailscale"), `#!/usr/bin/env bash
mode=$(cat ${JSON.stringify(join(dir, "mode"))} 2>/dev/null || echo ok)
serve=${JSON.stringify(join(dir, "serve.json"))}
case "$1" in
  status) cat ${JSON.stringify(join(dir, "status.json"))};;
  serve)
    if [ "$2" = status ]; then cat "$serve" 2>/dev/null || echo '{}'; exit 0; fi
    case "$mode" in
      notenabled) printf 'Serve is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         ${ENABLE}\\n' >&2; exit 1;;
      hang) printf 'Serve is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         ${ENABLE}\\n' >&2; exec sleep 30;;
      denied) echo "Access denied: serve config denied" >&2; echo "Use 'sudo tailscale serve' or 'sudo tailscale set --operator=\\$USER'" >&2; exit 1;;
      nocert) echo "HTTPS certificates are not enabled for your tailnet" >&2; exit 1;;
    esac
    echo '{"Web":{"${NAME}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4000"}}}}}' > "$serve"
    echo "Available within your tailnet: https://${NAME}/";;
  *) echo '{}';;
esac
`);
chmodSync(join(bin, "tailscale"), 0o755);

const R = await import("../src/remote.ts");
const realPath = process.env.PATH ?? "";
const withStub = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.PATH = `${bin}:${realPath}`;
  try { return await fn(); } finally { process.env.PATH = realPath; }
};
const mode = (m: string) => writeFileSync(join(dir, "mode"), m);
const secureRows = () =>
  R.remoteStatus({ bind: "0.0.0.0", port: 4000, trustLan: true, token: "x", webUi: true, addresses: [], which: () => null })
    .addresses.filter((a) => a.secure);

beforeEach(() => { R.__resetTailnet(); mode("ok"); rmSync(join(dir, "serve.json"), { force: true }); });
afterEach(() => { process.env.PATH = realPath; });
afterAll(() => { R.__resetTailnet(); rmSync(dir, { recursive: true, force: true }); });

describe("enableServe", () => {
  it("runs serve and the HTTPS route is there when it returns", async () => {
    await withStub(() => R.refreshTailscale(4000));
    expect(secureRows()).toHaveLength(0);
    const r = await withStub(() => R.enableServe(4000));
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`https://${NAME}/`);
    expect(secureRows()).toHaveLength(1);
  });

  it("hands back the enable link when Serve is off on the tailnet", async () => {
    mode("notenabled");
    const r = await withStub(() => R.enableServe(4000));
    expect(r).toMatchObject({ ok: false, reason: "not-enabled", url: ENABLE });
  });

  it("stops waiting for a serve that prints the link and then waits for a click", async () => {
    mode("hang");
    const t0 = Date.now();
    const r = await withStub(() => R.enableServe(4000, { timeoutMs: 400 }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r).toMatchObject({ ok: false, reason: "not-enabled", url: ENABLE });
  });

  it("gives the operator hint on access denied, and never runs sudo itself", async () => {
    mode("denied");
    const r = await withStub(() => R.enableServe(4000));
    expect(r.reason).toBe("access-denied");
    expect(r.command).toBe("sudo tailscale set --operator=$USER");
  });

  it("points a certificate error at the admin console", async () => {
    mode("nocert");
    const r = await withStub(() => R.enableServe(4000));
    expect(r.reason).toBe("no-https");
    expect(r.message).toContain("DNS");
  });

  it("says so when tailscale is not installed", async () => {
    process.env.PATH = join(dir, "empty");
    const r = await R.enableServe(4000);
    expect(r).toMatchObject({ ok: false, reason: "absent" });
  });
});

describe("classifyServeFailure", () => {
  it("falls back to the printed text for anything it does not know", () => {
    expect(R.classifyServeFailure("something odd happened\n")).toMatchObject({ reason: "failed", message: "something odd happened" });
  });
});

describe("refreshTailscaleIfStale", () => {
  it("skips a probe that is fresh enough and takes one that is not", async () => {
    await withStub(() => R.refreshTailscale(4000));
    // serve turned on from a terminal, behind the cache's back
    await withStub(() => R.enableServe(4000, { reprobe: false }));
    expect(secureRows()).toHaveLength(0);
    await withStub(() => R.refreshTailscaleIfStale(4000, 60_000));
    expect(secureRows()).toHaveLength(0);
    await withStub(() => R.refreshTailscaleIfStale(4000, 0));
    expect(secureRows()).toHaveLength(1);
  });
});

describe("the route", () => {
  it("is machine-only and the status asks for a fresh probe on request", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const at = src.indexOf('pathname === "/remote/serve"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("\n    }\n", at));
    expect(block).toContain("atMachine()");
    expect(block).toContain("enableServe(");
    expect(src).toContain('searchParams.get("fresh")');
  });
});

/*
 * There is no metrics receiver here, and the server says so.
 *
 * The absence is deliberate — otlp.ts sets out why — but for a long time the
 * only way to find out was that nothing arrived. Pointing
 * `OTEL_EXPORTER_OTLP_ENDPOINT` at agentglass from Claude Code sent its metrics
 * to a 404, which an exporter swallows into a log on whichever machine the
 * agent happens to be running on, and the person is left watching a dashboard
 * that never fills with nothing anywhere telling them why.
 *
 * That is the same failure this codebase already refuses to ship elsewhere: the
 * firewall hint exists because ufw DROPs rather than REJECTs and the phone just
 * shows a white page. This is the OTel version of it.
 *
 * Driven against a real server, because what is being checked is partly the
 * HTTP: the status code an exporter will not retry, and that the route answers
 * before the token gate rather than behind it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { docSection } from "./docs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "metrics-test-token-not-a-real-one";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-metrics-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, never `...process.env` — `bun test` shares one
    // process across files, so the parent's is whatever ran before this.
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
      // Set, so "answers without a credential" is a fact rather than an
      // artefact of there being no gate to pass.
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

/** What Claude Code's exporter actually POSTs: an OTLP metrics envelope. */
const METRICS = {
  resourceMetrics: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
    scopeMetrics: [{ metrics: [{ name: "claude_code.token.usage", sum: { dataPoints: [{ asInt: "1200" }] } }] }],
  }],
};

const post = (path: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(METRICS),
  });

describe("metrics arriving at a server that does not take them", () => {
  test("are refused with a status an exporter will not retry", async () => {
    // 404 was the old answer and it is indistinguishable from a typo in the
    // endpoint. 429/502/503/504 are the ones OTel exporters retry, and a
    // misconfigured agent hammering the port forever is worse than a 404.
    for (const path of ["/v1/metrics", "/otlp/v1/metrics"]) {
      const r = await post(path);
      expect(r.status, path).toBe(501);
    }
  });

  test("and the refusal says what this server does take", async () => {
    const j = await (await post("/v1/metrics")).json() as Record<string, unknown>;
    expect(j.accepts).toEqual(["/v1/traces", "/v1/logs"]);
    expect(String(j.error)).toContain("no OpenTelemetry metrics receiver");
  });

  test("and names where Claude Code is already covered", async () => {
    // The single most likely sender, and the one for whom nothing is actually
    // missing — so the answer has to say that rather than only "no".
    const j = await (await post("/v1/metrics")).json() as Record<string, string>;
    expect(j.claudeCode).toContain("hooks");
    expect(j.claudeCode).toContain("bun run setup");
  });

  test("without needing a credential, because an exporter cannot carry one", async () => {
    // The token is set on this server. If this route were behind the gate, the
    // silent 404 would have become a silent 401 — the same dead end.
    const r = await post("/v1/metrics");
    expect(r.status).not.toBe(401);
    expect(r.status).toBe(501);
  });

  test("and answers a browser too, which is what a person tries next", async () => {
    const r = await fetch(base + "/v1/metrics");
    expect(r.status).toBe(501);
    expect(String((await r.json() as Record<string, unknown>).error)).toContain("metrics receiver");
  });

  test("the receivers that do exist still take what they take", async () => {
    // The guard against fixing this by turning the OTLP surface off.
    for (const path of ["/v1/traces", "/v1/logs"]) {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(r.status, path).toBe(200);
    }
  });
});

describe("what the documentation says about it", () => {
  const repo = (p: string) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");

  test("the README no longer lists Claude Code as an OTLP source", () => {
    // The claim was corrected in otlp.ts and left standing in the README, which
    // is the more widely read of the two.
    const section = docSection("### OpenTelemetry", "### Auto-connect installed CLIs");
    expect(section).not.toMatch(/LangChain, LiteLLM, OpenLLMetry, and Claude Code's own OTel export/);
    expect(section).toContain("Not Claude Code's own OTel export");
    // …and says where it *is* covered, rather than only that it is not here.
    expect(section).toContain("bun run setup");
  });

  test("and the mapper's own header stops claiming JSON only", () => {
    // Protobuf has been decoded since otlp_pb.ts landed; the header said
    // otherwise for as long, which is the same kind of stale claim.
    const otlp = repo("server/src/otlp.ts");
    expect(otlp).not.toContain("JSON only: point your exporter");
    expect(otlp).toContain("protobuf");
  });

  test("the decision not to receive metrics is written down, not implied", () => {
    // The issue asked for it either way. An absence with no reason attached is
    // indistinguishable from an oversight, and gets 'fixed' by the next person.
    const otlp = repo("server/src/otlp.ts");
    expect(otlp).toContain("deliberately, not by");
    expect(otlp).toMatch(/double-counting/);
  });
});

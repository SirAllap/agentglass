/*
 * `agentglass-ui flight-plan plan merge-local`: --override only fills the API's {override: {reason}}
 * with the typed words, a refusal is handed over with its state, and a bad reason never reaches the server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "..", "bin", "agentglass-ui");
const home = mkdtempSync(join(tmpdir(), "agx-cli-ml-"));
const seen: { path: string; body: any }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, state: "merged" } };
let srv: ReturnType<typeof Bun.serve>;
beforeAll(() => { srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { seen.push({ path: new URL(req.url).pathname, body: await req.json().catch(() => null) }); return Response.json(reply.body, { status: reply.status }); } }); });
afterAll(() => { srv.stop(true); rmSync(home, { recursive: true, force: true }); });

const ID = "fp_0123456789abcdef";
const run = async (...args: string[]) => {
  const p = Bun.spawn(["python3", CLI, "flight-plan", "plan", "merge-local", ID, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, AGENTGLASS_SERVER: `http://127.0.0.1:${srv.port}`, AGENTGLASS_TOKEN: "tok-cli-example" } });
  const out = await new Response(p.stdout).text(); await p.exited;
  try { return JSON.parse(out) as Record<string, any>; } catch { return { raw: out } as Record<string, any>; }
};

describe("merge-local from the CLI", () => {
  test("no flag sends an empty body; --override sends the typed reason, --signoff adds signoff", async () => {
    seen.length = 0;
    expect((await run()).state).toBe("merged");
    expect(seen[0]!.path).toBe(`/flight-plan/plans/${ID}/merge-local`);
    expect(seen[0]!.body.override).toBeUndefined();
    await run("--override", "  QA is down today ");
    expect(seen[1]!.body.override).toEqual({ reason: "QA is down today" });
    await run("--override", "the review cannot run", "--signoff");
    expect(seen[2]!.body.override).toEqual({ reason: "the review cannot run", signoff: true });
  });
  test("a reason outside 3 to 500 characters, or --signoff alone, never reaches the server", async () => {
    seen.length = 0;
    expect((await run("--override", "ok")).ok).toBe(false);
    expect((await run("--override", "x".repeat(501))).ok).toBe(false);
    expect((await run("--signoff")).error).toContain("--override");
    expect(seen).toHaveLength(0);
  });
  test("a refusal comes back whole, with its state and the HTTP status", async () => {
    reply = { status: 202, body: { ok: false, state: "signoff-running", runId: "pf_0123456789abcdef" } };
    const r = await run();
    expect(r).toMatchObject({ ok: false, state: "signoff-running", runId: "pf_0123456789abcdef", status: 202 });
    reply = { status: 409, body: { ok: false, state: "required-step", error: "Required step not done" } };
    expect(await run()).toMatchObject({ state: "required-step", status: 409 });
  });
});

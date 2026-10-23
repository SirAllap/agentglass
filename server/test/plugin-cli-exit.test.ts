/*
 * `agentglass-plugin list` is a read: a correct list exits 0, with or without
 * --json and when it is empty. And a refusal always says something: `remove`
 * of a name nobody installed used to print a bare `{"ok": false}`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "./freePort.ts";

const CLI = new URL("../../bin/agentglass-plugin", import.meta.url).pathname;
let stub: ReturnType<typeof Bun.serve>;
let listing: unknown[] = [];

beforeAll(async () => {
  stub = Bun.serve({
    port: await freePort(), hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/plugins") return Response.json({ master: true, plugins: listing });
      return Response.json({ ok: false }, { status: 404 });
    },
  });
});
afterAll(() => stub.stop(true));

async function cli(...args: string[]) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: `http://127.0.0.1:${stub.port}`, AGENTGLASS_TOKEN: "t" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim() };
}

describe("agentglass-plugin exit codes", () => {
  test("list --json exits 0 with a list, and with an empty one", async () => {
    listing = [{ name: "orbit-reviewer", enabled: true }];
    expect((await cli("list", "--json")).code).toBe(0);
    listing = [];
    expect((await cli("list")).code).toBe(0);
    expect((await cli("list", "--json")).code).toBe(0);
  });

  test("remove of an unknown name still fails, and says why", async () => {
    const r = await cli("remove", "zzz");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toBe("server said 404");
  });
});

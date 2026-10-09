/*
 * `agentglass-plugin settings <name> key=value` puts the value on the command
 * line, which is shell history and /proc/<pid>/cmdline. For a field that is a
 * secret the CLI refuses that and reads the value from standard input.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const CLI = new URL("../../bin/agentglass-plugin", import.meta.url).pathname;
const KEY = "tk-orbit-1042-not-a-real-key";

let server: ReturnType<typeof Bun.serve>;
const saved: unknown[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/plugins/settings" && req.method === "GET") {
        return Response.json({
          ok: true, values: { apiKey: null, mode: "off" }, set: [],
          fields: [{ key: "apiKey", type: "secret", label: "Key" }, { key: "mode", type: "string", label: "Mode" }],
        });
      }
      if (url.pathname === "/plugins/settings" && req.method === "POST") {
        saved.push(await req.json());
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

async function run(args: string[], stdin = ""): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTGLASS_SERVER: `http://127.0.0.1:${server.port}`, AGENTGLASS_TOKEN: "" },
    stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
}

describe("agentglass-plugin settings with a secret", () => {
  test("refuses the value on the command line, and never sends it", async () => {
    saved.length = 0;
    const r = await run(["settings", "orbit-scorer", `apiKey=${KEY}`]);
    expect(r.out).toContain("is a secret");
    expect(r.out, "the refusal echoed the key").not.toContain(KEY);
    expect(saved).toEqual([]);
  });

  test("reads it from standard input with key=-", async () => {
    saved.length = 0;
    await run(["settings", "orbit-scorer", "apiKey=-", "mode=live"], KEY + "\n");
    expect(saved).toEqual([{ name: "orbit-scorer", values: { apiKey: KEY, mode: "live" } }]);
  });

  test("an ordinary field still takes key=value", async () => {
    saved.length = 0;
    await run(["settings", "orbit-scorer", "mode=live"]);
    expect(saved).toEqual([{ name: "orbit-scorer", values: { mode: "live" } }]);
  });
});

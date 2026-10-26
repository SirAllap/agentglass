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
        const body = (await req.json()) as { name?: string };
        saved.push(body);
        // A refused save: the answer is what the CLI prints, and it must not carry the key.
        if (body.name === "orbit-refused") return Response.json({ ok: false, error: "could not save the key" }, { status: 400 });
        return Response.json({ ok: true, values: { apiKey: null, mode: "live" }, set: ["apiKey"] });
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

  test("never prints the key it read, on a save or on a refusal", async () => {
    for (const name of ["orbit-scorer", "orbit-refused"]) {
      const r = await run(["settings", name, "apiKey=-"], KEY + "\n");
      expect(r.out, `${name}: the answer echoed the key`).not.toContain(KEY);
    }
  });

  // CodeQL (py/clear-text-logging-sensitive-data) treats the answer of a
  // function named for a secret as a secret, and everything the CLI computes
  // ends in print(). The one such name allowed is the token reader, which
  // only fills the Authorization header.
  test("no function in the CLI is named for a secret except the token reader", async () => {
    const src = await Bun.file(CLI).text();
    const names = [...src.matchAll(/^\s*def ([A-Za-z_][A-Za-z0-9_]*)\(/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => /secret|passw|token|credential|key/i.test(n))).toEqual(["token"]);
  });
});

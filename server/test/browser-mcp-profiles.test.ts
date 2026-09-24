/*
 * The MCP tool list is re-read by the client on every turn, so its size is a
 * cost on every turn of every session that has the server configured. The
 * profiles shrink it without removing a verb: `core` lists the everyday ones
 * and one generic `browser {verb, args}` for the rest; `generic` is that tool
 * alone. The default is untouched, because a client written against the 68
 * names must not lose one on upgrade.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "./freePort.ts";

const MCP = new URL("../../bin/agentglass-browser-mcp", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

type Tool = { name: string; description: string; inputSchema: { required?: string[] } };
type Reply = { result?: { tools?: Tool[]; content?: { text: string }[]; isError?: boolean } };

const hello = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const call = (id: number, name: string, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function talk(env: Record<string, string>, messages: unknown[]): Promise<Reply[]> {
  const p = Bun.spawn(["python3", MCP], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const w = p.stdin as { write: (s: string) => void; end: () => void };
  for (const m of [hello, ...messages]) w.write(`${JSON.stringify(m)}\n`);
  w.end();
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Reply).slice(1);
}

const bytes = (tools: Tool[]) => JSON.stringify({ tools }).length;

// A stand-in for the relay, recording the path each call arrived on.
let stub: ReturnType<typeof Bun.serve> | null = null;
const seen: string[] = [];
beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      /* The two reads browser_storage_state is composed of, answered in the
         shapes the relay gives them; every other verb gets a plain ok. */
      if (path === "/browser/cdp") return Response.json({ ok: true, value: { result: { cookies: [{ name: "sid", value: "x" }] } } });
      if (path === "/browser/eval") {
        return Response.json({ ok: true, value: { value: { origin: "https://orbit.example", localStorage: { k: "v" }, sessionStorage: {} } } });
      }
      return Response.json({ ok: true, value: "stub" });
    },
  });
});
afterAll(() => { stub?.stop(true); });

describe.skipIf(!HAVE_PY)("MCP tool profiles", () => {
  test("default lists every tool and no generic one", async () => {
    const [r] = await talk({}, [list]);
    const tools = r!.result!.tools!;
    expect(tools.length).toBeGreaterThan(60);
    expect(tools.map((t) => t.name)).not.toContain("browser");
  });

  test("core is a fraction of the full list and still has the everyday verbs", async () => {
    const [full] = await talk({}, [list]);
    const [core] = await talk({ AGENTGLASS_MCP_TOOLS: "core" }, [list]);
    const names = core!.result!.tools!.map((t) => t.name);
    for (const n of ["browser_open", "browser_observe", "browser_click", "browser_fill", "browser_shot", "browser_checkup", "browser"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("browser_har");
    expect(bytes(core!.result!.tools!)).toBeLessThan(bytes(full!.result!.tools!) / 3);
  });

  test("generic is one tool that names every verb it hides", async () => {
    const [full] = await talk({}, [list]);
    const [g] = await talk({ AGENTGLASS_MCP_TOOLS: "generic" }, [list]);
    const tools = g!.result!.tools!;
    expect(tools.map((t) => t.name)).toEqual(["browser"]);
    expect(tools[0]!.inputSchema.required).toEqual(["verb"]);
    for (const t of full!.result!.tools!) {
      expect(tools[0]!.description).toContain(t.name.replace("browser_", ""));
    }
  });

  test("a hidden verb is reachable through `browser` and lands on its own route", async () => {
    seen.length = 0;
    const [r] = await talk(
      { AGENTGLASS_MCP_TOOLS: "generic", AGENTGLASS_SERVER: `http://127.0.0.1:${stub!.port}` },
      [call(2, "browser", { verb: "browser_har", args: { action: "stop", shared: true } })],
    );
    expect(r!.result!.isError).toBeFalsy();
    expect(seen.some((p) => p === "/browser/har")).toBe(true);
  });

  test("help returns the schema of one verb, and the verb list for none", async () => {
    const [one, none] = await talk({ AGENTGLASS_MCP_TOOLS: "generic" }, [
      call(2, "browser", { verb: "help", args: { verb: "har" } }),
      call(3, "browser", { verb: "help" }),
    ]);
    expect(JSON.parse(one!.result!.content![0]!.text).name).toBe("browser_har");
    expect(none!.result!.content![0]!.text).toContain("har");
  });

  test("help with args that are not an object is refused and the session lives on", async () => {
    const replies = await talk({ AGENTGLASS_MCP_TOOLS: "generic" }, [
      call(2, "browser", { verb: "help", args: "x" }),
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    expect(replies).toHaveLength(2);
    expect(replies[0]!.result!.isError).toBe(true);
    expect(replies[1]!.result).toEqual({});
  });

  test("an unknown verb is refused by name, not sent", async () => {
    seen.length = 0;
    const [r] = await talk(
      { AGENTGLASS_MCP_TOOLS: "generic", AGENTGLASS_SERVER: `http://127.0.0.1:${stub!.port}` },
      [call(2, "browser", { verb: "teleport", args: {} })],
    );
    expect(r!.result!.isError).toBe(true);
    expect(r!.result!.content![0]!.text).toContain("teleport");
    expect(seen).toEqual([]);
  });

  /* A composed tool is made of other tools' calls, made through the same
     `run` the generic tool dispatches to; neither path may lose the other. */
  test("a composed tool is reachable through `browser`, and its parts reach the relay", async () => {
    seen.length = 0;
    const [r] = await talk(
      { AGENTGLASS_MCP_TOOLS: "core", AGENTGLASS_SERVER: `http://127.0.0.1:${stub!.port}` },
      [call(2, "browser", { verb: "storage_state", args: { shared: true } })],
    );
    expect(r!.result!.isError, JSON.stringify(r)).toBeFalsy();
    const state = JSON.parse(r!.result!.content![0]!.text) as { cookies: { name: string }[]; origins: { origin: string }[] };
    expect(state.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(state.origins[0]!.origin).toBe("https://orbit.example");
    expect(seen).toEqual(["/browser/cdp", "/browser/eval"]);
  });

  test("the profile holds on the Streamable-HTTP transport too", async () => {
    const port = await freePort();
    const token = "mcp-profile-test-token-0123456789abcdef";
    const p = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_MCP_TOOLS: "generic", AGENTGLASS_MCP_TOKEN: token, AGENTGLASS_MCP_HTTP: `127.0.0.1:${port}` },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try { up = (await post({ jsonrpc: "2.0", id: 0, method: "ping" })).ok; } catch { /* not up yet */ }
        if (!up) await Bun.sleep(50);
      }
      expect(up).toBe(true);
      const j = await (await post(list)).json() as Reply;
      expect(j.result!.tools!.map((t) => t.name)).toEqual(["browser"]);
    } finally {
      p.kill();
      await p.exited;
    }
  });
});

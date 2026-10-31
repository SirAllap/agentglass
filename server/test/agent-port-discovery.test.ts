/*
 * The desktop shell moves to another port when 4000 is taken, and a pane
 * inherits whatever AGENTGLASS_PORT its tmux server was started with. Hooks and
 * CLIs defaulted to 4000 and posted to the stranger there, which answers 200.
 * The server now writes its real port next to the token file; every client
 * family reads it before the environment. One test per family: the server that
 * writes it, the Python clients, the opencode plugin, the status line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { startHarness, type Harness } from "./fixtures/workerHarness.ts";

const REPO = join(import.meta.dir, "..", "..");
const PY_CLIENTS = [
  "bin/agentglass-agent", "bin/agentglass-cleanup", "bin/agentglass-ui", "bin/agentglass-browser", "bin/agentglass-browser-mcp", "bin/agentglass-plugin",
  "hooks/send_event.py", "hooks/gate_event.py", "hooks/connect_otel.py", "hooks/connect_opencode.py", "hooks/seed_demo.py",
];

const home = mkdtempSync(join(tmpdir(), "agx-portfile-"));
const withPort = (written: string | null) => {
  rmSync(join(home, "agentglass"), { recursive: true, force: true });
  if (written !== null) { mkdirSync(join(home, "agentglass")); writeFileSync(join(home, "agentglass", "port"), written); }
};
const clean = (extra: Record<string, string> = {}) =>
  ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, ...extra });
afterAll(() => rmSync(home, { recursive: true, force: true }));

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("portfile"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

describe.skipIf(!have)("the server writes the port it bound", () => {
  test("next to the token file, and the file is what a client reads", () => {
    const port = new URL(h.base).port;
    expect(readFileSync(join(h.dir, "agentglass", "port"), "utf8").trim()).toBe(port);
  });
});

describe("the Python clients", () => {
  const fnOf = (src: string) => src.slice(src.indexOf("def _default_server("), src.indexOf("\n\n\n", src.indexOf("def _default_server(")));

  test("all ten carry the same resolver, so the copies cannot drift", async () => {
    const bodies = new Set<string>();
    for (const f of PY_CLIENTS) { const s = await Bun.file(join(REPO, f)).text(); expect(s).toContain("def _default_server("); bodies.add(fnOf(s)); }
    expect(bodies.size).toBe(1);
  });

  test("the written port beats a stale AGENTGLASS_PORT; a bad file falls back to it; none gives 4000", async () => {
    const src = fnOf(await Bun.file(join(REPO, "hooks/send_event.py")).text());
    const ask = async (written: string | null, env: Record<string, string>) => {
      withPort(written);
      const p = Bun.spawn(["python3", "-I", "-c", `import os\n${src}\nprint(_default_server("127.0.0.1"))`], { env: clean(env), stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    };
    expect(await ask("4001\n", { AGENTGLASS_PORT: "4000" })).toBe("http://127.0.0.1:4001");
    expect(await ask("not a port", { AGENTGLASS_PORT: "4002" })).toBe("http://127.0.0.1:4002");
    expect(await ask("99999", {})).toBe("http://127.0.0.1:4000");
    expect(await ask(null, {})).toBe("http://127.0.0.1:4000");
  });
});

describe("the opencode plugin and the status line", () => {
  test("the plugin resolves the written port, and AGENTGLASS_SERVER still wins", async () => {
    const { resolveServer } = await import("../../hooks/opencode-plugin.js" as string);
    withPort("4001");
    expect(resolveServer({ XDG_CONFIG_HOME: home, AGENTGLASS_PORT: "4000" })).toBe("http://127.0.0.1:4001");
    expect(resolveServer({ XDG_CONFIG_HOME: home, AGENTGLASS_SERVER: "http://localhost:4555" })).toBe("http://127.0.0.1:4555");
    withPort(null);
    expect(resolveServer({ XDG_CONFIG_HOME: home })).toBe("http://127.0.0.1:4000");
  });

  test("the status line takes the written port before AGENTGLASS_PORT", async () => {
    const sh = await Bun.file(join(REPO, "hooks/statusline.sh")).text();
    const a = sh.indexOf("agx_port=\n"), b = sh.indexOf("agx_server=", a);
    expect(a).toBeGreaterThan(0);
    const snippet = sh.slice(a, b) + `agx_server="\${AGENTGLASS_SERVER:-http://127.0.0.1:$agx_port}"\necho "$agx_server"`;
    const ask = async (written: string | null, env: Record<string, string>) => {
      withPort(written);
      const p = Bun.spawn(["sh", "-c", snippet], { env: clean(env), stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    };
    expect(await ask("4001", { AGENTGLASS_PORT: "4000" })).toBe("http://127.0.0.1:4001");
    expect(await ask(null, { AGENTGLASS_PORT: "4002" })).toBe("http://127.0.0.1:4002");
    expect(await ask(null, {})).toBe("http://127.0.0.1:4000");
  });
});

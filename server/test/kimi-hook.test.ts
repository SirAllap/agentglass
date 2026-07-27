import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("Kimi Code hook forwarding", () => {
  test.if(!!python)("uses --model-name when Kimi's hook payload omits the model", async () => {
    let resolveBody!: (body: any) => void;
    const received = Promise.race([
      new Promise<any>((resolve) => { resolveBody = resolve; }),
      Bun.sleep(3_000).then(() => { throw new Error("Kimi hook event was not received"); }),
    ]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        resolveBody(await req.json());
        return new Response("ok");
      },
    });
    servers.push(server);

    const proc = Bun.spawn(
      [
        python!,
        join(import.meta.dir, "..", "..", "hooks", "send_event.py"),
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--source-app",
        "kimi-project",
        "--model-name",
        "kimi-code/k3",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "kimi-session-1",
      cwd: "/workspace/kimi-project",
      tool_name: "Bash",
    }));
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await received).toMatchObject({
      source_app: "kimi-project",
      session_id: "kimi-session-1",
      hook_event_type: "PostToolUse",
      model_name: "kimi-code/k3",
      payload: { tool_name: "Bash" },
    });
  });
});

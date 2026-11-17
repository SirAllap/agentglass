/*
 * THE HOOK NEVER HOLDS THE TRANSCRIPT.
 *
 * `send_event.py --add-chat` used to read every line of the session transcript
 * into a list and post it: ~1.7 GB resident per call on a long session, which
 * on a busy machine meant memory pressure and server stalls. It now streams the
 * file and sends one usage total per model. Pinned against the real script with
 * a ~200 MB invented transcript: peak RSS of the child stays under 64 MB and the
 * fake server still gets the event with the right token sums.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);
const HOOK = join(import.meta.dir, "..", "..", "hooks", "send_event.py");

const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("send_event.py --add-chat memory", () => {
  test.skipIf(!python)("a 200 MB transcript stays under 64 MB RSS and still reaches the server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-mem-"));
    dirs.push(dir);
    const tpath = join(dir, "t.jsonl");
    const fd = openSync(tpath, "w");
    const filler = "lorem ipsum ".repeat(170); // ~2 KB per line
    const TURNS = 100_000;
    let chunk = "";
    for (let i = 0; i < TURNS; i++) {
      chunk += JSON.stringify({
        type: "assistant",
        message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: filler }], usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 4 } },
      }) + "\n";
      if (i % 2000 === 1999) { writeSync(fd, chunk); chunk = ""; }
    }
    writeSync(fd, chunk);
    closeSync(fd);

    let got: any = null;
    const s = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) { got = await req.json(); return new Response("{}", { headers: { "content-type": "application/json" } }); },
    });
    servers.push(s);

    const wrapper = `
import resource, subprocess, sys
p = subprocess.run([sys.executable, sys.argv[1], "--server", sys.argv[2], "--event-type", "Stop", "--add-chat"],
                   input=sys.argv[3].encode(), capture_output=True)
print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
`;
    const stdin = JSON.stringify({ session_id: "s1", transcript_path: tpath });
    // Async spawn: the fake server shares this event loop, a sync one would starve it.
    const proc = Bun.spawn([python!, "-c", wrapper, HOOK, `http://127.0.0.1:${s.port}`, stdin], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const rssKb = Number(out.trim());
    console.log("peak RSS KB", rssKb);
    expect(rssKb).toBeGreaterThan(0);
    expect(rssKb).toBeLessThan(64 * 1024);
    expect(got).not.toBeNull();
    expect(got.hook_event_type).toBe("Stop");
    expect(got.model_name).toBe("claude-sonnet-5-5");
    const sum = (k: string) => got.chat.reduce((a: number, c: any) => a + (c.message.usage[k] ?? 0), 0);
    expect(sum("input_tokens")).toBe(2 * TURNS);
    expect(sum("output_tokens")).toBe(3 * TURNS);
    expect(sum("cache_read_input_tokens")).toBe(4 * TURNS);
  }, 180_000);
});

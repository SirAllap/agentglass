/*
 * `trace stop` HAS TO LEAVE A FILE.
 *
 * Measured on the running app: `trace start`, a busy loop, then
 * `trace stop /tmp/x.json` answered
 *
 *     {"path": "/home/…/trace.json"}
 *
 * and `ls` could not find it. `traceRecording` made the parent directory and
 * returned the path — it never asked the browser for anything at all. The
 * comment at its call site said "the window will have already collected and
 * saved the trace data", about work that nothing did.
 *
 * The class of bug is one this codebase has now met nine times: an answer that
 * describes an effect nobody produced. So this drives the real function with a
 * stubbed browser and asserts the FILE.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceRecording, __setBrowserAsker } from "../src/browserdrive.ts";

let dir: string | null = null;
const scratch = () => (dir ??= mkdtempSync(join(tmpdir(), "agx-trace-")));

afterEach(() => {
  __setBrowserAsker(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A browser that ends the trace, then hands the stream over in two reads. */
function fakeBrowser(body: string, opts: { chunks?: number; base64?: boolean } = {}) {
  const chunks = opts.chunks ?? 2;
  const parts: string[] = [];
  const size = Math.ceil(body.length / chunks);
  for (let i = 0; i < chunks; i++) parts.push(body.slice(i * size, (i + 1) * size));
  let read = 0;
  let ended = false;
  const seen: string[] = [];
  return {
    seen,
    ask: async (ask: { op: string; args: Record<string, unknown> }) => {
      const method = String(ask.args.method ?? (ask.args.events ? "(drain)" : ""));
      seen.push(method);
      if (method === "Tracing.end") { ended = true; return { ok: true, value: {} }; }
      if (ask.args.events) {
        /* The handle only exists once the trace has ended — a drain before
           that must not hand one over, or the read loop starts on nothing. */
        return { ok: true, value: { events: ended ? [{ method: "Tracing.tracingComplete", params: { stream: "h1" } }] : [] } };
      }
      if (method === "IO.read") {
        const part = parts[read] ?? "";
        read++;
        const data = opts.base64 ? Buffer.from(part, "utf8").toString("base64") : part;
        return { ok: true, value: { result: { data, eof: read >= parts.length, base64Encoded: !!opts.base64 } } };
      }
      if (method === "IO.close") return { ok: true, value: {} };
      return { ok: true, value: {} };
    },
  };
}

describe("stopping a trace", () => {
  test("writes what the browser streamed back, in order", async () => {
    const body = JSON.stringify({ traceEvents: [{ name: "a" }, { name: "b" }] });
    const b = fakeBrowser(body, { chunks: 3 });
    __setBrowserAsker(b.ask);
    const at = join(scratch(), "deep", "trace.json");

    const r = await traceRecording({ path: at });
    expect(r.ok).toBe(true);
    expect(existsSync(at), "the whole point of the verb").toBe(true);
    expect(readFileSync(at, "utf8")).toBe(body);
    /* And the parent directory was made, which is the one thing the old
       version did do. */
    expect((r.value as { bytes?: number }).bytes).toBe(Buffer.byteLength(body));
  });

  test("decodes a base64 stream", async () => {
    const body = '{"traceEvents":[]}';
    __setBrowserAsker(fakeBrowser(body, { base64: true }).ask);
    const at = join(scratch(), "b64.json");
    await traceRecording({ path: at });
    expect(readFileSync(at, "utf8")).toBe(body);
  });

  test("closes the stream, even though the read succeeded", async () => {
    /* A handle left open holds the whole trace in the browser's memory for as
       long as the tab lives. */
    const b = fakeBrowser('{"traceEvents":[]}');
    __setBrowserAsker(b.ask);
    await traceRecording({ path: join(scratch(), "t.json") });
    expect(b.seen).toContain("IO.close");
  });

  test("says so, and writes nothing, when the trace never finishes", async () => {
    /* The failure the old version could not have: no `tracingComplete`, so no
       handle, so no file — and the caller must be told rather than handed a
       path to something that is not there. */
    __setBrowserAsker(async (ask: { args: Record<string, unknown> }) => {
      if (ask.args.events) return { ok: true, value: { events: [] } };
      return { ok: true, value: {} };
    });
    const at = join(scratch(), "never.json");
    const r = await traceRecording({ path: at, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not finish");
    expect(r.error).toContain(at);
    expect(existsSync(at)).toBe(false);
  });

  test("and when the browser refuses to end it", async () => {
    __setBrowserAsker(async () => ({ ok: false, error: "no debugger" }));
    const at = join(scratch(), "refused.json");
    const r = await traceRecording({ path: at, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(existsSync(at)).toBe(false);
  });
});

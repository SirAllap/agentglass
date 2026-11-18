/*
 * `handoff --timeout` is a wall. A live `handoff ... --timeout 600` sat for
 * half an hour: the deadline lived only in the CLI's loop, a failed check
 * (a socket timeout is not a URLError, so it went past `call` as a traceback)
 * skipped the cancel, and the banner and the lifted glass stayed with nobody
 * waiting. Now the loop retries any failure until the deadline, always takes
 * the banner down, and the arm hands the panel the same deadline.
 *
 * The CLI's own `wait_for_person`, loaded as a module with `call` stubbed: no
 * server, no socket, so it runs where loopback is closed too.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;

const PROBE = String.raw`
import importlib.machinery, importlib.util, json, sys, time, types
loader = importlib.machinery.SourceFileLoader("agb", sys.argv[1])
spec = importlib.util.spec_from_loader("agb", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
mode = sys.argv[2]
calls = []
def fake(op, body, timeout=120):
    calls.append({"op": op, **body})
    if body.get("check"):
        if mode == "raise" and len(calls) == 1: raise TimeoutError("timed out")
        if mode == "panel": return {"ok": True, "value": {"state": "timeout"}}
        if mode == "takenover": return {"ok": True, "value": {"state": "takenover", "takenOver": True}}
        time.sleep(0.2); return {"ok": True, "value": {"state": "waiting"}}
    return {"ok": True, "value": {"state": "cancelled"}}
m.call = fake; m.open_browser_view = lambda: True
t = time.monotonic()
r = m.wait_for_person(types.SimpleNamespace(timeout=2), {"reason": "x", "timeoutMs": 2000, "page": "t1"}, {"ok": True})
print(json.dumps({"s": time.monotonic() - t, "res": r, "calls": calls}))
`;

async function probe(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "agx-handoff-"));
  const file = join(dir, "probe.py");
  writeFileSync(file, PROBE);
  const p = Bun.spawn(["python3", "-I", file, CLI, mode], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: "http://127.0.0.1:1", AGENTGLASS_BROWSER_STATE_DIR: join(dir, "st") },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(out.trim(), err).not.toBe("");
  return JSON.parse(out.trim().split("\n").pop()!) as { s: number; res: { ok: boolean; error?: string; value?: { state?: string } }; calls: Record<string, unknown>[] };
}

describe.skipIf(!HAVE_PY)("handoff --timeout", () => {
  test("ends at the deadline with a timeout result and takes the banner down", async () => {
    const r = await probe("wait");
    expect(r.s).toBeGreaterThan(1.8);
    expect(r.s).toBeLessThan(4);
    expect(r.res).toMatchObject({ ok: false, value: { state: "timeout" } });
    expect(r.res.error).toContain("nobody answered the handoff in 2 s");
    expect(r.calls.at(-1)).toMatchObject({ op: "handoff", cancel: true });
    // A check carries no deadline: that rides on the arm, which the server refuses elsewhere.
    expect(r.calls.filter((c) => c.check).every((c) => !("timeoutMs" in c) && !("reason" in c))).toBe(true);
  });
  test("a check that raises is asked again, not a traceback that leaves the banner up", async () => {
    const r = await probe("raise");
    expect(r.res).toMatchObject({ ok: false, value: { state: "timeout" } });
    expect(r.calls.filter((c) => c.check).length).toBeGreaterThan(1);
    expect(r.calls.at(-1)).toMatchObject({ cancel: true });
  });
  test("Take over ends the wait at once, as a failure that says so", async () => {
    const r = await probe("takenover");
    expect(r.s).toBeLessThan(1);
    expect(r.res).toMatchObject({ ok: false, value: { state: "takenover", takenOver: true } });
    expect(r.res.error).toContain("took this tab over");
  });
  test("the panel's deadline coming first is the same timeout", async () => {
    const r = await probe("panel");
    expect(r.s).toBeLessThan(1);
    expect(r.res).toMatchObject({ ok: false, value: { state: "timeout" } });
  });
});

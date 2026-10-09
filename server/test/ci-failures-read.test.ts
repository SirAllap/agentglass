/*
 * Reading one failed check through `gh`: the requests it makes, and what it does
 * with the answers GitHub gives that are not a log.
 *
 * Runs against a stub `gh` in a child process (the PATH `Bun.which` resolves is
 * the one the process started with), one that answers the way the real one does:
 * `api -i` puts the headers of the final response before the body, a log that
 * has expired is a 410, and a spent budget is a 403 that says so. Every call the
 * stub receives is written to a file, so "how many requests" is counted, not
 * assumed.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-ci-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ESC = "\x1b";
const BODY = [
  `﻿2026-10-01T10:00:00.0000000Z ##[group]Run cd server && bun test`,
  `2026-10-01T10:00:01.0000000Z ${ESC}[31merror${ESC}[0m: expect(received).toBe(expected)`,
  `2026-10-01T10:00:01.0000000Z Expected: 4`,
  `2026-10-01T10:00:01.0000000Z Received: 5`,
  `2026-10-01T10:00:01.0000000Z (fail) orbit board > keeps four lanes [3.10ms]`,
  `2026-10-01T10:00:02.0000000Z 1 tests failed:`,
  `2026-10-01T10:00:02.0000000Z (fail) orbit board > keeps four lanes [3.10ms]`,
].join("\n");
writeFileSync(join(dir, "body.txt"), BODY);
writeFileSync(join(dir, "ann-empty.json"), "[]");
writeFileSync(join(dir, "out-gate.json"), JSON.stringify({ title: "Required files check failed", summary: "missing checklist item: add a changelog entry", text: "" }));
writeFileSync(join(dir, "out-none.json"), JSON.stringify({ title: "", summary: "", text: "" }));
writeFileSync(join(dir, "ann-none.json"), JSON.stringify([{ annotation_level: "failure", path: ".github", start_line: 1, message: "Process completed with exit code 2." }]));

const stub = join(dir, "gh");
writeFileSync(stub, `#!/bin/sh
echo "$*" >> "$AGX_STUB_CALLS"
case "$*" in
  *"check-runs/"*"--jq"*) cat "$AGX_STUB_OUTPUT" ;;
  *annotations*) cat "$AGX_STUB_ANN" ;;
  *rate_limit*) echo 1790000000 ;;
  *"/logs"*)
    case "$AGX_STUB_MODE" in
      ok) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\nContent-Type: text/plain\\r\\n\\r\\n' "$(wc -c < "$AGX_STUB_BODY")"; cat "$AGX_STUB_BODY" ;;
      nolength) printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\n'; cat "$AGX_STUB_BODY" ;;
      big) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 64000000\\r\\n\\r\\n'; exec sleep 30 ;;
      notfound) printf 'HTTP/1.1 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      blob) printf 'HTTP/1.1 404 The specified blob does not exist.\\r\\nX-Ms-Error-Code: BlobNotFound\\r\\n\\r\\n<?xml version="1.0"?><Error><Code>BlobNotFound</Code></Error>'; echo "gh: The specified blob does not exist. (HTTP 404)" >&2; exit 1 ;;
      gone) printf 'HTTP/1.1 410 Gone\\r\\n\\r\\n{"message":"Gone"}'; echo "gh: Gone (HTTP 410)" >&2; exit 1 ;;
      limited) echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2; exit 1 ;;
      broken) echo "gh: Internal Server Error (HTTP 500)" >&2; exit 1 ;;
    esac ;;
esac
`);
chmodSync(stub, 0o755);

let nextJob = 7000;
async function read(mode: string, o: { ann?: string; out?: string; job?: string; force?: boolean; cap?: string } = {}) {
  const calls = join(dir, `calls-${mode}-${nextJob}.txt`);
  writeFileSync(calls, "");
  const job = o.job ?? String(++nextJob);
  const script = `import { checkFailures } from ${JSON.stringify(new URL("../src/prs.ts", import.meta.url).pathname)};
    console.log(JSON.stringify(await checkFailures("gh:acme/orbit", ${JSON.stringify(job)}, { attempt: 1, step: "Tests (server)" }, ${o.force ? "true" : "false"})));`;
  const t0 = Date.now();
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: {
      PATH: `${dir}:${process.env.PATH}`, HOME: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db"),
      AGX_STUB_CALLS: calls, AGX_STUB_MODE: mode, AGX_STUB_BODY: join(dir, "body.txt"), AGX_STUB_ANN: join(dir, o.ann ?? "ann-empty.json"), AGX_STUB_OUTPUT: join(dir, o.out ?? "out-gate.json"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect(err).not.toContain("error:");
  const lines = readFileSync(calls, "utf8").split("\n").filter(Boolean);
  return { got: JSON.parse(out.trim().split("\n").pop()!), lines, ms: Date.now() - t0 };
}

describe("a failed check, read through gh", () => {
  it("is two requests, passes the escape flag, and names the test", async () => {
    const { got, lines } = await read("ok");
    expect(got).toMatchObject({ ok: true, state: "read", source: "log", framework: "bun", requests: 2 });
    expect(got.failures.map((f: { title: string }) => f.title)).toEqual(["orbit board > keeps four lanes"]);
    expect(got.failures[0].excerpt).toContain("Expected: 4");
    expect(got.failures[0].excerpt).not.toContain(ESC);
    // exactly what GitHub was asked, nothing else
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("check-runs/");
    expect(lines[0]).toContain("/annotations");
    expect(lines[1]).toContain("api -i --allow-escape-sequences repos/acme/orbit/actions/jobs/");
    expect(got.readBytes).toBe(Buffer.byteLength(BODY));
  });

  it("opened again it is zero requests", async () => {
    const first = await read("ok", { job: "7777" });
    expect(first.lines).toHaveLength(2);
    const again = await read("ok", { job: "7777" });
    expect(again.lines).toHaveLength(0);
    expect(again.got).toMatchObject({ ok: true, cached: true, requests: 0 });
  });

  it("a response without a Content-Length is still read", async () => {
    const { got } = await read("nolength");
    expect(got).toMatchObject({ ok: true, state: "read", framework: "bun" });
  });

  it("a log over the cap is stopped at its headers: its size is known, the body is not downloaded", async () => {
    const { got, lines, ms } = await read("big");
    expect(got).toMatchObject({ ok: true, state: "toolarge", sizeBytes: 64_000_000, failures: [] });
    expect(lines).toHaveLength(2);
    // the stub would sleep 30 s: reaching here fast means it was killed, not waited for
    expect(ms).toBeLessThan(10_000);
  });

  it("an expired log (410) says so, falls back to the check's own output (a third request), and is kept", async () => {
    const { got, lines } = await read("gone", { job: "7788" });
    expect(got).toMatchObject({ ok: true, state: "expired", source: "output", requests: 3 });
    expect(lines).toHaveLength(3);
    expect((await read("gone", { job: "7788" })).lines).toHaveLength(0);
  });

  it("an expired log still shows what the annotations kept", async () => {
    writeFileSync(join(dir, "ann-lint.json"), JSON.stringify([{ annotation_level: "failure", path: "web/src/board.ts", start_line: 12, message: "'lane' is assigned a value but never used" }]));
    const { got } = await read("gone", { ann: "ann-lint.json" });
    expect(got).toMatchObject({ ok: true, state: "expired", source: "annotations" });
    expect(got.failures[0].title).toBe("web/src/board.ts:12");
  });

  it("a spent budget is reported with the time it comes back, and is not kept", async () => {
    const { got, lines } = await read("limited", { job: "7799" });
    expect(got).toMatchObject({ ok: false, kind: "budget", resetAt: 1_790_000_000_000 });
    expect(lines.some((l) => l.includes("rate_limit"))).toBe(true); // the free probe that says when
    const later = await read("ok", { job: "7799" });
    expect(later.got).toMatchObject({ ok: true, cached: false });
  });

  it("any other failure is an error with GitHub's own words, and is not kept", async () => {
    const { got } = await read("broken", { job: "7800" });
    expect(got).toMatchObject({ ok: false, kind: "error" });
    expect(got.error).toContain("500");
  });

  it("refuses a job id that is not a number, before any request", async () => {
    const { got, lines } = await read("ok", { job: "12abc" });
    expect(got).toMatchObject({ ok: false, kind: "error", error: "invalid job" });
    expect(lines).toHaveLength(0);
  });

  it("a 404 on the log is a check an app posted: it shows the check's own message, not GitHub's error", async () => {
    const { got, lines } = await read("notfound");
    expect(got).toMatchObject({ ok: true, state: "nolog", source: "output", requests: 3 });
    expect(got.failures[0]).toMatchObject({ kind: "output", title: "Required files check failed" });
    expect(got.failures[0].excerpt).toContain("missing checklist item");
    expect(JSON.stringify(got)).not.toContain("HTTP 404");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("check-runs/");
  });

  it("no log and no message: it says there is nothing, in the state, with no error", async () => {
    const { got } = await read("notfound", { out: "out-none.json" });
    expect(got).toMatchObject({ ok: true, state: "nolog", source: "none", failures: [] });
  });

  it("a job whose log blob does not exist is a real job with no log, not an app's check", async () => {
    writeFileSync(join(dir, "ann-runner.json"), JSON.stringify([{ annotation_level: "failure", path: ".github", start_line: 1, message: "The self-hosted runner lost communication with the server." }]));
    const { got, lines } = await read("blob", { ann: "ann-runner.json" });
    expect(got).toMatchObject({ ok: true, state: "unlogged", source: "annotations", requests: 2 });
    expect(got.failures[0].title).toContain("self-hosted runner lost communication");
    expect(JSON.stringify(got)).not.toContain("HTTP 404");
    expect(lines).toHaveLength(2); // the annotation was enough: no output request
  });
});

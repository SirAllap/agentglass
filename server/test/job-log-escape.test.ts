/*
 * The log of a CI job, read through `gh api`.
 *
 * Two things were wrong with it, both measured on a real bun run of this
 * repository (1.15 MB):
 *
 *   1. `gh api` refuses to print a response that holds terminal escape
 *      sequences and exits non-zero ("pass --allow-escape-sequences"). Every
 *      bun log has them, so the panel showed an error instead of a log.
 *   2. It kept the last 400 KB. Bun prints each failure's detail where it
 *      happens and only a name list at the end: the detail sat near 290 KB, the
 *      tail started at 775 KB, and the one thing the panel exists to show was
 *      cut off. pytest and django print their detail before their summary too.
 *
 * The shaping is a pure function so the long-log cases can be asserted without
 * a network; the call itself runs against a stub `gh` in a child process, one
 * that refuses exactly like the real one does when the flag is missing.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shapeJobLog } from "../src/prs.ts";

const ESC = "\x1b";
const MAX = 400_000;
const filler = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `2026-10-01T10:00:00.0000000Z ${tag} line ${i} nothing to see here`).join("\n");

describe("escape sequences in what the app shows", () => {
  it("strips colour, cursor and title sequences and keeps the words", () => {
    const raw = `${ESC}[31mred${ESC}[0m plain ${ESC}[1;32mgreen${ESC}[m ${ESC}]0;a title\x07done ${ESC}[2K${ESC}[1Gtail`;
    const out = shapeJobLog(raw, MAX);
    expect(out.text).toBe("red plain green done tail");
    expect(out.truncated).toBe(false);
  });

  it("leaves no ESC byte behind, even a lone one", () => {
    expect(shapeJobLog(`a${ESC}b${ESC}`, MAX).text).not.toContain(ESC);
  });
});

describe("a log that fits", () => {
  it("comes back whole and not truncated", () => {
    const raw = "(fail) one\nok\n";
    expect(shapeJobLog(raw, MAX)).toEqual({ text: raw, truncated: false });
  });
});

describe("a long log whose detail is in the middle", () => {
  // Invented content, the shape of a real one: a long quiet start, the failure
  // with its detail, a long run of passing tests, then a summary name list.
  const detail = "error: expect(received).toBe(expected)\n  Expected: 3\n  Received: 4\n(fail) orbit lands on the pad [2.10ms]";
  const raw = [filler(3_000, "setup"), detail, filler(9_000, "later"), "1 fail\n(fail) orbit lands on the pad"].join("\n");

  it("is long enough to be cut", () => {
    expect(raw.length).toBeGreaterThan(MAX * 1.5);
    // the old behaviour, to show the test would have failed: the tail alone loses it
    expect(raw.slice(raw.length - MAX)).not.toContain("Expected: 3");
  });

  it("keeps the detail that the tail would have cut", () => {
    const out = shapeJobLog(raw, MAX);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("Expected: 3");
    expect(out.text).toContain("Received: 4");
  });

  it("keeps the tail too, and says what is missing between them", () => {
    const out = shapeJobLog(raw, MAX);
    expect(out.text.endsWith("1 fail\n(fail) orbit lands on the pad")).toBe(true);
    expect(out.text.split("characters of the log are not shown").length - 1).toBe(2); // before the region, and between
  });

  it("stays inside the cap", () => {
    expect(shapeJobLog(raw, MAX).text.length).toBeLessThanOrEqual(MAX);
  });

  it("starts on a whole line", () => {
    // the first line is the note that something was skipped before it
    const first = shapeJobLog(raw, MAX).text.split("\n")[1]!;
    expect(first.startsWith("2026-10-01T10:00:00.0000000Z")).toBe(true);
  });

  it("works through the escape sequences a real log carries", () => {
    const coloured = raw.replace("(fail) orbit lands on the pad [", `${ESC}[31m(fail)${ESC}[0m orbit lands on the pad [`);
    const out = shapeJobLog(coloured, MAX);
    expect(out.text).toContain("Expected: 3");
    expect(out.text).not.toContain(ESC);
  });

  it("finds the other runners' markers too", () => {
    for (const marker of ["##[error]Process failed", "Traceback (most recent call last):", "FAILED tests/test_pad.py::test_land", "E   assert 3 == 4"]) {
      const log = [filler(3_000, "setup"), marker, "the detail that must survive", filler(9_000, "later"), "summary"].join("\n");
      const out = shapeJobLog(log, MAX);
      expect(out.text).toContain("the detail that must survive");
    }
  });
});

describe("a long log whose failure is already at the end", () => {
  it("is the tail, as before", () => {
    const raw = [filler(12_000, "setup"), "(fail) late one", "error: boom", filler(20, "end")].join("\n");
    const out = shapeJobLog(raw, MAX);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe(raw.slice(raw.length - MAX));
    expect(out.text).not.toContain("not shown");
  });

  it("is the tail when nothing in the log looks like a failure", () => {
    const raw = filler(12_000, "quiet");
    expect(shapeJobLog(raw, MAX).text).toBe(raw.slice(raw.length - MAX));
  });
});

describe("a failure whose lead-in is cut by the tail window", () => {
  it("keeps the failure's detail and the tail, with the gap between them", () => {
    // The marker sits inside the tail window but so close to its start that
    // the lines leading up to it would be cut: the tail alone shows a failure
    // with no context.
    const after = filler(4_700, "mid"); // ~300 KB after the marker
    const raw = [filler(3_000, "setup"), "(fail) near the edge", "detail near the edge", after].join("\n");
    expect(raw.length).toBeGreaterThan(MAX);
    const out = shapeJobLog(raw, MAX);
    expect(out.text).toContain("(fail) near the edge");
    expect(out.text).toContain("detail near the edge");
    expect(out.text.length).toBeLessThanOrEqual(MAX);
    expect(out.text.endsWith(after.slice(-200))).toBe(true);
  });
});

describe("jobLog against a gh that guards escape sequences", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-joblog-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const stub = join(dir, "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
# gh api refuses a body with ESC bytes unless it is asked to allow them.
case " $* " in
  *" --allow-escape-sequences "*) printf '\\033[31m(fail)\\033[0m orbit lands on the pad\\nerror: boom\\n' ;;
  *) echo "the response contains terminal escape sequences; pass --allow-escape-sequences to print them" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(stub, 0o755);

  it("passes the flag and shows the log without its escape bytes", async () => {
    const script = `import { jobLog } from ${JSON.stringify(new URL("../src/prs.ts", import.meta.url).pathname)};
      console.log(JSON.stringify(await jobLog("gh:acme/orbit", "4242")));`;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(err).not.toContain("error:");
    const got = JSON.parse(out.trim().split("\n").pop()!);
    expect(got.ok).toBe(true);
    expect(got.text).toBe("(fail) orbit lands on the pad\nerror: boom\n");
  });
});

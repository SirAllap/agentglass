/*
 * The first-run hint that was always empty.
 *
 * All three agents that spawn a CLI — chat.ts, codex.ts, antigravity.ts — carry
 * a watchdog for the same failure: a `claude`/`codex`/`agy` that has never been
 * logged in blocks on an interactive prompt it can never receive here, so it
 * emits nothing and never exits. The watchdog gives up after the startup window
 * and tells the user what to run, and it tried to include whatever the CLI had
 * said on stderr, which is the part that says *why*.
 *
 * It read that hint like this:
 *
 *     const hint = (await Promise.race([stderrText, Promise.resolve("")])).trim();
 *
 * `Promise.resolve("")` is already resolved. The race is settled in the same
 * microtask in favour of the empty string, every time, whatever stderr holds —
 * so `hint` was unconditionally "" and every user got the generic fallback.
 *
 * The reason a race was reached for at all is real: `stderrText` only resolves
 * when the pipe closes, and a child hung on a login prompt holds it open
 * forever, so awaiting it outright would have hung the watchdog instead. Both
 * halves are needed, which is what drainStderr provides — and what these tests
 * hold in place, because reintroducing either failure leaves everything else
 * green.
 *
 * No real CLI is spawned: a ReadableStream is the same thing `proc.stderr` is,
 * and it can be held open on purpose, which a login prompt cannot be asked to
 * do on demand.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drainStderr } from "../src/chat.ts";

const enc = new TextEncoder();

/** A stderr pipe under test control: `push` is the child writing, `close` is it
 *  exiting. Never closing is the case that matters. */
function pipe() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return {
    stream,
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
    fail: (e: unknown) => ctl.error(e),
  };
}

/** Let the drain loop run. It reads in microtasks, so anything pushed is
 *  readable a tick later — the watchdog fires seconds after the spawn, so this
 *  is far more demanding than the real timing. */
const settle = () => Bun.sleep(1);

describe("stderr while the child is still running", () => {
  test("what the CLI said is readable before it exits", async () => {
    // The whole bug in one assertion. This is the shape of the real failure:
    // the CLI complains on stderr and then sits there, so the pipe stays open
    // and only `soFar` can answer.
    const p = pipe();
    const stderr = drainStderr(p.stream);
    p.push("Invalid API key · Please run /login\n");
    await settle();

    expect(stderr.soFar().trim()).toBe("Invalid API key · Please run /login");
  });

  test("reading it does not wait for the pipe to close", async () => {
    // The reason the original code raced against something. If `soFar()` ever
    // becomes a promise on `all`, this hangs instead of failing, so the timeout
    // is the assertion.
    const p = pipe();
    const stderr = drainStderr(p.stream);
    p.push("waiting for login");
    await settle();

    const raced = await Promise.race([
      Promise.resolve(stderr.soFar()),
      Bun.sleep(500).then(() => "TIMED OUT"),
    ]);
    expect(raced).toBe("waiting for login");
  });

  test("nothing said yet reads as empty rather than throwing", async () => {
    // The watchdog calls this unconditionally. A clean CLI that is merely slow
    // has written nothing at all.
    const stderr = drainStderr(pipe().stream);
    expect(stderr.soFar()).toBe("");
  });

  test("chunks arriving separately are joined in order", async () => {
    // A pipe delivers what it delivers; one line can land in two reads.
    const p = pipe();
    const stderr = drainStderr(p.stream);
    p.push("first ");
    await settle();
    p.push("second");
    await settle();

    expect(stderr.soFar()).toBe("first second");
  });

  test("a multi-byte character split across two chunks is not corrupted", async () => {
    // These messages carry `·` and `—`, and the CLIs are not shy about accents.
    // A decoder called per chunk without `stream: true` turns a split UTF-8
    // sequence into replacement characters.
    const bytes = enc.encode("café ☕");
    const cut = 4; // mid-sequence: the é is two bytes, and this lands inside it
    const stderr = drainStderr(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); },
    }));

    expect(await stderr.all).toBe("café ☕");
  });
});

describe("stderr once the child is gone", () => {
  test("the exit path still gets all of it", async () => {
    // The other caller: a non-zero exit reports stderr verbatim, and that one
    // does want to wait for the close.
    const p = pipe();
    const stderr = drainStderr(p.stream);
    p.push("line one\n");
    p.push("line two\n");
    p.close();

    expect(await stderr.all).toBe("line one\nline two\n");
  });

  test("a broken pipe yields what arrived instead of rejecting", async () => {
    // `all` is awaited on the error path, which is the worst moment for it to
    // reject: an unhandled rejection there would replace the exit report with a
    // crash. Whatever was said before the break is still the best answer
    // available.
    const p = pipe();
    const stderr = drainStderr(p.stream);
    p.push("said this much, then the pipe broke");
    await settle();
    p.fail(new Error("pipe closed by peer"));

    expect(await stderr.all).toBe("said this much, then the pipe broke");
  });
});

/*
 * And a lock on the call sites, which is where the bug actually was.
 *
 * Everything above tests the helper. None of it would have caught the original
 * defect: `drainStderr` can be perfect and a watchdog can still race it against
 * an already-resolved promise, exactly as three of them did. The turn that
 * would catch it cannot be exercised without spawning a real CLI and waiting
 * out its startup window, so the check is on the source — the same reasoning as
 * hook-tdz.test.ts.
 */
const SRC = join(import.meta.dir, "..", "src");
/** The three agents that spawn a CLI and watch it for a first byte. */
const AGENTS = ["chat.ts", "codex.ts", "antigravity.ts"];

describe("how the watchdogs read stderr", () => {
  for (const file of AGENTS) {
    const src = readFileSync(join(SRC, file), "utf8");
    // Comments explain the trap by quoting it, and a quotation is not a call.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // Asserted as booleans rather than with toContain: a failure here should
    // read as one line, not as this repo's largest source file inlined into the
    // diff.
    test(`${file} asks for what arrived, not for the whole stream`, () => {
      expect(code.includes("stderr.soFar()"), `${file} should read the hint from stderr.soFar()`).toBe(true);
    });

    test(`${file} does not race stderr against an already-settled promise`, () => {
      // The exact shape that made the hint unconditionally empty. A race whose
      // other runner is `Promise.resolve(...)` is not a race.
      const raced = /Promise\.race\(\[[^\]]*Promise\.resolve\(/.test(code);
      expect(raced, `${file} races stderr against an already-resolved promise — the hint will always be empty`).toBe(false);
    });

    test(`${file} still drains from the start`, () => {
      // The half that was never broken, and the reason a naive `await` is not
      // the fix: an undrained pipe fills at ~64KB and blocks the child forever.
      expect(code.includes("drainStderr("), `${file} should drain stderr from the start`).toBe(true);
    });
  }
});

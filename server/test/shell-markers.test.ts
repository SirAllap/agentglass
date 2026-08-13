/*
 * Reading a command out of the terminal — #297.
 *
 * The cockpit has a real PTY and it was the one place work happened that
 * produced no telemetry: which command failed, how long it took and where it
 * ran were all things you had to read a wall of text to find out.
 *
 * The rejected alternative is scraping prompts out of the pane, and the reason
 * to reject it is that it breaks silently. So the tests that matter here are
 * the ones about *not* being fooled: a chunk boundary in the middle of a
 * marker, a command that prints something marker-shaped, an unterminated
 * sequence in a stream of binary. Every one of those looks like working
 * software right up until the number is wrong.
 */
import { describe, expect, test } from "bun:test";
import { ShellMarkers, commandName, type ShellCommand } from "../src/shellparse.ts";

const enc = new TextEncoder();

/** A clock that only moves when a test says so — duration is the whole point
 *  of this feature, and `toBeGreaterThan(0)` passes with a broken timer. */
function harness() {
  const got: ShellCommand[] = [];
  let t = 1_000;
  const m = new ShellMarkers((c) => got.push(c), () => t);
  return {
    got, m,
    feed: (s: string) => m.feed(enc.encode(s)),
    /** Feed in n-byte chunks, to put a boundary everywhere in turn. */
    feedSplit: (s: string, n: number) => {
      const b = enc.encode(s);
      for (let i = 0; i < b.length; i += n) m.feed(b.slice(i, i + n));
    },
    tick: (ms: number) => { t += ms; },
  };
}

const START = (cmd: string) => `\x1b]633;E;${cmd}\x07\x1b]133;C\x07`;
const END = (code: number | string) => `\x1b]133;D;${code}\x07`;
const PROMPT = (cwd = "/home/you/code") => `\x1b]133;A\x07\x1b]7;file://box${cwd}\x07\x1b]133;B\x07`;

describe("one command, start to finish", () => {
  test("its text, its exit code, how long it took and where it ran", () => {
    const h = harness();
    h.feed(PROMPT("/home/you/code/shop-api"));
    h.feed(START("bun test"));
    h.tick(4200);
    h.feed("some output\r\n");
    h.feed(END(1));
    expect(h.got).toHaveLength(1);
    expect(h.got[0]).toMatchObject({
      command: "bun test", exit: 1, duration_ms: 4200, cwd: "/home/you/code/shop-api",
    });
  });

  test("timed from when output began, not from the prompt", () => {
    // What somebody wants to know is how long the machine took. Timing from the
    // prompt would fold in however long they spent typing, which on a slow
    // morning is most of it.
    const h = harness();
    h.feed(PROMPT());
    h.tick(30_000); // staring at the screen
    h.feed(START("make build"));
    h.tick(900);
    h.feed(END(0));
    expect(h.got[0]!.duration_ms).toBe(900);
  });

  test("a success and a failure are told apart by the shell, not by the output", () => {
    const h = harness();
    for (const code of [0, 1, 127, 130]) {
      h.feed(PROMPT()); h.feed(START(`cmd-${code}`)); h.feed(END(code));
    }
    expect(h.got.map((c) => c.exit)).toEqual([0, 1, 127, 130]);
  });

  test("and an exit code that is not a number is unknown rather than zero", () => {
    // Zero is "it worked". Guessing it for a marker we could not read would
    // turn a broken integration into a wall of green.
    const h = harness();
    h.feed(PROMPT()); h.feed(START("x")); h.feed(END("weird"));
    expect(h.got[0]!.exit).toBeNull();
  });
});

describe("what a chunked stream does to a parser", () => {
  test("a marker split across reads is still one marker", () => {
    /*
     * The failure this exists for. A pty hands over whatever the kernel had, so
     * `\x1b]133;` can arrive in one read and `D;0\x07` in the next — and a
     * parser written as a regex over each chunk sees neither. It does not crash;
     * it silently records nothing, which is the worst way to be wrong.
     */
    for (const size of [1, 2, 3, 5, 7, 13]) {
      const h = harness();
      const stream = PROMPT() + START("git push --force") + "output\r\n" + END(128);
      h.feedSplit(stream, size);
      expect(h.got, `split every ${size} bytes`).toHaveLength(1);
      expect(h.got[0]).toMatchObject({ command: "git push --force", exit: 128 });
    }
  });

  test("ST terminates as well as BEL, because both are in the wild", () => {
    // A parser that knew only one would silently ignore half the terminals it
    // will meet.
    const h = harness();
    h.feed(`\x1b]633;E;ls\x1b\\\x1b]133;C\x1b\\`);
    h.tick(12);
    h.feed(`\x1b]133;D;0\x1b\\`);
    expect(h.got).toHaveLength(1);
    expect(h.got[0]).toMatchObject({ command: "ls", exit: 0, duration_ms: 12 });
  });

  test("an unterminated sequence is abandoned rather than buffered forever", () => {
    // `\x1b]` in the middle of binary output, with no terminator ever. Holding
    // on to it is a memory leak with an entirely plausible cause: somebody cats
    // a binary.
    const h = harness();
    h.feed("\x1b]");
    h.feed("x".repeat(200_000));
    // …and the parser still works afterwards, which is the part that matters.
    h.feed(PROMPT()); h.feed(START("echo ok")); h.feed(END(0));
    expect(h.got).toHaveLength(1);
  });

  test("and garbage never throws, because this runs on somebody's terminal", () => {
    const h = harness();
    for (let i = 0; i < 2000; i++) {
      h.m.feed(new Uint8Array([i % 256, (i * 7) % 256, 0x1b, 0x5d, i % 128]));
    }
    h.feed(PROMPT()); h.feed(START("echo ok")); h.feed(END(0));
    expect(h.got.at(-1)).toMatchObject({ command: "echo ok" });
  });
});

describe("what is deliberately not recorded", () => {
  test("an empty line at the prompt is not a command that ran in 0ms", () => {
    // Pressing return at a prompt emits a finish with no start. Recording it
    // would fill the history with rows nobody can act on.
    const h = harness();
    h.feed(PROMPT());
    h.feed(END(0));
    expect(h.got).toEqual([]);
  });

  test("nor is a command the shell gave us no text for", () => {
    // It has a duration and an exit code and nothing to call it.
    const h = harness();
    h.feed(PROMPT());
    h.feed("\x1b]133;C\x07");
    h.feed(END(0));
    expect(h.got).toEqual([]);
  });

  test("a long command line is clipped, not lost", () => {
    /*
     * A `curl` with an inline JSON body is a real thing people type, and it is
     * exactly the sort of line somebody later wants to know failed. An earlier
     * cap on the partial-sequence buffer was smaller than that, so the whole
     * command was abandoned mid-marker and disappeared from the history — the
     * long lines dropped and the short ones kept, which is the wrong way round.
     */
    const h = harness();
    h.feed(PROMPT()); h.feed(START("curl -d " + "x".repeat(20_000))); h.feed(END(1));
    expect(h.got).toHaveLength(1);
    expect(h.got[0]!.command.startsWith("curl -d")).toBe(true);
    expect(h.got[0]!.command.length).toBeLessThan(500);
    expect(h.got[0]!.exit).toBe(1);
  });

  test("and something absurd is abandoned without taking the parser with it", () => {
    // Past any plausible command line this stops being a command and starts
    // being a memory leak with an entirely plausible cause.
    const h = harness();
    h.feed(PROMPT()); h.feed(START("x".repeat(500_000))); h.feed(END(0));
    h.feed(PROMPT()); h.feed(START("echo still here")); h.feed(END(0));
    expect(h.got.at(-1)).toMatchObject({ command: "echo still here" });
  });
});

describe("what the shell says about itself between commands", () => {
  test("busy is true while something is running and false at the prompt", () => {
    // The question #4's alternate-screen check could never answer, and the one
    // a "run this command" button actually needs.
    const h = harness();
    expect(h.m.busy).toBe(false);
    h.feed(PROMPT());
    h.feed(START("sleep 10"));
    expect(h.m.busy).toBe(true);
    h.feed(END(0));
    expect(h.m.busy).toBe(false);
  });

  test("the directory follows the shell, including after a cd", () => {
    const h = harness();
    h.feed(PROMPT("/home/you"));
    expect(h.m.directory).toBe("/home/you");
    h.feed(START("cd code/shop-api")); h.feed(END(0));
    h.feed(PROMPT("/home/you/code/shop-api"));
    expect(h.m.directory).toBe("/home/you/code/shop-api");
  });

  test("and a path with a space in it survives the URL it travelled in", () => {
    // OSC 7 carries a file:// URL, so the path arrives percent-encoded. A
    // parser that forgot to decode reports a directory nobody has.
    const h = harness();
    h.feed(`\x1b]7;file://box/Users/you/My%20Code\x07`);
    expect(h.m.directory).toBe("/Users/you/My Code");
  });
});

describe("what a command is filed under", () => {
  test("the program, not the whole line", () => {
    // Otherwise the tool-mix pane gets one bucket per distinct command line and
    // says nothing about anything.
    expect(commandName("git push --force origin main")).toBe("git");
    expect(commandName("bun test --watch")).toBe("bun");
  });

  test("with the wrappers stepped over", () => {
    // Filing every privileged command under "sudo" answers no question anybody
    // has, and `FOO=bar cmd` is a `cmd`.
    expect(commandName("sudo systemctl restart nginx")).toBe("systemctl");
    expect(commandName("NODE_ENV=test bun test")).toBe("bun");
    expect(commandName("env FOO=1 sudo make install")).toBe("make");
  });

  test("and a full path is the same program as its bare name", () => {
    expect(commandName("/usr/local/bin/bun run build")).toBe("bun");
    expect(commandName("./scripts/deploy.sh")).toBe("deploy.sh");
  });

  test("an empty line names nothing rather than throwing", () => {
    expect(commandName("")).toBe("");
    expect(commandName("   ")).toBe("");
  });
});

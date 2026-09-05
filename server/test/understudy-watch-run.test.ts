/*
 * Watching the work happen, and the four ways that goes quietly wrong.
 *
 * A task is an agent with a shell for up to twenty-five minutes. It used to be
 * a hidden `Bun.spawn`, so the screen said "this takes as long as the task
 * does" and nothing else moved: no file, no step, no way to tell working from
 * stuck. It runs in a tmux window in the project's engine session now — the
 * same machinery every other pane in this application uses — and the panel
 * reads that window.
 *
 * These are asserted against the source rather than by opening a real window,
 * deliberately: each one is a property of the COMMAND that is built, and a
 * suite that needed tmux to check them would be skipped on the machine where
 * it matters most.
 */
import { describe, expect, test } from "bun:test";

/**
 * The end of the declaration that starts at `from`, for tests that read shape.
 *
 * Bounding a source slice by a character count is the thing that broke five
 * tests in one afternoon: every time, somebody had added a paragraph of
 * comment inside the function and pushed the assertion past the cut. A test
 * that fails because the code got better documented is one people delete.
 */
function endOfBlock(text: string, from: number): number {
  const close = text.indexOf("\n}", from);
  return close === -1 ? text.length : close;
}

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const runner = (() => {
  const from = src.indexOf("async function runAgentInPane(");
  expect(from, "the pane runner should exist").toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("\nasync function runAgentIn(", from));
})();

describe("the command that is built", () => {
  test("the exit code comes from the agent, not from tee", () => {
    /*
     * THE ONE THAT WOULD HAVE BEEN INVISIBLE. Through a pipe, `$?` is the exit
     * status of the LAST command — tee — which succeeds whatever the agent did.
     * Every run would have been recorded as finished, including the ones that
     * crashed, and the tests are the only thing that would have caught it
     * afterwards.
     */
    expect(runner).toContain("PIPESTATUS[0]");
    expect(runner).toContain('"bash", "-c"');   // PIPESTATUS is bash-only
  });

  test("the brief goes in a file, never on the command line", () => {
    // Thousands of characters of rules and precedents against a kernel limit
    // that varies by machine. On the command line, a brief that grew past it
    // would fail as something else entirely.
    expect(runner).toContain("brief.txt");
    expect(runner).toContain("< ${q(promptPath)}");
  });

  test("the transcript is teed, so the pane and the row both get it", () => {
    // A redirect would give the row its outcome and leave the pane blank,
    // which is the whole thing this was built to stop.
    expect(runner).toContain("| tee ");
  });

  test("every path in the command is quoted", () => {
    // A temporary directory is generated, but the worktree path is not: it
    // comes from a task title by way of a branch name.
    expect(runner).toContain("const q = (v: string)");
    expect(runner).toContain("q(outPath)");
    expect(runner).toContain("q(rcPath)");
  });
});

describe("the credential does not end up on a screen", () => {
  test("it reaches the window as environment, never through the command", () => {
    /*
     * The agent gets a minted read-only token. Built into the command it would
     * sit in `ps` output and be printed into the pane a person is watching —
     * and a pane is exactly the thing somebody screenshots.
     *
     * `p.env` goes to `engineWindowRunning`, which turns it into tmux `-e`; the
     * command line the pane runs is built from argv and paths only.
     */
    expect(runner).toContain("p.cwd, p.env,");
    /*
     * The command STRING only — comments in between are prose, and one of them
     * explains why the machine token is unset from the engine environment. An
     * assertion that reads the paragraph fails on the fix it describes.
     */
    const from = runner.indexOf("const line =");
    const line = runner.slice(from, runner.indexOf(";", runner.indexOf("rcPath)}`", from)));
    expect(line).not.toContain("TOKEN");
    expect(line).not.toContain("p.env");
  });

  test("and the caller hands over the two variables and the fence, nothing else", () => {
    // `-e` puts each variable on a tmux command line, so passing process.env
    // would put every secret this server holds there.
    const caller = src.slice(src.indexOf("async function runAgentIn("), src.indexOf("\n}\n", src.indexOf("async function runAgentIn(")));
    const call = caller.slice(caller.indexOf("runAgentInPane({"), caller.indexOf("if (watched)"));
    expect(call).toContain("AGENTGLASS_TOKEN: readToken, AGENTGLASS_READ_TOKEN: readToken }");
    expect(call).not.toContain("...process.env");
    /*
     * `...fenced` is the one other thing allowed on that line, and it is safe
     * to put there for the same reason it exists: every value in it is a path
     * to an empty directory, an empty string, or a git config key. It carries
     * no credential — it is what takes the credentials AWAY. Anything else
     * spread here would be a secret on a command line, which is what this
     * whole file is about.
     */
    const spreads = [...call.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    expect(spreads, `unexpected spread into the pane env: ${spreads.join(", ")}`).toEqual(["fenced"]);
  });
});

describe("when there is no tmux", () => {
  test("it returns null rather than refusing to work", () => {
    // The property, not the shape of the line: this asserted an exact
    // `if (!tmuxCapability().available) return null` and broke the moment the
    // reason had to be captured to report it.
    expect(runner).toContain("tmuxCapability()");
    const guard = runner.slice(runner.indexOf("tmuxCapability()"), runner.indexOf("mkdtempSync"));
    expect(guard, "no tmux means null, never a throw or a refusal").toContain("return null");
  });

  test("and the caller falls through to the hidden run", () => {
    const from = src.indexOf("async function runAgentIn(");
    const block = src.slice(from, src.indexOf("\n}\n", from));
    expect(block).toContain("if (watched) return watched;");
    expect(block, "the old path is still there as the fallback").toContain("Bun.spawn(argv");
  });
});

describe("the panes the panel may look at", () => {
  const watch = (() => {
    const from = src.indexOf('"/understudy/work/watch"');
    return src.slice(from, endOfBlock(src, from));
  })();

  test("the pane id is pinned to tmux's own shape", () => {
    // It goes on a command line, and `-t` accepts session and window names as
    // well as pane ids — anything looser here is choosing somebody else's
    // target rather than reading our own.
    expect(watch).toContain("/^%\\d{1,9}$/");
  });

  test("and it must be a pane this server opened for a live run", () => {
    /*
     * `watchedNow`, not `watchingPanes`: the guard and the list the panel is
     * handed have to be the SAME answer. They were not for one commit — the
     * list recovered panes from tmux after a restart and the guard only knew
     * this process's memory, so a pane the panel had just been given was
     * refused the moment it asked to read it.
     */
    expect(watch).toContain("watchedNow()");
    expect(watch).toContain("not a pane this is working in");
  });

  test("reading a pane cannot change anything", () => {
    expect(watch).toContain('req.method === "GET"');
    expect(watch).toContain("capture-pane");
  });
});

describe("a pane stops being offered when its run ends", () => {
  test("the list is filtered by the row, not by a delete elsewhere", () => {
    /*
     * `finishRun` writes the state whichever way a run ended, including the
     * paths that throw. Clearing the map by hand at each exit is right until
     * somebody adds a fourth way to finish — and then the tab points at a pane
     * that closed an hour ago.
     */
    const from = src.indexOf("export function watchingPanes(");
    const block = src.slice(from, endOfBlock(src, from));
    expect(block).toContain('r.state === "running"');
    expect(block).toContain("watching.delete(id)");
  });
});

describe("what closing the tab does", () => {
  test("the tab says what closing it does, and says the true thing", async () => {
    /*
     * THIS ASSERTION USED TO POINT THE OTHER WAY, at a screen that has been
     * removed. The old queue only advanced while its tab was open — a scan runs
     * in the browser's request — so it said "keeps looking while this tab is
     * open", and this test held it to that.
     *
     * The work loop is the opposite and it matters more, because a run is up to
     * twenty-five minutes long. `Loop.workOne` spawns a process on the SERVER;
     * closing the tab abandons the request and changes nothing about the work.
     * Somebody who believes the old sentence sits and watches a tab for half an
     * hour to avoid interrupting something that cannot be interrupted that way.
     */
    const ui = await Bun.file(new URL("../../web/src/components/understudy/Work.tsx", import.meta.url)).text();
    expect(ui).toContain("it does not stop when the tab does");

    // And the claim has to be true of the server, not just written on the
    // screen: the work is spawned, never awaited on the client's connection.
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    // The open paren: `runAgentInPane` shares this name as a prefix. And the
    // block runs to the end of the function rather than a fixed 1400
    // characters, which stopped reaching the spawn the moment a paragraph of
    // comment went in above it.
    const from = src.indexOf("async function runAgentIn(");
    const fn = src.slice(from, src.indexOf("\n}\n", from));
    /*
     * Either way the work outlives the request, and both are asserted because
     * either one alone would pass while the other quietly became something
     * tied to the connection. The window belongs to the tmux SERVER, and the
     * spawn is this process's own child; neither is the client's socket.
     */
    expect(fn, "the watched path hands the work to tmux").toContain("runAgentInPane({");
    expect(fn, "the fallback is still a spawn of our own").toContain("Bun.spawn(argv");
  });
});

describe("the fence that could be set and never read", () => {
  /*
   * `propose-scope` decides whether the task-tracker sources may offer work at
   * all. There was a route to CHANGE it and none to ask what it was, so the
   * switch that governs whether the clone reaches somebody's employer could
   * not be seen in the application — only set, with curl.
   *
   * That is the setting people most want to check before walking away from it,
   * and a fence whose position is invisible is one nobody can trust.
   */
  test("the work tab is told which way it is set", () => {
    const from = src.indexOf('"/understudy/work/ask" && req.method === "GET"');
    expect(from, "the fence route should exist").toBeGreaterThan(-1);
    expect(src.slice(from, endOfBlock(src, from))).toContain("scope: proposeScope()");
  });

  test("an unrecognised value reads as the narrow setting, not the wide one", async () => {
    /*
     * The direction a default has to fail in. A client that cannot make sense
     * of the answer must not conclude the fence is open — an unknown value is
     * unknown, and treating it as the widening is how a silent change of
     * vocabulary turns into the clone reading somebody's work.
     */
    const ui = await Bun.file(
      new URL("../../web/src/components/understudy/Work.tsx", import.meta.url),
    ).text();
    expect(ui).toContain('ab?.scope === "everywhere" ? "everywhere" : "open-only"');
  });
});

describe("when there is no pane, it says so", () => {
  /*
   * MEASURED THE FIRST TIME THIS RAN FOR REAL, and the twelve tests above did
   * not catch it because every one of them reads source text.
   *
   * An over-long TMUX_TMPDIR pushed the socket path past the 108 bytes a unix
   * socket allows. tmux answered "File name too long", `engineWindowRunning`
   * returned null, and the run carried on perfectly well in a hidden spawn —
   * which is the right behaviour. But the screen simply showed nothing, with
   * no way to tell "no pane yet" from "no pane ever". A silent fallback on the
   * one feature whose whole point is being able to watch is the wrong quiet.
   */
  test("both ways of having no pane report a reason", () => {
    const fn = src.slice(src.indexOf("async function runAgentInPane("),
      src.indexOf("\nasync function runAgentIn("));
    // No tmux at all, and tmux that would not open a window: two different
    // failures, and the second is the one a long socket path lands in.
    expect(fn).toContain("p.onNoPane?.(can.reason");
    expect(fn).toContain('p.onNoPane?.("tmux would not open a window for it")');
  });

  test("the run still happens — watching is not a precondition for working", () => {
    const fn = src.slice(src.indexOf("async function runAgentIn("), src.indexOf("\n}\n", src.indexOf("async function runAgentIn(")));
    expect(fn).toContain("if (watched) return watched;");
    expect(fn).toContain("Bun.spawn(argv");
  });

  test("and the tab prints the sentence instead of an empty box", async () => {
    const ui = await Bun.file(
      new URL("../../web/src/components/understudy/Work.tsx", import.meta.url),
    ).text();
    expect(ui).toContain("not where you can watch it");
    // And it says the work is fine, because it is: the two failures look
    // identical on screen otherwise.
    expect(ui).toContain("The run itself is unaffected");
  });
});

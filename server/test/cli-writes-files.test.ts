/**
 * The two verbs whose whole job is to put a file on disk must actually declare
 * and send what they need to do it.
 *
 * Both shipped broken, and both were found by somebody trying to use them
 * rather than by anything here:
 *
 *   `shot --out x.png`   exited 0, printed base64, wrote nothing.
 *   `record /tmp/dir`    refused every path with "dir must be an absolute
 *                        path" — for a path that was absolute and existed.
 *
 * Neither is a logic bug in the browser. `shot` read an option its parser never
 * declared, so it was always None; `record` had no branch building its request
 * at all, so `dir` — its one positional — was parsed and then dropped. A test
 * that only reads the server would pass on both, which is why this one reads
 * the CLI.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const CLI = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");

/** One `elif a.cmd == "<verb>":` branch, to the start of the next branch. */
function branch(verb: string): string {
  const at = CLI.indexOf(`a.cmd == "${verb}":`);
  expect(at, `${verb} has no branch building its request`).toBeGreaterThan(-1);
  const next = CLI.indexOf("\n    elif a.cmd", at + 10);
  return CLI.slice(at, next === -1 ? at + 3000 : next);
}

describe("a verb that writes a file", () => {
  test("shot DECLARES the --out it reads, under a dest of its own", () => {
    const at = CLI.indexOf('sub.add_parser("shot"');
    const parser = CLI.slice(at, CLI.indexOf('sub.add_parser("back"', at));
    expect(parser, "it read a.out for months without ever declaring it").toContain('"--out"');
    /* Its own dest: the top-level parser already owns `--out` as `outFile`, and
       sharing the namespace with it left this one None however it was spelled. */
    expect(parser, "a shared dest is how this was silently None").toContain('dest="shotOut"');
  });

  test("and it accepts the flag on EITHER side of the verb", () => {
    const at = CLI.indexOf('elif a.cmd == "shot":\n        png =');
    const next = CLI.indexOf("\n    else:", at);
    const body = CLI.slice(at, next === -1 ? at + 4000 : next);
    expect(body).toContain("shotOut");
    expect(body, "`--out x.png shot` reaches the global flag, and means the same thing").toContain("outFile");
  });

  /*
   * The verbs that return EARLY, and so never reached the tail of main() where
   * --out, --max-tokens and --summary are honoured. The help says "every verb
   * takes --max-tokens N, --out FILE and --summary", and `cdp --out file.json`
   * printed the whole answer to stdout, wrote nothing and exited 0 — the
   * caller pays for the payload in its context, which is the exact cost --out
   * exists to avoid, and finds no file where it was told one would be.
   */
  test("a verb that answers early still honours --out", () => {
    const at = CLI.indexOf('if a.cmd == "cdp":');
    const body = CLI.slice(at, CLI.indexOf('if a.cmd == "do":', at));
    expect(body, "cdp printed straight to stdout and skipped every output flag").toContain("emit(");
    expect(body, "a bare json.dumps here is the bug coming back").not.toContain("print(json.dumps(res");
  });

  test("and `emit` is the one place that decides where an answer goes", () => {
    const at = CLI.indexOf("def emit(");
    expect(at, "the shared output path was inlined at the bottom of main()").toBeGreaterThan(-1);
    const body = CLI.slice(at, CLI.indexOf("\ndef summarize(", at));
    for (const flag of ["maxTokens", "outFile", "summary"]) {
      expect(body, `emit ignores --${flag}`).toContain(flag);
    }
  });

  test("record sends the dir it was given", () => {
    const b = branch("record");
    expect(b, "THE SERVER REFUSED EVERY PATH because dir never arrived").toContain("a.dir");
    expect(b).toContain('"dir"');
    // And the rest of what its parser collects, or the flags are decoration.
    expect(b).toContain("a.frames");
    expect(b).toContain("a.every");
    expect(b).toContain("a.gif");
  });

  test("download sends its dir too — the same shape, and it always worked", () => {
    const b = branch("download");
    expect(b).toContain("a.dir");
  });
});

/**
 * Every flag `shot` declares must actually be SENT.
 *
 * Three separate flags shipped declared-but-never-sent, and each was found by
 * a person rather than by the suite: `--out` (read from a dest that was never
 * declared), `record`'s `dir` (no branch built its request at all), and
 * `--scale` (declared, validated server-side, never put in the body). One rule
 * covering the whole parser catches the fourth before anybody meets it.
 */
test("no flag on shot is decoration — each one reaches the request", () => {
  const parserAt = CLI.indexOf('sub.add_parser("shot"');
  const parser = CLI.slice(parserAt, CLI.indexOf('sub.add_parser("back"', parserAt));
  const at = CLI.indexOf('elif a.cmd == "shot":');
  /* Its own branch PLUS the shared block that runs for every verb just before
     the request goes out: `--page` is set there on purpose, so that the seventh
     verb to declare it cannot repeat the bug where six declared it and one sent
     it. Either place counts as sent. */
  const shared = CLI.slice(CLI.indexOf('if getattr(a, "observe", False):'), CLI.indexOf("res = call(a.cmd, body)"));
  const body = CLI.slice(at, CLI.indexOf("\n    elif a.cmd", at + 10)) + shared;

  /* dest= wins over the flag name when it is given, because that is the name
     the body has to read. */
  const flags = [...parser.matchAll(/add_argument\(\s*"--([a-z-]+)"(?:[^)]*?dest="([A-Za-z]+)")?/g)]
    .map((m) => m[2] || m[1]!.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

  expect(flags.length, "the shot parser moved").toBeGreaterThan(4);
  const missing = flags.filter((f) => {
    // `--out` is where the png is WRITTEN, not part of the request.
    if (f === "shotOut") return false;
    return !body.includes(`a.${f}`);
  });
  expect(missing, "declared on the command line and dropped before the request").toEqual([]);
});

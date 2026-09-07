/*
 * An exception's text is not an answer.
 *
 * `String(e)` in a catch reads like honesty and is not: a caught error carries
 * absolute paths on this machine, the shape of a directory tree, the argv of a
 * command, sometimes a stack — and on a machine a phone can reach, the caller
 * is not always the person sitting at it. CodeQL read one of these as
 * `js/stack-trace-exposure` (alert #55, `bench.ts` through `/bench/note`) and
 * there were eleven more of the same shape it had not traced.
 *
 * The rule now: a refusal this app decided is returned as itself, because the
 * sentence is written in this repository. A failure goes through `failed()`,
 * which logs the real error to this process's stderr and hands the caller a
 * sentence naming the operation.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(new URL(".", import.meta.url).pathname, "..", "src");

/** `error: String(e)` and its spellings, anywhere a value is handed back. */
const RAW = /\berror:\s*String\(\s*(e|err|ex|error)\s*\)/;

describe("what a caller is told when something threw", () => {
  test("no module hands back the text of a caught exception", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        if (RAW.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "use failed(where, e, said) from refused.ts: it logs the real error and answers with a sentence",
    ).toEqual([]);
  });

  test("failed() logs the real error and returns only the sentence", async () => {
    const { failed } = await import("../src/refused.ts");
    const saw: unknown[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { saw.push(a); };
    try {
      const said = failed("a/probe", new Error("ENOENT /home/somebody/.ssh/id_rsa"), "that file could not be read");
      expect(said).toBe("that file could not be read");
      expect(said).not.toContain("/home/");
      expect(saw.length, "the real error reaches stderr").toBe(1);
      // The Error itself, not a string of it: an Error JSON-stringifies to
      // `{}`, so the assertion has to look at the object that was logged.
      const logged = (saw[0] as unknown[])[1];
      expect(logged, "and it is the whole error, not the sentence").toBeInstanceOf(Error);
      expect((logged as Error).message).toContain("ENOENT");
    } finally { console.error = real; }
  });
});

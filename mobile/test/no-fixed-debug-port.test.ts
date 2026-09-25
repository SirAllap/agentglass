import { expect, test } from "bun:test";

/*
 * A Chrome this suite starts must ask for its debugging port by number 0. With a
 * fixed one, a Chromium left over from an earlier run held the port, this run's
 * own browser failed to bind, and the tests drove the leftover's page: three red
 * with no mention of a port. This asserts against source because the failure
 * needs a stranger on the port to show itself.
 */
test("no mobile test hands Chrome a fixed remote-debugging-port", async () => {
  const offenders: string[] = [];
  for (const path of new Bun.Glob("*.test.ts").scanSync(import.meta.dir)) {
    const text = await Bun.file(`${import.meta.dir}/${path}`).text();
    if (/remote-debugging-port=(?!0\b)[$\d{]/.test(text)) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});

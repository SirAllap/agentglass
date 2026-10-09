import { expect, test } from "bun:test";
import { Glob } from "bun";

// A do-nothing localStorage assigned straight onto the global outlives its file
// (bun runs every web test in one process), and the next file that installs
// one with `??=` inherits a storage that drops writes. stubStorage() installs
// the same stub and takes it away in afterAll.
test("no web test leaves a do-nothing localStorage behind", async () => {
  const bare = /localStorage\s*\?*=\s*\{[^}]*setItem:\s*\(\)\s*=>\s*\{\}/;
  const files = [...new Glob("test/*.ts").scanSync({ cwd: import.meta.dir + "/.." })];
  const texts = await Promise.all(files.map((f) => Bun.file(`${import.meta.dir}/../${f}`).text()));
  const offenders = files.filter((_, i) => bare.test(texts[i]));
  expect(offenders).toEqual([]);
});

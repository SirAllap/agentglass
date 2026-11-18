// The home index cap, in a file of its own: each index holds one worker thread in a blocking
// read of its inotify descriptor, so on a 2-CPU runner (a pool of two) a second index in the
// same process, next to homeindex.test.ts's shared one, never gets a thread for its readdir.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeIndex } from "../src/homeindex.ts";

describe("home index cap", () => {
  test("filled past its cap it keeps the cap, says so, and still finds what it holds", async () => {
    const big = mkdtempSync(join(tmpdir(), "agx-homecap-"));
    try {
      for (let i = 0; i < 50; i++) writeFileSync(join(big, `note-${i}.txt`), "x");
      const small = new HomeIndex(() => [big], () => "", 20);
      await small.search("x");
      await small.whenBuilt();
      const st = small.status();
      expect(st.entries).toBe(20);
      expect(st.capped).toBe(true);
      expect((await small.search("note")).hits.length).toBe(19); // the root is the 20th row, and is not a result
      // a new name past the cap is dropped, not a crash
      writeFileSync(join(big, "past-cap.txt"), "x");
      await Bun.sleep(200);
      expect(small.status().entries).toBe(20);
      // one delete in an already full index is not a reason to rescan it
      const builtAt = small.status().builtAt;
      rmSync(join(big, "note-1.txt"), { force: true });
      await Bun.sleep(200);
      await small.search("note");
      await small.whenBuilt();
      expect(small.status().builtAt).toBe(builtAt);
      small.close();
    } finally { rmSync(big, { recursive: true, force: true }); }
  });
});

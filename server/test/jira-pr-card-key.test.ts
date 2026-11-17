/* The board's card reads its Jira key on the server: a pull request re-pointed at a new card keeps the old key in its
   branch (renaming a head branch closes the pull request) and names the new one in brackets at the start of its title. */
import { describe, expect, test } from "bun:test";
import { readJiraRef } from "../src/jiraprcards.ts";

describe("the Jira key a pull request card names", () => {
  const keys = ["ORBIT"];
  test("a bracketed key opening the title beats the branch's", () => {
    expect(readJiraRef(keys, "ORBIT-882-Cache-serializer-to-JSON", "[ORBIT-1780] - Cache pickle to JSON step 2")).toBe("ORBIT-1780");
  });
  test("a key later in the title, or unbracketed, does not", () => {
    expect(readJiraRef(keys, "ORBIT-882-cache", "Cache to JSON, after ORBIT-1780")).toBe("ORBIT-882");
    expect(readJiraRef(keys, "ORBIT-882-cache", "ORBIT-1780 the sequel")).toBe("ORBIT-882");
  });
  test("with no key in the branch the title's still counts", () => {
    expect(readJiraRef(keys, "fix/cache", "Cache to JSON (ORBIT-1780)")).toBe("ORBIT-1780");
  });
});

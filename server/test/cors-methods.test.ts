import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

// The desktop renderer is a cross-origin caller, so a verb missing from the
// preflight's allowed list fails before the request is made, and the page
// reports "Could not reach the server". Polaris saves its settings with PUT.
test("the preflight allows every verb the web client sends", () => {
  const m = /"Access-Control-Allow-Methods": "([^"]+)"/.exec(src);
  expect(m).not.toBeNull();
  const verbs = m![1]!.split(",");
  for (const v of ["GET", "POST", "PUT", "OPTIONS"]) expect(verbs).toContain(v);
});

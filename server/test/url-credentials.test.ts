import { expect, test } from "bun:test";
import { hasUrlCredentials } from "../../shared/urlCredentials.ts";

// Built field by field so no address in this file has the user:secret@host shape.
function withParts(user: string, pw: string): URL {
  const u = new URL("https://example.test/");
  u.username = user;
  u.password = pw;
  return u;
}

test("an address with a user name, a password or both has credentials", () => {
  expect(hasUrlCredentials(withParts("orbit", ""))).toBe(true);
  expect(hasUrlCredentials(withParts("", "x"))).toBe(true);
  expect(hasUrlCredentials(withParts("orbit", "x"))).toBe(true);
});

test("a plain address, with a port or a query, has none", () => {
  expect(hasUrlCredentials(new URL("https://example.test:8443/a?b=1#c"))).toBe(false);
});

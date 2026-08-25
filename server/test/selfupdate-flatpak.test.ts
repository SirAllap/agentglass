// A Flatpak install updates through Flatpak. /app is mounted read-only, so
// self-update.sh would fetch a release and then fail on its first write — an
// update button that breaks the install. updateStatus() reports an honest block
// instead, the same shape as the win32 gate next door. This pins the gate that
// decides it, and the message that has to tell someone what to run instead.
import { beforeAll, describe, expect, test } from "bun:test";

// Cache-busted for the same reason as selfupdate-win32.test.ts: selfupdate.ts
// reads env into module-level consts at load, so a shared instance would carry
// whatever env happened to be set when some other file imported it first.
let flatpakUpdateBlock: (id?: string) => string | null;
beforeAll(async () => {
  ({ flatpakUpdateBlock } = await import(`../src/selfupdate.ts?u=${Math.random()}`));
});

describe("flatpakUpdateBlock", () => {
  test("blocks self-update under Flatpak and names the command to run", () => {
    const msg = flatpakUpdateBlock("app.agentglass.desktop");
    expect(msg).toBeTruthy();
    expect(msg).toContain("Flatpak");
    expect(msg).toContain("flatpak update app.agentglass.desktop");
  });

  // The id comes from the environment rather than a constant so the message
  // stays true if the app is ever published under a different one.
  test("uses the id it was actually given", () => {
    expect(flatpakUpdateBlock("org.example.Other")).toContain("flatpak update org.example.Other");
  });

  test("does not block an ordinary install", () => {
    expect(flatpakUpdateBlock(undefined)).toBeNull();
    // An empty FLATPAK_ID is not a Flatpak; treating "" as one would block
    // updates for anyone with a stray export in their shell profile.
    expect(flatpakUpdateBlock("")).toBeNull();
  });
});

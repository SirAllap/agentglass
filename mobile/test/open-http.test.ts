/*
 * A button that opens an address a field held opens a web page or nothing.
 *
 * Tracker and GitHub fields hold whatever was typed into them; handing that to
 * `Linking.openURL` as is passes any scheme on to the system (another app's
 * deep link, a `tel:` number). The decision is `httpUrl`, tested directly; the
 * wiring is source, since there is no renderer here: every screen that opens
 * such an address goes through `openHttp`.
 */
import { describe, expect, test } from "bun:test";
import { httpUrl } from "../src/model/httpUrl.ts";

describe("httpUrl", () => {
  test("keeps a web address", () => {
    expect(httpUrl("https://github.com/acme/orbit/pull/7")).toBe("https://github.com/acme/orbit/pull/7");
    expect(httpUrl("  HTTP://tracker.example/t/ORBIT-1042 ")).toBe("HTTP://tracker.example/t/ORBIT-1042");
  });

  test("refuses every other scheme, and anything that is not an address", () => {
    for (const raw of ["javascript:void(0)", "tel:+15550100", "file:///etc/hosts", "intent://x#Intent;end", "orbit://card/1042", "mailto:a@example.com", "//evil.example/x", "https://", "http:// x", "orbit.example/card", "", "   ", null, undefined]) {
      expect(httpUrl(raw), String(raw)).toBeNull();
    }
  });
});

describe("the screens that open an address a field held", () => {
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const FILES = [
    "../src/review/TaskChip.tsx", "../src/review/ThreadCard.tsx", "../src/state/open-pr.ts",
    "../app/(tabs)/tasks.tsx", "../app/card/[id].tsx", "../app/issue/[number].tsx", "../app/pr/[number].tsx",
  ];

  test("go through openHttp, never Linking.openURL", async () => {
    for (const f of FILES) {
      const src = code(await Bun.file(new URL(f, import.meta.url)).text());
      expect(src.includes("openHttp("), f).toBe(true);
      expect(src.includes("Linking.openURL"), f).toBe(false);
    }
  });
});

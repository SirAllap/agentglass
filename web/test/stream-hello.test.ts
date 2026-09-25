/*
 * The window names itself on /stream, or the server has nowhere to address a
 * browser ask and (correctly) fails it instead of broadcasting it.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url).pathname).text();

describe("stream hello", () => {
  test("ws.onopen sends the hello with this window's clientId", () => {
    const start = src.indexOf("ws.onopen = () => {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("ws.onclose", start));
    expect(body).toContain('type: "hello"');
    expect(body).toContain("clientId: clientId()");
    expect(body).toContain("browser: true");
  });
});

// The desktop window is cross-origin to the server, and routes that built
// their own Response forgot the CORS header: the window's console showed
// "No 'Access-Control-Allow-Origin' header" on /docker/live every two
// seconds and on /desktop/logo. The header is now added at the one exit.
import { expect, test } from "bun:test";
import { thrownAnswer, withCors } from "../src/corsExit.ts";

const cors = { "Access-Control-Allow-Origin": "agentglass://app", Vary: "Origin" };
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

test("an answer a route built by hand leaves with the header", () => {
  const res = withCors(new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), cors);
  expect(res.headers.get("access-control-allow-origin")).toBe("agentglass://app");
  expect(res.headers.get("vary")).toBe("Origin");
  expect(res.headers.get("content-type")).toBe("image/svg+xml");
});

test("an event stream built where no request is in sight leaves with it too", async () => {
  // The shape of dockerlive.ts's liveResponse, which takes a signal and never sees the request.
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(": open\n\n")); c.close(); } });
  const res = withCors(new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } }), cors);
  expect(res.headers.get("access-control-allow-origin")).toBe("agentglass://app");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(await res.text()).toBe(": open\n\n");
});

test("what a route already said is kept, and an upgrade has nothing to dress", () => {
  const own = withCors(new Response("x", { headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4000" } }), cors);
  expect(own.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4000");
  expect(withCors(undefined as unknown as Response, cors)).toBeUndefined();
});

test("an answer whose headers cannot be changed is rebuilt with the same body and status", async () => {
  // What a passed-through `fetch` answer is like: reading works, setting throws.
  const upstream = new Response("upstream said no", { status: 404, headers: { "content-type": "text/plain" } });
  (upstream.headers as unknown as { set: () => void }).set = () => { throw new TypeError("immutable"); };
  const res = withCors(upstream, cors);
  expect(res).not.toBe(upstream);
  expect(res.status).toBe(404);
  expect(res.headers.get("access-control-allow-origin")).toBe("agentglass://app");
  expect(res.headers.get("content-type")).toBe("text/plain");
  expect(await res.text()).toBe("upstream said no");
});

test("a handler that threw answers JSON the window can read", async () => {
  const res = thrownAnswer(cors);
  expect(res.status).toBe(500);
  expect(res.headers.get("access-control-allow-origin")).toBe("agentglass://app");
  expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
});

test("the handler has one exit, and both ways out of it go through here", () => {
  const at = index.indexOf("async function handleServerRequest(");
  expect(at).toBeGreaterThan(-1);
  const body = index.slice(at, index.indexOf("\n}\n", at));
  expect(body).toContain("try { return withCors(await (async () => {");
  expect(body).toContain("})(), corsFor(req)); } catch (e) {");
  expect(body).toContain("return thrownAnswer(corsFor(req));");
  expect(body).toContain("} finally { finished(mark); }");
});

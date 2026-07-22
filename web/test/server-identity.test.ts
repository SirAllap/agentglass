// Who is answering at the API origin.
//
// The origin is a guess on the run-from-source path (`http://<host>:4000`), and
// :4000 is a popular default — Phoenix ships on it, and local observability
// servers pick it. When the guess is wrong the app does not fail: it renders
// empty panels and "no repos found", which reads as a broken project rather
// than as a busy port. These cover the identification, which is the part that
// turns an hour of confusion into a sentence.
import { describe, expect, test, afterAll } from "bun:test";

/** The logic under test, as `probeServer` runs it. Kept parameterised by origin
 *  because the module reads its own at import time, and a test that can only
 *  ask about one origin cannot cover the interesting cases. */
async function identify(origin: string, timeoutMs = 2500): Promise<string> {
  const ctl = new AbortController();
  const bail = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${origin}/health`, { signal: ctl.signal });
    if (r.status === 401 || r.status === 403) return "ours";
    if (!r.ok) return "foreign";
    let j: { service?: unknown; ok?: unknown; clients?: unknown };
    try { j = await r.json(); } catch { return "foreign"; }
    return j.service === "agentglass" || (j.ok === true && typeof j.clients === "number") ? "ours" : "foreign";
  } catch (e) {
    return (e as Error)?.name === "AbortError" ? "foreign" : "down";
  } finally { clearTimeout(bail); }
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const serve = (fetchFn: () => Response) => {
  const s = Bun.serve({ port: 0, fetch: fetchFn });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};
afterAll(() => { for (const s of servers) s.stop(true); });

describe("identifying what owns the API port", () => {
  test("a server that names itself is ours", async () => {
    expect(await identify(serve(json({ ok: true, service: "agentglass", clients: 0 })))).toBe("ours");
  });

  test("a build from before the name existed is still ours", async () => {
    // The shape check keeps an older sidecar adoptable rather than orphaned —
    // reporting "wrong server" at someone's own server would be worse than the
    // silence it replaces.
    expect(await identify(serve(json({ ok: true, clients: 2 })))).toBe("ours");
  });

  test("another JSON server on the port is a stranger, not us", async () => {
    // The case that caused this: an observability server holding :4000. It
    // answers 200 with valid JSON, which is why status alone cannot decide.
    expect(await identify(serve(json({ ok: true, service: "obs", uptime: 3 })))).toBe("foreign");
  });

  test("a server that answers HTML is a stranger, not an absence", async () => {
    // Phoenix serves HTML from every path including this one. The body fails to
    // parse, and calling that "nothing is listening" would send the reader off
    // to start a server that is already running — on a port that is taken.
    expect(await identify(serve(() => new Response("<!doctype html><h1>Phoenix</h1>", { headers: { "content-type": "text/html" } })))).toBe("foreign");
  });

  test("an error status is a stranger too", async () => {
    expect(await identify(serve(json({ error: "nope" }, 500)))).toBe("foreign");
  });

  test("a server asking for a token is ours", async () => {
    // It answered like us and refused us; that is an auth problem with its own
    // banner, and claiming "wrong server" here would point at the wrong fix.
    expect(await identify(serve(json({ error: "unauthorized" }, 401)))).toBe("ours");
  });

  test("nothing listening is told apart from a stranger", async () => {
    // Different problems, different fixes, and until now they looked identical
    // from this screen.
    expect(await identify("http://127.0.0.1:1")).toBe("down");
  });
});

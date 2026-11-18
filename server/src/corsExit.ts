/*
 * THE ONE EXIT EVERY ANSWER LEAVES THROUGH.
 *
 * The request handler builds its CORS headers once per request and the
 * `json()` helper adds them. A route that builds its own `new Response`
 * has to remember to, and several did not: the desktop mark
 * (`/desktop/logo`), the live Docker feed (`/docker/live`, an event stream
 * built in another module that never sees the request), the pull request
 * image proxy's refusals, a plugin icon. The desktop window is served from
 * its own scheme, so every call it makes is cross-origin: the browser
 * received those answers and withheld them. Read in the window's console on
 * the installed app: "No 'Access-Control-Allow-Origin' header" on
 * `/docker/live` every two seconds (an EventSource retrying a stream it was
 * never allowed to read) and on `/desktop/logo`.
 *
 * So the headers are added where every answer passes, not where each is
 * made. A header the route already set is kept. Which origins are allowed
 * is not decided here: the request has been through the origin gate before
 * any route ran, and `cors` is what that request was already owed.
 */

/** `res` with every header of `cors` it does not already carry. */
export function withCors(res: Response, cors: Record<string, string>): Response {
  // A WebSocket upgrade hands back nothing; there is no answer to dress.
  if (!res) return res;
  const missing = Object.entries(cors).filter(([k]) => !res.headers.has(k));
  if (!missing.length) return res;
  try {
    for (const [k, v] of missing) res.headers.set(k, v);
    return res;
  } catch {
    // An answer passed through from `fetch` has headers that cannot be changed: same body, new head.
    const headers = new Headers(res.headers);
    for (const [k, v] of missing) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/**
 * The answer for a handler that threw.
 *
 * Bun's own answer to an uncaught throw is a bare 500 with no CORS header,
 * which the window cannot read: it sees a network failure and has nothing
 * to show. JSON with the header says the server is there and what went
 * wrong is on its side. The message is fixed; the error itself goes to the
 * server's log, not to whoever called.
 */
export function thrownAnswer(cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: false, error: "the server failed on this request; its log has the detail" }), {
    status: 500, headers: { "content-type": "application/json", ...cors },
  });
}

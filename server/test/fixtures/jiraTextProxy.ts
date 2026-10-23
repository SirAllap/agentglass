/*
 * A pass-through in front of the stand-in Jira that also reads the JQL it is
 * sent, because the stand-in's query reader does not understand `IN (...)`,
 * `text ~` or a relative `updated >=`. Everything is forwarded as it came (a search can be made to fail from its Nth call on); a search that carries `text ~`
 * is answered as if it had asked for one project, and the query as sent is
 * kept in `jql` so a test can assert on what a real site would have received.
 */
export interface JiraProxy {
  base: string;
  /** Every JQL string that reached the search endpoint, as the client wrote it. */
  jql: string[];
  stop(): Promise<void>;
}

export function startJiraProxy(target: string, answerAs = "project = ORBIT", o: { failSearchAfter?: number } = {}): JiraProxy {
  const jql: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      let body: string | undefined = req.method === "GET" ? undefined : await req.text();
      if (req.method === "POST" && /\/search(\/jql)?$/.test(url.pathname) && body) {
        try {
          const b = JSON.parse(body) as { jql?: string };
          if (typeof b.jql === "string") {
            jql.push(b.jql);
            // Searches past this many answer 500, to see a list that loses a later page.
            if (o.failSearchAfter !== undefined && jql.length > o.failSearchAfter) return new Response("{}", { status: 500 });
            if (/\btext\s*~/i.test(b.jql)) body = JSON.stringify({ ...b, jql: answerAs });
            // The stand-in's clock is fixed in January, so a relative `updated >= -Nm`
            // window would match nothing: that one clause is dropped and the rest is kept.
            else if (/\bupdated\s*>=/i.test(b.jql)) body = JSON.stringify({ ...b, jql: b.jql.replace(/\s+and\s+updated\s*>=\s*-\d+m/i, "") });
          }
        } catch { /* forwarded as it came */ }
      }
      const headers = new Headers(req.headers);
      headers.delete("host");
      return fetch(target + url.pathname + url.search, { method: req.method, headers, body });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, jql, stop: async () => { await server.stop(true); } };
}

// Who is answering on a loopback port: our server, someone else's, or nothing.
//
// Its own file so a test can import it; main.js is the Electron entry point
// and cannot be loaded under bun (see guest-guard.js). CommonJS with no build
// step, requiring only Node built-ins. Keep it in `build.files` in
// electron/package.json — left out of the asar, the app does not start.

const http = require("http");
const crypto = require("crypto");

/**
 * What a server holding `token` answers to `/health?challenge=<nonce>` on
 * `port`. Must match `healthProof` in server/src/auth.ts byte for byte;
 * server/test/desktop-adopt-proof.test.ts holds the two together.
 *
 * The port is in the message so a proof cannot be borrowed: a squatter on
 * :4000 that forwards the challenge to a genuine server on :4001 gets back an
 * answer for :4001, which the shell asking about :4000 refuses.
 * @param {string} token @param {number} port @param {string} nonce
 */
function healthProof(token, port, nonce) {
  return crypto.createHmac("sha256", token).update(`agentglass-health:${port}:${nonce}`).digest("hex");
}

/**
 * Probe `port` over loopback.
 *
 * "Answers 200" is NOT proof it is us: any other local dev server on :4000
 * answers 200 too, and adopting it pointed every panel at a stranger's API.
 * Nor is the body saying `service: "agentglass"`, because any process that can
 * bind the port first — another account on the machine, a container on the
 * host network — can say that too, and the shell then hands the port its
 * token, every hook event and every keystroke typed into a terminal. So "ours"
 * means the server proved it holds `token`: it answered a fresh random
 * challenge with the HMAC above. Nothing secret is sent before that answer is
 * checked; the challenge is useless to anyone but a holder of the token.
 *
 * `allowUnproven` keeps the old identity check (the marker in the body) for a
 * development shell pointed at `make dev`, whose server runs without a token
 * and so has nothing to prove with. The packaged app never sets it.
 *
 * @param {number} port
 * @param {{ token: string | null, allowUnproven?: boolean, timeoutMs?: number, host?: string }} opts
 * @returns {Promise<"ours" | "foreign" | "free">}
 */
function probe(port, opts) {
  const { token, allowUnproven = false, timeoutMs = 1000, host = "127.0.0.1" } = opts;
  const nonce = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health?challenge=${nonce}`, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve("foreign"); }
      let body = "";
      r.setEncoding("utf8");
      // Bounded: a foreign server may stream something enormous at us.
      r.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      r.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (token && typeof j.proof === "string") {
            const want = Buffer.from(healthProof(token, port, nonce));
            const got = Buffer.from(j.proof);
            return resolve(got.length === want.length && crypto.timingSafeEqual(got, want) ? "ours" : "foreign");
          }
          // `service` is the marker; the shape check keeps a sidecar built
          // before that field existed adoptable rather than orphaned.
          const marked = j.service === "agentglass" || (j.ok === true && typeof j.clients === "number");
          resolve(marked && allowUnproven ? "ours" : "foreign");
        } catch { resolve("foreign"); }
      });
      r.on("error", () => resolve("foreign"));
    });
    req.on("error", () => resolve("free")); // refused == nothing listening
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve("foreign"); });
  });
}

/**
 * Hold the desk of a server the shell adopted rather than started.
 *
 * Such a server was never piped a key (server/src/desk.ts), so the shell names
 * one on `/desk/claim` and keeps that request open: the key is the server's for
 * as long as the connection lives, and `onChange` hears it — the key once the
 * server holds it, null while it does not. A dropped claim is tried again after
 * `retryMs`, doubling while attempts keep failing (a tokenless dev server never
 * will) up to a minute, until `stop()`. A claim refused because another
 * process holds the desk (409) is the exception when `onTaken` is given: the
 * caller is told once and the claim is not retried, unless `settleMs` is
 * given: a 409 in the first `settleMs` is asked again every half second (or `retryMs`, if shorter), so a
 * Retry made the moment the other holder lets go is not answered with the
 * refusal that was true a beat ago.
 *
 * Every attempt proves the server first. A server restarted under the shell
 * leaves the port to whoever binds it next, and a claim carries both the token
 * and the key, so neither goes to a port that has not just answered the
 * challenge. The proof and the claim are two connections: a server that dies
 * and is replaced in the milliseconds between them is the window every request
 * the renderer sends after adoption already has.
 *
 * @param {number} port
 * @param {{ token: () => string | null, key: string, onChange: (key: string | null) => void, onTaken?: () => void, settleMs?: number, retryMs?: number, host?: string }} opts
 * @returns {() => void} stop, which lets the claim go
 */
function holdDesk(port, opts) {
  const { token, key, onChange, onTaken, retryMs = 5000, settleMs = 0, host = "127.0.0.1" } = opts;
  const began = Date.now();
  let stopped = false;
  /** @type {http.ClientRequest | null} */
  let req = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {string | null | undefined} */
  let told;
  let wait = retryMs;
  const say = (/** @type {string | null} */ k) => { if (!stopped && k !== told) { told = k; onChange(k); } };
  async function attempt() {
    let over = false;
    const done = () => {
      if (over) return;
      over = true;
      req = null;
      // A claim that was held and dropped retries at once-ish; one that never
      // got that far backs off.
      wait = told === key ? retryMs : Math.min(wait * 2, Math.max(retryMs, 60_000));
      say(null);
      if (!stopped) timer = setTimeout(attempt, wait);
    };
    const t = token();
    if (!t || (await probe(port, { token: t, host })) !== "ours" || stopped) return done();
    req = http.request({
      host, port, path: "/desk/claim", method: "POST",
      headers: { authorization: `Bearer ${t}`, "x-agentglass-desk": key, "content-length": 0 },
    }, (res) => {
      if (res.statusCode === 409 && onTaken) {
        res.resume();
        // Inside the settle window a refusal may be a claim the server has not
        // yet seen dropped: ask again at the base pace before saying so.
        if (Date.now() - began < settleMs) {
          over = true;
          req = null;
          if (!stopped) timer = setTimeout(attempt, Math.min(retryMs, 500));
          return;
        }
        // Someone else holds this server's desk. A caller that would rather
        // leave than wait is told once, and the claim is not retried.
        stopped = true;
        done();
        return onTaken();
      }
      if (res.statusCode !== 200) { res.resume(); return done(); }
      res.on("data", () => say(key));
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
    });
    req.on("error", done);
    req.end();
  }
  void attempt();
  return () => { stopped = true; clearTimeout(timer); req?.destroy(); };
}

module.exports = { healthProof, probe, holdDesk };

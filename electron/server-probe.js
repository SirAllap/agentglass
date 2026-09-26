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

module.exports = { healthProof, probe };

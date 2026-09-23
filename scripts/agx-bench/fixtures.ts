/**
 * The pages agx-bench drives, served by one small Bun server on a private
 * loopback port. Every page is inline HTML with no external request, so a run
 * measures the browser and the CLI, not the network.
 *
 * Each fixture has a known answer the server holds, and the runner grades an
 * arm against the server rather than against what the arm says it saw: a
 * signup counts when the server recorded it, a slowest request is the one the
 * server delayed longest.
 *
 * `POST /__bench/state` is the "edit the code" step of the dev loop: it flips a
 * fixture from broken to fixed, the way an agent's edit would, without a
 * browser call. `POST /__bench/reset` puts everything back between runs.
 */

export type BenchState = {
  /** The dev-loop page's bugs: seeded (`broken`) or fixed. */
  devloop: "broken" | "fixed";
  /** Successful signups the form accepted, in order. */
  signups: Array<{ name: string; email: string; plan: string; terms: boolean }>;
  /** Rejected signup attempts, to tell "never submitted" from "never fixed". */
  rejected: number;
};

/** The delays the measurement page's requests are served with. The slowest
 *  stands far enough above the rest that scheduling noise cannot reorder it. */
export const MEASURE_DELAYS: Record<string, number> = {
  users: 40,
  orders: 120,
  inventory: 420,
  prices: 80,
  reviews: 190,
  shipping: 60,
};
export const MEASURE_SLOWEST = "inventory";
/** Rows the measurement page renders, and the ones marked out of stock. */
export const MEASURE_ITEMS = 37;
const OUT_ROWS = new Set([3, 10, 17, 24, 31]);
export const MEASURE_OUT_OF_STOCK = OUT_ROWS.size;

/** What the dev-loop page seeds when broken. */
export const DEVLOOP_BUGS = {
  consoleError: "TypeError: Cannot read properties of undefined (reading 'price')",
  failedRequest: { path: "/api/widgets", status: 500 },
  visibleError: "Could not load widgets",
} as const;

export const SIGNUP_VALID = { name: "Ada Example", email: "ada@example.test", plan: "team", terms: true };
export const SIGNUP_INVALID_EMAIL = "ada.example.test";

export function freshState(): BenchState {
  return { devloop: "broken", signups: [], rejected: 0 };
}

const page = (title: string, body: string, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:15px system-ui,sans-serif;margin:24px}nav a{margin-right:12px}` +
  `.err{color:#b00020}.ok{color:#0a7d32}li.item{padding:2px 0}</style></head>` +
  `<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

// A client-side router: links are intercepted and pushState'd, the view is
// re-rendered from the path, and popstate re-renders on back/forward. No
// document load happens after the first, which is what makes it an SPA test.
const SPA_VIEWS: Record<string, { h: string; p: string }> = {
  "/spa/": { h: "Home", p: "Welcome to the orbit dashboard." },
  "/spa/items": { h: "Items", p: "There are 12 items in the orbit catalogue." },
  "/spa/about": { h: "About", p: "Orbit is an invented product used by agx-bench." },
};
const SPA_SCRIPT = `
const views = ${JSON.stringify(SPA_VIEWS)};
function render() {
  const v = views[location.pathname] || { h: "Not found", p: "" };
  document.getElementById("view").innerHTML = "<h1>" + v.h + "</h1><p>" + v.p + "</p>";
  document.title = "Orbit — " + v.h;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-spa]");
  if (!a) return;
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  render();
});
addEventListener("popstate", render);
render();`;

const SPA_HTML = page(
  "Orbit",
  `<nav><a data-spa href="/spa/">Home</a><a data-spa href="/spa/items">Items</a><a data-spa href="/spa/about">About</a></nav><main id="view"></main>`,
  SPA_SCRIPT,
);

const DOCS = (n: number) =>
  page(
    `Guide page ${n}`,
    `<h1>Guide page ${n}</h1><p>Chapter ${n} of the orbit guide.</p>` +
      (n < 3 ? `<a href="/docs/${n + 1}">Next: chapter ${n + 1}</a>` : `<p id="end">End of the guide.</p>`),
  );

const FORM_SCRIPT = `
const f = document.getElementById("signup");
f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: f.name.value, email: f.email.value, plan: f.plan.value, terms: f.terms.checked };
  const r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  const out = document.getElementById("result");
  if (r.ok) { out.className = "ok"; out.setAttribute("role", "status"); out.textContent = "Welcome, " + j.name + "!"; }
  else { out.className = "err"; out.setAttribute("role", "alert"); out.textContent = j.error; }
});`;

const FORM_HTML = page(
  "Sign up",
  `<h1>Sign up</h1><form id="signup" novalidate>
<p><label for="name">Full name</label> <input id="name" name="name" type="text"></p>
<p><label for="email">Email</label> <input id="email" name="email" type="text"></p>
<p><label for="plan">Plan</label> <select id="plan" name="plan"><option value="">Choose…</option><option value="solo">Solo</option><option value="team">Team</option><option value="enterprise">Enterprise</option></select></p>
<p><input id="terms" name="terms" type="checkbox"> <label for="terms">I accept the terms</label></p>
<p><button type="submit">Create account</button></p>
</form><div id="result"></div>`,
  FORM_SCRIPT,
);

// The same load runs when the page opens AND when "Refresh" is clicked. The
// benchmark has one task for each, because they are not the same problem: a
// bug that fires while the document is still loading happens before an
// in-page collector can be listening, one that fires on a click does not.
function devloopHtml(state: BenchState["devloop"]) {
  const load =
    state === "broken"
      ? `
function load() {
  const cart = {};
  fetch("/api/widgets").then((r) => {
    if (!r.ok) {
      const b = document.getElementById("banner");
      b.setAttribute("role", "alert");
      b.textContent = ${JSON.stringify(DEVLOOP_BUGS.visibleError)} + " (HTTP " + r.status + ")";
    }
  });
  setTimeout(() => { document.getElementById("total").textContent = cart.first.price; }, 0);
}`
      : `
function load() {
  fetch("/api/widgets").then((r) => r.json()).then((w) => {
    document.getElementById("list").innerHTML = w.map((x) => "<li>" + x.name + "</li>").join("");
    document.getElementById("total").textContent = String(w.length);
  });
}`;
  return page(
    "Widgets",
    `<h1>Widgets</h1><div id="banner" class="err"></div><ul id="list"></ul><p>Total: <span id="total">…</span></p><button type="button" id="refresh">Refresh</button>`,
    `${load}
document.getElementById("refresh").addEventListener("click", load);
load();`,
  );
}

// The report's requests start on a click, not on load, so they are made while
// the page is already being watched; the dev-loop tasks cover the other case.
const MEASURE_HTML = page(
  "Stock report",
  `<h1>Stock report</h1><button type="button" id="run">Run report</button><p id="status">Not run yet</p><ul id="items">${Array.from({ length: MEASURE_ITEMS }, (_, i) => {
    const out = OUT_ROWS.has(i);
    return `<li class="item${out ? " out" : ""}">Part ${String(i + 1).padStart(3, "0")}${out ? " — out of stock" : ""}</li>`;
  }).join("")}</ul>`,
  `document.getElementById("run").addEventListener("click", () => {
  document.getElementById("status").textContent = "Loading…";
  Promise.all(${JSON.stringify(Object.keys(MEASURE_DELAYS))}.map((k) => fetch("/api/report/" + k).then((r) => r.json())))
    .then(() => { document.getElementById("status").textContent = "Loaded"; });
});`,
);

const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });

/** The fixture server's routes, as a plain function so it can be tested
 *  without a socket. `sleep` is injectable for the same reason. */
export function makeHandler(state: BenchState, sleep: (ms: number) => Promise<unknown> = Bun.sleep) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/") return html(page("agx-bench", `<h1>agx-bench fixtures</h1><ul><li><a href="/spa/">SPA</a></li><li><a href="/docs/1">Guide</a></li><li><a href="/form">Form</a></li><li><a href="/devloop">Dev loop</a></li><li><a href="/measure">Measure</a></li></ul>`));
    if (p.startsWith("/spa/")) return html(SPA_HTML);
    const docs = /^\/docs\/([123])$/.exec(p);
    if (docs) return html(DOCS(Number(docs[1])));
    if (p === "/form") return html(FORM_HTML);
    if (p === "/api/signup" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const err =
        !String(b.name || "").trim() ? "Full name is required" :
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email || "")) ? "Email must look like name@domain" :
        !b.plan ? "Choose a plan" :
        b.terms !== true ? "You must accept the terms" : null;
      if (err) { state.rejected++; return json({ error: err }, 422); }
      const row = { name: String(b.name), email: String(b.email), plan: String(b.plan), terms: true };
      state.signups.push(row);
      return json(row);
    }
    if (p === "/devloop") return html(devloopHtml(state.devloop));
    if (p === "/api/widgets") {
      return state.devloop === "broken"
        ? json({ error: "widget store unavailable" }, DEVLOOP_BUGS.failedRequest.status)
        : json([{ name: "Sprocket" }, { name: "Flange" }, { name: "Grommet" }]);
    }
    if (p === "/measure") return html(MEASURE_HTML);
    const rep = /^\/api\/report\/([a-z]+)$/.exec(p);
    if (rep && rep[1] in MEASURE_DELAYS) {
      await sleep(MEASURE_DELAYS[rep[1]]);
      return json({ part: rep[1], rows: 3 });
    }
    if (p === "/__bench/state" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Partial<BenchState>;
      if (b.devloop === "broken" || b.devloop === "fixed") state.devloop = b.devloop;
      return json(state);
    }
    if (p === "/__bench/state") return json(state);
    if (p === "/__bench/reset" && req.method === "POST") {
      Object.assign(state, freshState());
      return json(state);
    }
    return new Response("not found", { status: 404 });
  };
}

/** Start the fixture server on a loopback port (0 = any free one). */
export function startFixtures(port = 0) {
  const state = freshState();
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: makeHandler(state) });
  return { server, state, origin: `http://127.0.0.1:${server.port}` };
}

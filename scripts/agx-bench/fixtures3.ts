/**
 * Pages for the model-driven "speed" tasks. The question they answer is how
 * many rounds, tokens and seconds a cheap model needs to finish a job through
 * the browser CLI, so each page has one ordinary way to waste a round: a field
 * that revalidates, a modal that arrives late, a control inside a shadow root,
 * a link that opens another tab, a button covered for a moment.
 *
 * Same rules as the other fixture files: inline HTML, no external request, and
 * the SERVER decides whether the job was done. A page reports what happened to
 * `state.beacons` (`speed-<task>` for the right outcome, `speed-<task>-<what>`
 * for a wrong or premature one); `grade` reads only those, never the model's
 * own claim.
 */
import type { BenchState } from "./fixtures.ts";

const doc = (title: string, body: string, script = "") => () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font:15px system-ui,sans-serif;margin:24px}button,input,select{font:inherit;margin:4px;padding:4px 8px}` +
      `.err{color:#b00020}.ok{color:#0a7d32}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}` +
      `.cover{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px}` +
      `.card{background:#fff;color:#111;padding:24px;border-radius:8px}</style></head>` +
      `<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

const beacon = (name: string) => `fetch("/__bench/beacon?name=${name}",{method:"POST"});`;

export const LOGIN = { email: "ada@example.test", password: "not-a-real-password" };
export const SEARCH_RIGHT = "g3";
export const SHADOW_CODE = "orbit-7";
export const ORDER_RIGHT = 1037;
export const SIGNUP = { name: "Ada Example", email: "ada@example.test", plan: "team" };

const LOGIN_PAGE = doc(
  "Orbit sign in",
  `<h1>Orbit sign in</h1><form id="f"><label>Email <input id="email" type="email" autocomplete="off"></label>` +
    `<label>Password <input id="pw" type="password" autocomplete="off"></label><button type="submit">Sign in</button></form>` +
    `<p id="msg" role="status"></p>`,
  `document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/api/speed/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("email").value, pw: document.getElementById("pw").value }) });
    const m = document.getElementById("msg");
    m.textContent = r.ok ? "Welcome back, Ada" : "Wrong email or password";
    m.setAttribute("role", r.ok ? "status" : "alert");
  });`,
);

// Results appear 400 ms after the last keystroke, like a debounced live search.
const SEARCH_PAGE = doc(
  "Parts search",
  `<h1>Parts</h1><label>Search parts <input id="q" type="search" autocomplete="off"></label><ul id="res"></ul><p id="sel" role="status"></p>`,
  `const ITEMS = [["g1","Gasket 40mm, steel"],["g2","Gasket 40mm, titanium"],["g3","Gasket 60mm, titanium"],["g4","Gasket 60mm, rubber"],["g5","Gasket seal kit, copper"],["f1","Flange 40mm, steel"]];
  let t;
  document.getElementById("q").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      const q = e.target.value.trim().toLowerCase();
      const ul = document.getElementById("res");
      ul.innerHTML = "";
      if (!q) return;
      for (const [id, name] of ITEMS) if (name.toLowerCase().includes(q)) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.textContent = name;
        b.addEventListener("click", async () => {
          await fetch("/api/speed/pick?id=" + id, { method: "POST" });
          document.getElementById("sel").textContent = "Selected: " + name;
        });
        li.append(b); ul.append(li);
      }
    }, 400);
  });`,
);

const SIGNUP_PAGE = doc(
  "Create account",
  `<h1>Create account</h1><p id="step" role="status">Step 1 of 3</p><div id="err" class="err" role="alert"></div>` +
    `<section id="s1"><label>Full name <input id="name" autocomplete="off"></label><label>Email <input id="email" autocomplete="off"></label><button id="n1">Next</button></section>` +
    `<section id="s2" hidden><label>Plan <select id="plan"><option value="">Choose…</option><option>basic</option><option>team</option><option>enterprise</option></select></label>` +
    `<label><input id="terms" type="checkbox"> I accept the terms</label><button id="n2">Next</button></section>` +
    `<section id="s3" hidden><p id="review"></p><button id="go">Confirm</button></section><p id="done" class="ok"></p>`,
  `const $ = (i) => document.getElementById(i);
  const show = (n) => { for (const k of ["s1","s2","s3"]) $(k).hidden = k !== "s" + n; $("step").textContent = "Step " + n + " of 3"; $("err").textContent = ""; };
  $("n1").onclick = () => {
    if (!/^\\S+\\s+\\S+/.test($("name").value.trim())) return void ($("err").textContent = "Enter your first and last name");
    if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test($("email").value)) return void ($("err").textContent = "Email must look like name@domain");
    show(2);
  };
  $("n2").onclick = () => {
    if (!$("plan").value) return void ($("err").textContent = "Choose a plan");
    if (!$("terms").checked) return void ($("err").textContent = "Accept the terms to continue");
    $("review").textContent = $("name").value + " / " + $("email").value + " / " + $("plan").value;
    show(3);
  };
  $("go").onclick = async () => {
    const r = await fetch("/api/speed/signup", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("name").value, email: $("email").value, plan: $("plan").value, terms: $("terms").checked }) });
    $("done").textContent = r.ok ? "Account created" : "Could not create the account";
  };`,
);

// Five pages of eight orders. The customer to find is on page 4, with a
// look-alike on page 2.
const ORDERS_PAGE = doc(
  "Orders",
  `<h1>Orders</h1><table><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th></th></tr></thead><tbody id="rows"></tbody></table>` +
    `<p><button id="prev">Previous page</button><button id="next">Next page</button> <span id="pg" role="status"></span></p><p id="out" role="status"></p>`,
  `const NAMES = ["Acme Corp","Globex","Initech","Umbrella Ltd","Hooli","Stark Supply","Wayne Parts","Cyberdyne"];
  const ROWS = [];
  for (let i = 0; i < 40; i++) ROWS.push({ id: 1000 + i, who: NAMES[i % 8], total: 20 + ((i * 37) % 180) });
  ROWS[12].who = "Orbit Labs Europe"; ROWS[12].id = 1013;
  ROWS[27].who = "Orbit Labs"; ROWS[27].id = ${ORDER_RIGHT};
  let page = 0;
  const draw = () => {
    const tb = document.getElementById("rows");
    tb.innerHTML = "";
    for (const r of ROWS.slice(page * 8, page * 8 + 8)) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + r.id + "</td><td>" + r.who + "</td><td>$" + r.total + "</td><td></td>";
      const b = document.createElement("button");
      b.textContent = "Mark shipped";
      b.onclick = async () => { await fetch("/api/speed/ship?id=" + r.id, { method: "POST" }); document.getElementById("out").textContent = "Order " + r.id + " marked shipped"; };
      tr.lastChild.append(b);
      tb.append(tr);
    }
    document.getElementById("pg").textContent = "Page " + (page + 1) + " of 5";
  };
  document.getElementById("next").onclick = () => { page = Math.min(4, page + 1); draw(); };
  document.getElementById("prev").onclick = () => { page = Math.max(0, page - 1); draw(); };
  draw();`,
);

// The newsletter modal arrives 1.2 s after load and covers the page.
const PROMO_PAGE = doc(
  "Annual report",
  `<h1>Annual report</h1><button id="dl">Download report</button><p id="st" role="status"></p>`,
  `let modal = false;
  setTimeout(() => {
    modal = true;
    const d = document.createElement("div");
    d.className = "cover"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Newsletter");
    d.innerHTML = '<div class="card"><h2>Join our newsletter</h2><label>Email <input></label><button id="sub">Subscribe</button><button id="no">No thanks</button></div>';
    document.body.append(d);
    document.getElementById("no").onclick = () => { modal = false; d.remove(); };
    document.getElementById("sub").onclick = () => { modal = false; d.remove(); };
  }, 1200);
  document.getElementById("dl").onclick = () => {
    if (modal) { ${beacon("speed-promo-blocked")} return; }
    ${beacon("speed-promo")}
    document.getElementById("st").textContent = "Download started";
  };`,
);

const DOCS_PAGE = doc(
  "Plans",
  `<h1>Plans</h1><p>Before you subscribe, <a id="t" href="/speed/terms" target="_blank">read the terms</a>.</p>`,
);
const TERMS_PAGE = doc(
  "Terms of service",
  `<h1>Terms of service</h1><p>Be kind to the orbit.</p><button id="ok">Accept terms</button><p id="st" role="status"></p>`,
  `document.getElementById("ok").onclick = () => { ${beacon("speed-popup")} document.getElementById("st").textContent = "Terms accepted"; };`,
);

// A widget with an OPEN shadow root: the field and the button live inside it.
const SHADOW_PAGE = doc(
  "Activation",
  `<h1>Activation</h1><orbit-widget></orbit-widget><p id="out" role="status"></p>`,
  `customElements.define("orbit-widget", class extends HTMLElement {
    constructor() {
      super();
      const r = this.attachShadow({ mode: "open" });
      r.innerHTML = '<label>Activation code <input id="c" autocomplete="off"></label><button id="a">Activate</button>';
      r.getElementById("a").onclick = async () => {
        await fetch("/api/speed/shadow?code=" + encodeURIComponent(r.getElementById("c").value), { method: "POST" });
        document.getElementById("out").textContent = "Activation sent";
      };
    }
  });`,
);

// "Save changes" is inserted at 0.6 s, enabled at 1.8 s, and a loading layer
// covers the page until 2.2 s: a click before then does nothing.
const OVERLAY_PAGE = doc(
  "Settings",
  `<h1>Settings</h1><div id="slot"></div><p id="st" role="status"></p>`,
  `let covered = true;
  const layer = document.createElement("div");
  layer.className = "cover"; layer.textContent = "Loading…";
  document.body.append(layer);
  setTimeout(() => {
    const b = document.createElement("button");
    b.id = "save"; b.textContent = "Save changes"; b.disabled = true;
    b.onclick = () => {
      if (covered || b.disabled) { ${beacon("speed-overlay-early")} return; }
      ${beacon("speed-overlay")}
      document.getElementById("st").textContent = "Saved";
    };
    document.getElementById("slot").append(b);
    setTimeout(() => { b.disabled = false; }, 1200);
  }, 600);
  setTimeout(() => { covered = false; layer.remove(); }, 2200);`,
);

const PAGES: Record<string, () => Response> = {
  "/speed/login": LOGIN_PAGE,
  "/speed/search": SEARCH_PAGE,
  "/speed/signup": SIGNUP_PAGE,
  "/speed/orders": ORDERS_PAGE,
  "/speed/promo": PROMO_PAGE,
  "/speed/docs": DOCS_PAGE,
  "/speed/terms": TERMS_PAGE,
  "/speed/shadow": SHADOW_PAGE,
  "/speed/overlay": OVERLAY_PAGE,
};

const count = (state: BenchState, name: string) => void (state.beacons[name] = (state.beacons[name] ?? 0) + 1);

export async function speedRoutes(p: string, req: Request, state: BenchState): Promise<Response | null> {
  const page = PAGES[p];
  if (page) return page();
  if (req.method !== "POST" || !p.startsWith("/api/speed/")) return null;
  const q = new URL(req.url).searchParams;
  const body = async () => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const reply = (ok: boolean) => Response.json({ ok }, { status: ok ? 200 : 422 });
  switch (p) {
    case "/api/speed/login": {
      const b = await body();
      const ok = b.email === LOGIN.email && b.pw === LOGIN.password;
      count(state, ok ? "speed-login" : "speed-login-bad");
      return reply(ok);
    }
    case "/api/speed/pick": {
      const ok = q.get("id") === SEARCH_RIGHT;
      count(state, ok ? "speed-search" : "speed-search-wrong");
      return reply(ok);
    }
    case "/api/speed/signup": {
      const b = await body();
      const ok = b.name === SIGNUP.name && b.email === SIGNUP.email && b.plan === SIGNUP.plan && b.terms === true;
      count(state, ok ? "speed-signup" : "speed-signup-wrong");
      return reply(ok);
    }
    case "/api/speed/ship": {
      const ok = Number(q.get("id")) === ORDER_RIGHT;
      count(state, ok ? "speed-orders" : "speed-orders-wrong");
      return reply(ok);
    }
    case "/api/speed/shadow": {
      const ok = q.get("code") === SHADOW_CODE;
      count(state, ok ? "speed-shadow" : "speed-shadow-wrong");
      return reply(ok);
    }
  }
  return null;
}

export type SpeedTask = {
  id: string;
  /** What the model is asked, with the fixture's origin filled in. */
  prompt: (origin: string) => string;
  /** The beacon that must be present exactly once, and none of the wrong ones. */
  pass: (beacons: Record<string, number>) => boolean;
};

const once = (b: Record<string, number>, name: string) => b[name] === 1;
const none = (b: Record<string, number>, ...names: string[]) => names.every((n) => !b[n]);

export const SPEED_TASKS: SpeedTask[] = [
  {
    id: "login",
    prompt: (o) => `Sign in at ${o}/speed/login with email ${LOGIN.email} and password ${LOGIN.password}.`,
    pass: (b) => once(b, "speed-login") && none(b, "speed-login-bad"),
  },
  {
    id: "search-pick",
    // The search is a substring match, so the prompt names the exact term: it
    // said "gaskets", which matched nothing, and the task measured how fast a
    // model guessed the singular instead of how fast it drove the browser.
    prompt: (o) => `On ${o}/speed/search, type "gasket" into the search box and choose the result "Gasket 60mm, titanium".`,
    pass: (b) => once(b, "speed-search") && none(b, "speed-search-wrong"),
  },
  {
    id: "multistep",
    prompt: (o) =>
      `At ${o}/speed/signup, create an account for ${SIGNUP.name} (${SIGNUP.email}) on the ${SIGNUP.plan} plan, accepting the terms, and confirm it.`,
    pass: (b) => once(b, "speed-signup") && none(b, "speed-signup-wrong"),
  },
  {
    id: "table-pages",
    prompt: (o) => `At ${o}/speed/orders, mark as shipped the order of the customer named exactly "Orbit Labs" (not "Orbit Labs Europe").`,
    pass: (b) => once(b, "speed-orders") && none(b, "speed-orders-wrong"),
  },
  {
    id: "late-modal",
    prompt: (o) => `At ${o}/speed/promo, download the report.`,
    pass: (b) => once(b, "speed-promo"),
  },
  {
    id: "popup",
    prompt: (o) => `At ${o}/speed/docs, open the terms link and accept the terms on the page it opens.`,
    pass: (b) => once(b, "speed-popup"),
  },
  {
    id: "shadow",
    prompt: (o) => `At ${o}/speed/shadow, enter the activation code ${SHADOW_CODE} in the widget and activate it.`,
    pass: (b) => once(b, "speed-shadow") && none(b, "speed-shadow-wrong"),
  },
  {
    id: "overlay",
    prompt: (o) => `At ${o}/speed/overlay, click "Save changes" and make sure it saved.`,
    pass: (b) => once(b, "speed-overlay"),
  },
];

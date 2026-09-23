/**
 * The agx-bench task set. Each task names its fixture, how it is graded, and
 * one arm per approach.
 *
 * `baseline` is written the way an agent drives the CLI today, following the
 * browser-use skill: observe, act by the element id the tree gave, observe
 * again to see what happened. Every id comes out of an `observe` answer —
 * nothing is clicked by a selector the arm could only have known by reading
 * the fixture's source, which would make the baseline cheaper than any agent.
 *
 * TO ADD AN ARM: give a task another key in `arms` (say `phase1`) that solves
 * it with the new verbs, and run `--arm baseline,phase1`. Tasks without that
 * arm are skipped for it, and the grader does not change: both arms are held
 * to the same answer.
 */
import { pick, type Node, type Session, type Task } from "./bench.ts";
import {
  DEVLOOP_BUGS,
  MEASURE_DELAYS,
  MEASURE_OUT_OF_STOCK,
  MEASURE_SLOWEST,
  SIGNUP_INVALID_EMAIL,
  SIGNUP_VALID,
} from "./fixtures.ts";

type Observed = {
  url: string;
  title: string;
  tree: Node[];
  console: Array<{ level: string; text: string }>;
  network: Array<{ method: string; url: string; status: number; ms: number }>;
};

async function observe(s: Session): Promise<Observed> {
  const o = (await s.cli("observe")).json;
  if (!o || !Array.isArray(o.tree)) throw new Error("observe did not return a tree");
  return o as Observed;
}

const heading = (o: Observed) => o.tree.find((n) => n.role === "h1")?.name;
const pathOf = (url: string) => new URL(url, "http://x").pathname;

/** What an agent reports as broken from one `observe`. */
function problems(o: Observed) {
  return {
    consoleErrors: o.console.filter((c) => c.level === "error").map((c) => c.text),
    failedRequests: o.network.filter((n) => n.status >= 400).map((n) => ({ path: pathOf(n.url), status: n.status })),
    visibleErrors: o.tree.filter((n) => n.role === "alert").map((n) => n.name ?? ""),
  };
}
type Problems = ReturnType<typeof problems>;

function gradeProblems(before: Problems | undefined, after: Problems | undefined, fixed: boolean): string | null {
  if (!before || !after) return "no answer";
  const missed: string[] = [];
  if (!before.consoleErrors.some((t) => t.includes("reading 'price'"))) missed.push("the console error");
  if (!before.failedRequests.some((r) => r.path === DEVLOOP_BUGS.failedRequest.path && r.status === DEVLOOP_BUGS.failedRequest.status))
    missed.push("the failed request");
  if (!before.visibleErrors.some((t) => t.includes(DEVLOOP_BUGS.visibleError))) missed.push("the visible error");
  if (missed.length) return `missed ${missed.join(", ")}`;
  if (!fixed) return "never applied the fix";
  const left = after.consoleErrors.length + after.failedRequests.length + after.visibleErrors.length;
  return left ? `after the fix still saw ${left} problem(s): ${JSON.stringify(after)}` : null;
}

export const TASKS: Task[] = [
  {
    id: "nav-spa",
    family: "navigation",
    title: "SPA: follow two client-side routes, go back, report where you are",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/spa/")]);
        let o = await observe(s);
        await s.cli("click", [pick(o.tree, "a", "Items").e]);
        o = await observe(s);
        if (heading(o) !== "Items") throw new Error(`the route did not change: h1 ${heading(o)}`);
        await s.cli("click", [pick(o.tree, "a", "About").e]);
        await s.cli("back");
        o = await observe(s);
        return { path: pathOf(o.url), heading: heading(o) };
      },
    },
    grade: (a) => (a?.path === "/spa/items" && a?.heading === "Items" ? null : `ended at ${JSON.stringify(a)}`),
  },
  {
    id: "nav-links",
    family: "navigation",
    title: "Multi-page: follow Next twice, go back once, report the page",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/docs/1")]);
        let o = await observe(s);
        await s.cli("click", [pick(o.tree, "a", /^Next/).e]);
        o = await observe(s);
        await s.cli("click", [pick(o.tree, "a", /^Next/).e]);
        o = await observe(s);
        if (heading(o) !== "Guide page 3") throw new Error(`expected page 3, saw ${heading(o)}`);
        await s.cli("back");
        o = await observe(s);
        return { path: pathOf(o.url), heading: heading(o) };
      },
    },
    grade: (a) => (a?.path === "/docs/2" && a?.heading === "Guide page 2" ? null : `ended at ${JSON.stringify(a)}`),
  },
  {
    id: "form-signup",
    family: "form",
    title: "Sign-up form: fill, submit with a bad email, read the error, fix it, succeed",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/form")]);
        const o = await observe(s);
        const email = pick(o.tree, "input", "Email").e;
        await s.cli("type", [pick(o.tree, "input", "Full name").e, SIGNUP_VALID.name]);
        await s.cli("type", [email, SIGNUP_INVALID_EMAIL]);
        // `select` does not resolve an element id today ("nothing matched"),
        // so an agent falls back to the CSS id the tree also carries.
        await s.cli("select", [`#${pick(o.tree, "select", "Plan").id}`, SIGNUP_VALID.plan]);
        await s.cli("check", [pick(o.tree, "input", "I accept the terms").e]);
        const submit = pick(o.tree, "button", "Create account").e;
        await s.cli("click", [submit]);
        const bad = await observe(s);
        const error = bad.tree.find((n) => n.role === "alert")?.name;
        await s.cli("type", [email, SIGNUP_VALID.email]);
        await s.cli("click", [submit]);
        const good = await observe(s);
        return { error, welcome: good.tree.find((n) => n.role === "status")?.name };
      },
    },
    grade(a, state) {
      if (!/email/i.test(a?.error ?? "")) return `did not read the validation error: ${JSON.stringify(a?.error)}`;
      if (!state.rejected) return "the bad submit never reached the server";
      if (state.signups.length !== 1) return `${state.signups.length} signups recorded, expected 1`;
      if (JSON.stringify(state.signups[0]) !== JSON.stringify(SIGNUP_VALID)) return `recorded ${JSON.stringify(state.signups[0])}`;
      return (a?.welcome ?? "").includes(SIGNUP_VALID.name) ? null : `did not see the success: ${JSON.stringify(a?.welcome)}`;
    },
  },
  {
    id: "devloop-load",
    family: "devloop",
    title: "Dev loop, bugs at page load: report console error + failed request + visible error, fix, reload, verify clean",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/devloop")]);
        const before = problems(await observe(s));
        await s.edit({ devloop: "fixed" });
        await s.cli("reload");
        const after = problems(await observe(s));
        return { before, after };
      },
    },
    grade: (a, state) => gradeProblems(a?.before, a?.after, state.devloop === "fixed"),
  },
  {
    id: "devloop-click",
    family: "devloop",
    title: "Dev loop, bugs on a click: same report, fix, reload, click again, verify clean",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/devloop")]);
        let o = await observe(s);
        await s.cli("click", [pick(o.tree, "button", "Refresh").e]);
        const before = problems(await observe(s));
        await s.edit({ devloop: "fixed" });
        await s.cli("reload");
        o = await observe(s);
        await s.cli("click", [pick(o.tree, "button", "Refresh").e]);
        const after = problems(await observe(s));
        return { before, after };
      },
    },
    grade: (a, state) => gradeProblems(a?.before, a?.after, state.devloop === "fixed"),
  },
  {
    id: "measure-report",
    family: "measure",
    title: "Run a report, name its slowest request, count the out-of-stock rows",
    arms: {
      async baseline(s) {
        await s.cli("open", [s.url("/measure")]);
        const o = await observe(s);
        await s.cli("click", [pick(o.tree, "button", "Run report").e]);
        await s.cli("waitfor", ["--until", "network-idle"]);
        const rows = ((await s.cli("network")).json?.rows ?? []) as Observed["network"];
        const slowest = rows.reduce<Observed["network"][number] | undefined>((m, r) => (!m || r.ms > m.ms ? r : m), undefined);
        // `read` answers in plain text, not JSON: the page's visible text.
        const text = (await s.cli("read")).stdout;
        return {
          slowest: slowest ? pathOf(slowest.url).split("/").pop() : undefined,
          requests: rows.length,
          outOfStock: text.split("out of stock").length - 1,
        };
      },
    },
    grade(a) {
      if (a?.requests !== Object.keys(MEASURE_DELAYS).length) return `saw ${a?.requests} report requests`;
      if (a?.slowest !== MEASURE_SLOWEST) return `named ${a?.slowest} as the slowest`;
      return a?.outOfStock === MEASURE_OUT_OF_STOCK ? null : `counted ${a?.outOfStock} out of stock`;
    },
  },
];

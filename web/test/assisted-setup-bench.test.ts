/*
 * A BUTTON THAT OPENS SOMETHING OUTSIDE THE PAGE SAYS SO, AND OPENS IT ONCE.
 *
 * Measured: the Polaris card's "Assisted setup" opened a terminal session on the
 * bench and said nothing. Three presses opened three sessions, and they were only
 * found after leaving Settings. The same button sat behind every other starter —
 * Docker's cleanup, the Lantern's chat, a hand-off, a flight plan's author — so
 * the rule is one helper (lib/benchJobs.ts) and one line (components/BenchJobLine).
 *
 * Three things are pinned:
 *   - a second press is the same session: one tab, one ticket, per job and checkout,
 *     and the tab can be closed so the button comes back;
 *   - the page states where it went, with a Show it that brings it to the front;
 *   - nothing under src/ seats a session around the helper.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage);

const { readdirSync } = await import("node:fs");
const { api } = await import("../src/lib/api.ts");
const bench = await import("../src/lib/benchStore.ts");
const ask = await import("../src/lib/lanternAsk.ts");
const jobs = await import("../src/lib/benchJobs.ts");
const { BenchJobLine } = await import("../src/components/BenchJobLine.tsx");
const { ASSIST_TITLE } = await import("../src/lib/polarisView.ts");

const ROOT = "/home/dev/orbit";
const OTHER = "/home/dev/orbit-ORBIT-1042";

/** The two calls a press makes, as the engine and the server would answer. */
type Calls = {
  benchLive: (root: string) => Promise<{ ok: boolean; slots: number[] }>;
  termAgentTicket: (...args: unknown[]) => Promise<{ ok: boolean; ticket?: string; error?: string }>;
  workerRoles: () => Promise<unknown>;
};
const calls = api as unknown as Calls;
const real = { benchLive: calls.benchLive, termAgentTicket: calls.termAgentTicket, workerRoles: calls.workerRoles };

/** What tmux is holding; the test puts a session there the way the engine would. */
let onEngine: number[] = [];
let tickets = 0;

beforeEach(() => {
  bench.__resetBench();
  jobs.__resetJobs();
  onEngine = [];
  tickets = 0;
  calls.workerRoles = async () => ({
    ok: true,
    roles: { builder: { provider: "claude" } },
    providers: [{ id: "claude", title: "Claude", installed: true }],
  });
  calls.termAgentTicket = async () => ({ ok: true, ticket: `ticket-${++tickets}` });
  calls.benchLive = async () => ({ ok: true, slots: [...onEngine] });
});

afterAll(() => Object.assign(api, real));

const press = (root = ROOT) => ask.askBuilderOnBench(root, "help me set up Polaris", ASSIST_TITLE, jobs.JOB.polarisSetup, ASSIST_TITLE);

describe("a press is one session per job and checkout", () => {
  it("a second press brings the first tab forward and mints no second ticket", async () => {
    const first = await press();
    expect(first.ok).toBe(true);
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    // The engine has its session now, which is what the next press asks.
    onEngine = bench.tabsFor(ROOT).map((t) => t.slot);

    const second = await press();
    expect(second).toMatchObject({ ok: true, reused: true, id: first.id });
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets, "a second ticket is a second session").toBe(1);
    // And the bench is pointed at it, which is what "Show it" does too.
    expect(bench.benchState().open).toBe(true);
    expect(bench.activeTabId(ROOT)).toBe(first.id!);
  });

  it("two presses before the first answers answer with one session", async () => {
    const [a, b] = await Promise.all([press(), press()]);
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets).toBe(1);
    expect(b!.id).toBe(a!.id);
  });

  it("another project gets its own session rather than this one's", async () => {
    await press();
    onEngine = bench.tabsFor(ROOT).map((t) => t.slot);

    const other = await press(OTHER);
    expect(other.ok).toBe(true);
    expect(bench.tabsFor(OTHER)).toHaveLength(1);
    expect(tickets).toBe(2);
  });

  it("closing the tab ends the job, and the next press opens a fresh session", async () => {
    const first = await press();
    bench.closeTab(ROOT, first.id!);
    onEngine = [];

    const again = await press();
    expect(again.ok).toBe(true);
    expect(again.reused).toBeFalsy();
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets).toBe(2);
  });

  it("a session the engine no longer has is forgotten, and the next press opens a fresh one", async () => {
    const first = await press();
    // The terminal said `ready`; later the engine restarted or the session ended.
    jobs.sessionSettled(first.id!);
    onEngine = [];

    const again = await press();
    expect(again.ok).toBe(true);
    expect(again.reused).toBeFalsy();
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets).toBe(2);
  });

  it("a tab whose socket has not started tmux yet is starting, not dead", async () => {
    const first = await press();
    // The tab exists; BenchTerm has not opened the socket that creates the
    // session, so the engine knows nothing about this slot yet.
    onEngine = [];

    const second = await press();
    expect(second).toMatchObject({ ok: true, reused: true, id: first.id });
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets, "the startup window is not a second session").toBe(1);
  });

  it("once the terminal says it ended, the same empty engine replaces the tab", async () => {
    const first = await press();
    jobs.sessionSettled(first.id!);
    onEngine = [];

    const again = await press();
    expect(again.reused).toBeFalsy();
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets).toBe(2);
  });

  it("two different jobs in one checkout never seat two tabs on one slot", async () => {
    /* Both creations read the free slot before either tab exists. Held open so
       they interleave exactly the way the two deferred answers did. */
    let go: () => void = () => {};
    const gate = new Promise<void>((r) => { go = r; });
    calls.benchLive = async () => { await gate; return { ok: true, slots: [] }; };
    const seat = (job: string) => jobs.openBenchJob({
      job, root: ROOT,
      create: async () => ({ ok: true, root: ROOT, tab: { kind: "term" as const, slot: await jobs.coldSlot(ROOT), title: job } }),
    });
    const a = seat("job.first");
    const b = seat("job.second");
    go();
    await Promise.all([a, b]);
    expect(bench.tabsFor(ROOT).map((t) => t.slot)).toEqual([1, 2]);
  });

  it("adopts a session opened before jobs existed instead of seating a fourth", async () => {
    // The person's measured case: three tabs from the old button, no job on any.
    bench.addTab(ROOT, { kind: "agent", slot: 3, title: ASSIST_TITLE, agent: "old" });
    onEngine = [3];

    const r = await press();
    expect(r.reused).toBe(true);
    expect(bench.tabsFor(ROOT)).toHaveLength(1);
    expect(tickets).toBe(0);
    // Adopted for good: the job is on the tab now.
    expect(bench.tabsFor(ROOT)[0]!.job).toBe(jobs.JOB.polarisSetup);
  });

  it("a job with its own id is another session — a hand-off, a selection asked twice", () => {
    const one = jobs.JOB.askAboutSelection("KeyError: 'id'");
    const same = jobs.JOB.askAboutSelection("KeyError: 'id'");
    const other = jobs.JOB.askAboutSelection("Traceback (most recent call last)");
    expect(one).toBe(same);
    expect(one).not.toBe(other);
  });

  it("a job keyed by a selection never adopts an unclaimed tab with the same title", async () => {
    /* An old `ask` tab holds selection A. Asking about B must not land in it:
       the title cannot say which selection the tab was for. */
    bench.addTab(ROOT, { kind: "agent", slot: 3, title: "ask", agent: "old" });
    onEngine = [3];

    const b = await ask.askOnBench(ROOT, "what about B", "ask", undefined, jobs.JOB.askAboutSelection("selection B"));
    expect(b.ok).toBe(true);
    expect(b.reused).toBeFalsy();
    expect(bench.tabsFor(ROOT)).toHaveLength(2);
    expect(tickets).toBe(1);
    expect(bench.tabsFor(ROOT)[1]!.job).toBe(jobs.JOB.askAboutSelection("selection B"));
  });

  it("a flight plan's author does not adopt an unclaimed `flight plan` tab of another plan", async () => {
    bench.addTab(ROOT, { kind: "agent", slot: 3, title: "flight plan", agent: "old" });
    onEngine = [3];

    const b = await ask.openTicketOnBench(ROOT, "ticket-for-B", "flight plan", jobs.JOB.flightAuthor("B"));
    expect(b.ok).toBe(true);
    expect(b.reused).toBeFalsy();
    expect(bench.tabsFor(ROOT)).toHaveLength(2);
  });

  it("two different selections never share a job key", () => {
    // A 32-bit digest made these one key; the second question reused the first chat.
    const a = "EVUlyxWRUNqXynkxkz2TyVyp";
    const b = "gl290nO3ob8FGNQJoLErSXWB";
    expect(jobs.JOB.askAboutSelection(a)).not.toBe(jobs.JOB.askAboutSelection(b));
  });
});

describe("every starter press goes through the helper", () => {
  const src = (file: string) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text();

  it("the Polaris card's Open · Show it presses the opener, not a focus-only call", async () => {
    const card = await src("components/polaris/PolarisCard.tsx");
    expect(card, "a dead session must be replaced, not shown ended").not.toContain("showBenchFromPage");
    expect(card).toContain('onClick={() => void go()}>{open ? "Open · Show it" : "Assisted setup"}</Button>');
    // Adoption for a pre-jobs tab is opt-in, and this is a singleton: it claims.
    expect(card).toContain("JOB.polarisSetup, ASSIST_TITLE");
  });

  it("the Lantern's button asks the opener every time", async () => {
    const view = await src("components/agents/AgentsView.tsx");
    expect(view).not.toContain("showBenchFromPage");
    expect(view).toContain("const r = await askLantern();");
  });

  it("a hand-off presses the opener every time", async () => {
    const view = await src("components/LanternView.tsx");
    expect(view).not.toContain("showBenchFromPage");
    expect(view).toContain("const r = await handOff(session, kind.id, job);");
  });

  it("Docker's Analyze with agent is not disabled by a tab that may be dead", async () => {
    const view = await src("components/DockerPanel.tsx");
    expect(view).not.toContain("cleanupOpen");
    expect(view).toContain("disabled: gate.disabled,");
  });

  it("the flight plan's line keys the plan and adopts nothing by title", async () => {
    const view = await src("components/flightPlan/FlightPlanView.tsx");
    expect(view).toContain("<BenchJobLine root={sel?.plan.root ?? \"\"} job={JOB.flightAuthor(selected)} what=");
  });

  it("their explanations are the app's tooltip, and the sparkle is on the icon ladder", async () => {
    expect(await src("components/agents/AgentsView.tsx")).toContain('data-tip="A session on the floating bench');
    expect(await src("components/agents/AgentsView.tsx")).toContain('<Ph name="sparkle" size={ICON.sm} />');
    expect(await src("components/LanternView.tsx")).toContain('data-tip="Hand this conversation');
    expect(await src("components/docker/Header.tsx")).toContain("data-tip={analyze.tip}");
    expect(await src("components/DockerPanel.tsx")).toContain("tip: gate.disabled ? gate.reason");
  });
});

describe("the page says where it went", () => {
  const line = () => renderToStaticMarkup(
    React.createElement(BenchJobLine, { root: ROOT, job: jobs.JOB.polarisSetup, claim: ASSIST_TITLE, what: "Assisted setup" }),
  );

  it("draws nothing before the session exists", () => {
    expect(line()).toBe("");
  });

  it("names the session, the checkout and a Show it, once it does", async () => {
    await press();
    const html = line();
    expect(html).toContain("Opened in the bench");
    expect(html).toContain("Assisted setup");
    expect(html).toContain("orbit");
    expect(html).toContain("Show it");
    // Announced, not just drawn: a button pressed by a screen reader must say it happened.
    expect(html).toContain('role="status"');
  });

  it("goes away when the tab is closed, and comes back with the next press", async () => {
    const first = await press();
    bench.closeTab(ROOT, first.id!);
    expect(line()).toBe("");
  });

  it("Show it closes Settings first — the bench is behind the modal it was opened from", async () => {
    const src = await Bun.file(new URL("../src/components/BenchJobLine.tsx", import.meta.url)).text();
    expect(src).toContain("closeSettings();");
    expect(src).toContain("showBenchTab(id);");
  });
});

describe("no caller seats a session around the helper", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) ? [`${dir}${e.name}`] : []));

  it("adds a term or agent tab in one place only", async () => {
    const text = await Promise.all(files(root).map(async (f) => [f, await Bun.file(f).text()] as const));
    const seats = text.filter(([, s]) => /addTab\([^)]*kind:\s*"(?:term|agent)"/.test(s)).map(([f]) => f.replace(root, ""));
    expect(seats, "a session tab is seated by benchJobs.ts, so its button can be idempotent and say so").toEqual([]);
  });

  it("every opener in lanternAsk goes through openBenchJob", async () => {
    const src = await Bun.file(new URL("../src/lib/lanternAsk.ts", import.meta.url)).text();
    for (const name of ["askOnBench", "askBuilderOnBench", "openTicketOnBench", "handOff", "askLantern"]) {
      const at = src.indexOf(`export async function ${name}(`);
      expect(at, name).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf("\n}\n", at));
      // askBuilderOnBench is the engine picker in front of askOnBench, which is the funnel.
      expect(body, `${name} bypasses openBenchJob`).toMatch(/openBenchJob\(|askOnBench\(/);
    }
    // askBuilderOnBench mints nothing itself: it reads the engine and hands to askOnBench.
    const from = src.indexOf("export async function askBuilderOnBench(");
    const to = src.indexOf("export async function openTicketOnBench(");
    expect(src.slice(from, to)).not.toContain("termAgentTicket");
  });

  /* The callers that start a bench session from a page. Each keys its own job,
     asks the shared hook whether it is open, and draws the shared line; a new
     starter that does none of those fails here. TerminalPanel is deliberately
     absent: its "Ask about this" is the terminal's own bar, not a settings
     button, and it already keys the chat by the selection it asks about. */
  const callers: [string, string][] = [
    ["components/polaris/PolarisCard.tsx", "JOB.polarisSetup"],
    ["components/DockerPanel.tsx", "JOB.dockerAnalyze"],
    ["components/agents/AgentsView.tsx", "JOB.lantern"],
    ["components/LanternView.tsx", "JOB.handOff"],
    ["components/flightPlan/FlightPlanView.tsx", "JOB.flightAuthor"],
  ];
  for (const [file, job] of callers) {
    it(`${file} keys its session and draws the line`, async () => {
      const src = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text();
      // A starter that can be pressed twice in a row asks the hook; a page that
      // only draws the line (flight plan's plan list) still keys it with the job.
      expect(src).toMatch(/useBenchJob\(|<BenchJobLine/);
      expect(src).toContain("<BenchJobLine");
      expect(src).toContain(job);
    });
  }
});

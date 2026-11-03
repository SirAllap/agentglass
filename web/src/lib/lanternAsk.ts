/*
 * "ASK ABOUT THE FIELD" — the Lantern's chat, as a tab on the floating bench.
 *
 * Herdr's Lantern is a chat in a pane. Here it is an agent tab on the bench:
 * reachable from any view with the bench's own chord, floating over the
 * Lantern itself so the board and the conversation are on screen together,
 * and a tmux session underneath, so closing the window does not end it. The
 * Chat view was the first answer and the wrong one — it was hidden from the
 * rail, and every agent already lives in a pane.
 *
 * The server composes the first message (the field as it is now) and mints
 * the ticket; nothing about what runs travels from here. Each opener below
 * only says what its job is and how to mint one, and benchJobs.ts decides
 * whether that job already has a session in this checkout.
 *
 * One Lantern tab: asking again brings the one that is there to the front
 * rather than seating a second agent beside it — the same rule Lantern's own
 * `open` follows.
 */
import { api } from "./api.ts";
import { coldSlot, JOB, newJob, openBenchJob, type BenchOpen } from "./benchJobs.ts";

export const LANTERN_TAB_TITLE = "lantern";
/** The one bench tab whose close ENDS what it runs: the observer must not
 *  outlive the window it was opened in, or it shows up on its own board. */
export const isLanternTab = (t: { kind?: string; title?: string }): boolean => t.kind === "agent" && t.title === LANTERN_TAB_TITLE;

/**
 * A chat on the bench that opens with a message of yours — for a selection in
 * a pane that has no agent to ask. The prompt goes through the same ticket the
 * "start an agent" menu uses (POST /terminal/agent), never through the
 * terminal socket by text.
 *
 * `job` is what makes two presses the same chat. Callers with a lasting job
 * pass their own (a selection's text), so asking about the same thing again
 * lands in the chat that already has it; without one it is a fresh chat per
 * press, and it claims no older tab of that title.
 *
 * `claim` is opt-in, and only a job that is one for the whole app may pass it
 * (Assisted setup, Docker cleanup, the Lantern): an unclaimed tab found by its
 * title has no way to say which selection or plan it was for, so a job keyed by
 * one must never adopt it.
 */
export async function askOnBench(cwd: string, prompt: string, title = "ask", kind?: string, job?: string, claim?: string): Promise<BenchOpen> {
  return openBenchJob({
    job: job ?? newJob("ask"), root: cwd, ...(job && claim ? { claim } : {}),
    create: async () => {
      const r = await api.termAgentTicket(cwd, prompt, false, title, kind)
        .catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; ticket?: string; error?: string }));
      if (!r.ok || !r.ticket) return { ok: false, error: r.error ?? "could not start a chat" };
      return { ok: true, root: cwd, tab: { kind: "agent", slot: await coldSlot(cwd), title, agent: r.ticket } };
    },
  });
}

/**
 * askOnBench on the engine the person set for the builder role (Settings,
 * Worker roles). POST /terminal/agent with no kind means Claude, so the choice
 * is made here, and a CLI that is not installed is said out loud: the server
 * would otherwise fall back to a plain shell in the tab.
 */
export async function askBuilderOnBench(cwd: string, prompt: string, title: string, job?: string, claim?: string): Promise<BenchOpen> {
  const w = await api.workerRoles().catch(() => null);
  const kind = w?.roles?.builder?.provider;
  if (!w?.ok || !kind) return { ok: false, error: w?.error ?? "could not read Worker roles" };
  const p = w.providers?.find((x) => x.id === kind);
  if (p && !p.installed) return { ok: false, error: `${p.title} is not installed here` };
  return askOnBench(cwd, prompt, title, kind, job, claim);
}

/** An agent tab on the bench for a ticket the server already minted (the Flight plan's author and its launch). */
export async function openTicketOnBench(cwd: string, ticket: string, title: string, job?: string): Promise<BenchOpen> {
  const tabTitle = title.slice(0, 24);
  return openBenchJob({
    job: job ?? newJob("ticket"), root: cwd,
    create: async () => ({ ok: true, root: cwd, tab: { kind: "agent", slot: await coldSlot(cwd), title: tabTitle, agent: ticket } }),
  });
}

/** Hand a session's conversation to another agent on the bench. The checkout is
 *  the server's answer, which is why the job — not the root — is what names it. */
export async function handOff(session: string, kind: string, job = JOB.handOff(session, kind)): Promise<BenchOpen> {
  return openBenchJob({
    job, root: "",
    create: async () => {
      const r = await api.agentHandoff(session, kind)
        .catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; ticket?: string; cwd?: string; title?: string; error?: string }));
      if (!r.ok || !r.ticket || !r.cwd) return { ok: false, error: r.error ?? "could not hand off" };
      return { ok: true, root: r.cwd, tab: { kind: "agent", slot: await coldSlot(r.cwd), title: (r.title ?? "handoff").slice(0, 24), agent: r.ticket } };
    },
  });
}

export async function askLantern(): Promise<BenchOpen> {
  /* One chat for the whole app, so the job is the key rather than a checkout:
     reuse is decided BEFORE a ticket is minted — a ticket is single-use and
     short-lived, and one minted for a tab that is then merely brought to the
     front is wasted. */
  return openBenchJob({
    job: JOB.lantern, root: "", claim: LANTERN_TAB_TITLE,
    create: async () => {
      const r = await api.lanternTicket()
        .catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; ticket?: string; cwd?: string; error?: string }));
      if (!r.ok || !r.ticket || !r.cwd) return { ok: false, error: r.error ?? "could not start the Lantern's chat" };
      return { ok: true, root: r.cwd, tab: { kind: "agent", slot: await coldSlot(r.cwd), title: LANTERN_TAB_TITLE, agent: r.ticket } };
    },
  });
}

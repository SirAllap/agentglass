// Control plane: a PreToolUse gate. An opt-in hook long-polls POST /gate with a
// pending tool call; agentglass holds it open until a human approves/denies from
// the dashboard (or a timeout auto-allows). This is the remote for the fleet.
//
// Safety: default-allow on timeout, and the hook exits 0 (allow) if agentglass
// is unreachable — the control plane never blocks agents by accident.
//
// Durability: every request is written to SQLite on arrival and updated when it
// resolves. A restart re-hydrates the still-live ones (see restoreGates), so a
// crash no longer turns "waiting for a human" into a silent auto-allow, and the
// held connection is no longer the only place a pending request exists — a hook
// whose connection dropped can re-attach with awaitGate(id).
import type { PendingGate } from "../../shared/types.ts";
import { pushGate, describeSession } from "./alerts.ts";
import { paneForSession, paneAgentNote } from "./panewt.ts";
import { recordGate, resolveGateRow, undecidedGates, getGate } from "./db.ts";
// Only to ask what an actor string means. actions.ts owns that vocabulary and
// db.ts is already an edge of this module, so this adds no load-time weight —
// the thing submitGate's comment below is careful about.
import { isMachineActor, MACHINE_ACTOR } from "./actions.ts";
export type GateDecision = "allow" | "deny";
export type GateOutcome = { decision: GateDecision; reason: string };

interface Pending extends PendingGate {
  expires: number;
  /** Why this one is worth looking at beyond the tool it names — see
   *  budgetHold(). Absent on the overwhelming majority of requests, which is
   *  the point: it only appears when a limit somebody set has been passed. */
  budget?: string;
  // The held connection, when there is one. A restored request has none until a
  // hook re-attaches — it is still pending, still decidable, still in the queue.
  resolve?: (d: GateOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

// The gate is fail-open by design: a timeout (or an unreachable server) never
// blocks an agent. Set this to invert that — a tool call that no human decides
// within the timeout is DENIED. Opt-in, because it means a slow or absent human
// stops the fleet; that is the point for security-sensitive use.
const FAIL_CLOSED = process.env.AGENTGLASS_GATE_FAILCLOSED === "1";
/** Exported so the route wording the budget reason says the same thing this
 *  module will actually do when nobody answers. */
export const gateFailClosed = (): boolean => FAIL_CLOSED;

// How long a request is held when the caller doesn't ask for something else.
//
// This shipped at 60 seconds, which is the one case the gate exists for turned
// into a bug: you are away from the desk, the phone is in a pocket, and a minute
// later the call nobody looked at proceeds unreviewed — with the dashboard still
// showing it as though a decision were coming. Five minutes is a window a person
// can actually win. It is still fail-OPEN when it elapses (see timeoutOutcome);
// inverting that would start blocking agents on the operator's own machine after
// an upgrade, which is their call to make with AGENTGLASS_GATE_FAILCLOSED=1.
//
// Kept in step with DEFAULT_TIMEOUT in hooks/gate_event.py — the hook decides how
// long it is willing to hold and the server decides how long it will hold for, so
// two different numbers means the wait somebody configured is not the wait they
// get. server/test/gate-defaults.test.ts reads the Python file and fails if the
// two part company.
export const GATE_DEFAULT_MS = (Number(process.env.AGENTGLASS_GATE_TIMEOUT) || 300) * 1000;

// The clamp is a DoS guard (each waiter pins a held connection + timer), but a
// hard 120s silently defeated the documented AGENTGLASS_GATE_TIMEOUT knob: an
// operator asking for a 5-minute approval window got auto-resolved at 2. The
// operator's own configured timeout now raises the ceiling.
//
// The floor is the shipped default rather than a smaller number of its own,
// because a caller may now ask for a window per hook entry (gate_event.py's
// --timeout, one settings.json matcher at a time). A ceiling below the default
// would silently clip the patient matchers — the ones most likely to be gating
// something worth waiting for — back to less than the global wait.
export const GATE_MAX_MS = Math.max(300_000, GATE_DEFAULT_MS);

const waiters = new Map<string, Pending>();
let onChange: () => void = () => {};
export function onGateChange(fn: () => void) { onChange = fn; }

/** What a timeout resolves to, under the configured policy. */
function timeoutOutcome(): GateOutcome {
  // Same audience as defaultReason(): a model deciding what to do next. This
  // one is emphatically NOT a judgement about the call — nobody looked at it —
  // and an agent that treats it as one will start avoiding a perfectly fine
  // approach for the rest of the session.
  if (FAIL_CLOSED) {
    return {
      decision: "deny",
      reason: "Nobody answered this request in time and agentglass is configured fail-closed, so it was blocked without a human seeing it. This is not a judgement about the call. Say that you were blocked waiting for approval rather than assuming the approach was wrong.",
    };
  }
  // Empty reason so the hook falls through to Claude Code's own permission
  // prompt instead of force-allowing — an auto-allow shouldn't silently
  // skip the human it was meant to ask.
  return { decision: "allow", reason: "" };
}

/** Ids come from the hook now (so it can re-attach after a dropped connection),
 *  which makes them attacker-influenceable. Accept only uuid-shaped ones; a
 *  request that brings anything else gets a server-generated id instead. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validGateId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

function finish(
  id: string,
  out: GateOutcome,
  resolution: "human" | "timeout" | "restart",
  /** Who, when a person decided. The timeout path leaves this null on purpose:
   *  an outcome nobody chose must not arrive carrying an actor. */
  by: string | null = null,
): void {
  const w = waiters.get(id);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(id);
  }
  resolveGateRow(id, out.decision, out.reason, resolution, Date.now(), by);
  w?.resolve?.(out);
  onChange();
}

/**
 * Why the human is being shown this particular call, when the project it came
 * from has already spent what it was given.
 *
 * Every cost tracker in this category reports. A bar turns red on a dashboard
 * nobody has open and the fleet carries on spending; the proxies that CAN stop
 * a request sit a layer down, where there is no such thing as a worktree or a
 * task. The gate is the one place in this app that has already stopped a tool
 * call AND knows which checkout it came from, so it is the one place the number
 * can arrive while it still matters.
 *
 * It changes what the hold SAYS and never what it does. The call is held for
 * exactly as long as it would have been, the timeout resolves under exactly the
 * policy it would have (see timeoutOutcome — deliberately not consulted here),
 * and a project with no budget set, which is nearly all of them, is untouched.
 * A cost tracker that halts somebody's agents on a limit nobody chose is a
 * worse product than one that only reports.
 *
 * Which is also why the whole thing sits in a try/catch. It reads config.json
 * and queries SQLite, and a throw would leave /gate answering 500 — allowed by
 * a fail-open hook and DENIED by a fail-closed one. An annotation must not be
 * able to block a tool call by crashing.
 */

/** Arm the expiry timer for a pending request. Anchored to the *original*
 *  deadline, so a reconnect (or a restart) never extends the window. */
function arm(id: string, expires: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => finish(id, timeoutOutcome(), "timeout"), Math.max(0, expires - Date.now()));
  // Don't let a held gate keep the process alive on its own.
  (t as any).unref?.();
  return t;
}

/** Hold a tool call until decided or the timeout auto-allows. */
export function submitGate(
  req: { source_app: string; session_id: string; tool_name: string; summary: string; id?: string },
  timeoutMs: number,
  /*
   * Why the budget reason arrives as an argument instead of being looked up in
   * here, which reads like the obvious place for it.
   *
   * Reaching budget.ts from this module adds the edge gate → budget → config,
   * and the gate is imported by a great many things. Bun keeps a `require()` of
   * a local module as a static dependency, so deferring it does not help: the
   * edge exists at load time either way, and it moved WHEN config.ts and the
   * database layer first initialise for every consumer of the gate. The whole
   * server suite runs in one process, so that is a global fact, not a local one
   * — it cost ten tests in test/usage-across-the-seam.ts, a file this work never
   * touched.
   *
   * The layering is better for it. Holding a call is what this module is; which
   * policies are worth holding one for belongs to the route, which already
   * imports both halves.
   */
  budget?: string
): Promise<GateOutcome> {
  // Floor the timeout: a negative value (a repo-local settings.json can set
  // AGENTGLASS_GATE_TIMEOUT=-1) makes setTimeout fire immediately, turning the
  // gate into an instant auto-allow. Never below 1s, never above GATE_MAX_MS —
  // and a caller who asks for nothing usable gets the default rather than a
  // literal of this function's own, so the two cannot drift.
  const wait = Math.max(1000, Math.min(GATE_MAX_MS, Number.isFinite(timeoutMs) ? timeoutMs : GATE_DEFAULT_MS));
  // A hook that re-POSTs an id it already sent is retrying, not asking twice:
  // re-attach to the live request (or replay the outcome it missed) instead of
  // creating a second one that would strand the first's held connection.
  if (validGateId(req.id)) {
    const again = awaitGate(req.id);
    if (again) return Promise.resolve(again);
  }
  const id = validGateId(req.id) ? req.id : crypto.randomUUID();
  const created = Date.now();
  const expires = created + wait;
  const { source_app, session_id, tool_name, summary } = req;
  // Persist before holding the connection: if the process dies a millisecond
  // later, the request still exists somewhere a restart can find it.
  recordGate({ id, source_app, session_id, tool_name, summary, created, expires });
  // Resolved once, here, so the dashboard and the phone say the same thing
  // about the same request rather than each composing its own name — and so the
  // pane lookup behind them is one query rather than one per surface.
  const pane = paneForSession(session_id);
  const where = describeSession(source_app, session_id);
  return new Promise((resolve) => {
    waiters.set(id, { id, source_app, session_id, tool_name, summary, created, expires,
      where, pane: pane ?? undefined, budget, resolve, timer: arm(id, expires) });
    // The checkout and the tmux window, not a project name and eight
    // characters of a UUID. This is the alert that wakes a phone and expects a
    // decision from the lock screen; it was the least readable of the lot.
    //
    // The gate id no longer rides along: it existed for the two buttons on a
    // Web Push notification, and that whole path is gone. The pane does, and is
    // a destination rather than an answer.
    //
    // The budget line LEADS the notification when there is one. It is short and
    // fixed-length and the summary is neither, and pushGate clips what it is
    // given at 200 characters — a shell command long enough to fill that would
    // push the whole reason off the lock screen, which is the one surface it
    // had to survive on.
    pushGate(where, tool_name, budget ? (summary ? `${budget} · ${summary}` : budget) : summary, pane ?? undefined);
    onChange();
  });
}

/**
 * Re-attach to a request whose connection dropped (a server restart, a proxy
 * hanging up). Returns the recorded outcome if it has already been decided, a
 * promise that resolves when it is if it's still pending, or null when the id
 * is unknown — which the hook must treat as "no answer" rather than as a
 * decision.
 */
export function awaitGate(id: string): Promise<GateOutcome> | GateOutcome | null {
  if (!validGateId(id)) return null;
  const w = waiters.get(id);
  if (w) {
    return new Promise((resolve) => {
      // Last connection wins. The previous one is already gone — that is why
      // the hook is here — and resolving it would write to a dead socket.
      w.resolve = resolve;
    });
  }
  const row = getGate(id);
  if (!row || !row.decision) return null;
  return { decision: row.decision, reason: row.reason || "" };
}

/**
 * What the agent is told when whoever decided types nothing.
 *
 * This string is not a log line. It travels to the hook, which hands it to
 * Claude Code as `permissionDecisionReason` — so it is read by a model that
 * has just been stopped and now has to choose what to do next.
 *
 * "denied from dashboard" told it nothing it could act on. The only moves it
 * leaves are retrying the identical call, which will be denied again, or
 * stalling — and both waste a turn and the human's next interruption. So the
 * default says what happened, that retrying is pointless, and what to do
 * instead.
 *
 * `by` is why there are two of them. The sentence said "A human reviewed this
 * call" unconditionally, and it was handed to the model *whoever* released the
 * hold — including a caller presenting this machine's own token, which the
 * held agent has in its own environment. A model that is told a person looked
 * at a call nobody looked at has been given the one fact this whole feature
 * exists to establish, and given it wrong. So where the deciding principal was
 * the shared token, the model is told that instead: same advice, no fiction.
 *
 * Asked of actions.ts rather than matched here, because the actor string is
 * everything the decision path carries and one module has to own what it means.
 *
 * A reason somebody typed always wins; this is only the empty case.
 */
export function defaultReason(decision: GateDecision, by?: string | null): string {
  if (isMachineActor(by)) {
    return decision === "deny"
      ? "This call was denied in agentglass by a caller holding this machine's own token — not by a person at the desk or on a paired device. Do not retry the same call — it will be denied again. Take a different approach, or ask a person what they would prefer."
      : "This call was released in agentglass by a caller holding this machine's own token — not by a person at the desk or on a paired device. Nobody reviewed it, so do not treat it as approval of the approach.";
  }
  return decision === "deny"
    ? "A human reviewed this call in agentglass and denied it. Do not retry the same call — it will be denied again. Take a different approach, or ask them what they would prefer."
    : "A human reviewed this call in agentglass and approved it.";
}

/**
 * `by` is who the server can honestly say answered — a paired device's name, or
 * the address it came from. It is recorded on the row itself rather than only
 * in the action log, because the two cannot be joined: an action line carries a
 * clipped `tool · summary`, so two gates on the same tool a second apart are
 * indistinguishable in it.
 */
export function decideGate(id: string, decision: GateDecision, reason: string, by: string | null = null): boolean {
  const row = getGate(id);
  // Decidable while pending, whether or not a connection is currently held: a
  // restored request has no waiter and must still take the operator's answer.
  if (!row || row.decision) return false;
  // `by` twice, for two different readers: the row keeps who released the hold,
  // and the backfilled reason has to describe the same principal to the model
  // waiting on the other end. Composing it from anything else is how the two
  // came to disagree.
  finish(id, { decision, reason: reason || defaultReason(decision, by) }, "human", by);
  return true;
}

/**
 * The words a person actually typed, or nothing.
 *
 * `decideGate` backfills an empty reason with `defaultReason`, because the
 * string travels to a model that has just been stopped and needs something it
 * can act on. That makes the stored reason useless to a *reader*: every gate
 * anybody waved through carries the same paragraph, and a history quoting it
 * back would be three lines of boilerplate per row hiding the one row where
 * somebody explained themselves.
 *
 * Compared against the real function rather than a copy of its text, so the two
 * cannot drift into a history that quotes a default it no longer recognises.
 *
 * Against *every* string it can produce, and not against the one the row's own
 * principal would get. A row carries who decided, so looking it up looks like
 * the tighter test — but the reason and the actor are two columns, and the rows
 * that most need reading are the ones where something went wrong between them.
 * Recognising the boilerplate whoever wrote it is what keeps a history of three
 * identical paragraphs from hiding the row where a person explained themselves.
 */
export function typedReason(row: { decision: "allow" | "deny" | null; reason: string | null }): string {
  const r = row.reason || "";
  if (!r || !row.decision) return "";
  const boilerplate = [defaultReason(row.decision, null), defaultReason(row.decision, MACHINE_ACTOR)];
  return boilerplate.includes(r) ? "" : r;
}

/**
 * The queue, as the dashboard and the phone receive it.
 *
 * `budget` rides along rather than being folded into `summary`, for the reason
 * `where` is composed on the server and not on the client: they are different
 * facts about the same request. `summary` is what the agent wants to run and is
 * quoted back in the action log and in history; the budget line is why this
 * particular hold is worth an interruption, and it goes stale the moment the
 * period rolls over.
 */
export function pendingGates(): (PendingGate & { budget?: string })[] {
  return [...waiters.values()]
    // `where` and `pane` travel too. They are resolved once when the hold is
    // taken, and this destructure was silently dropping both — so the client
    // fell back to `${source_app}:${session_id.slice(0,8)}`, which the comment
    // above `where` says identifies nothing, and the note had no destination to
    // click. On the one notification in the app that means an agent is stopped.
    .map(({ id, source_app, session_id, tool_name, summary, created, budget, where, pane }) =>
      ({ id, source_app, session_id, tool_name, summary, created, budget, where, pane }))
    .sort((a, b) => a.created - b.created);
}

/**
 * Rebuild the queue from SQLite at boot.
 *
 * Requests still inside their window go back into "what needs you" and stay
 * decidable — the agent is still held, and its hook is re-polling for exactly
 * this. Ones whose window elapsed while the server was down are resolved by the
 * configured policy and *recorded* as such, so the outcome shows up in history
 * instead of vanishing.
 */
export function restoreGates(): { restored: number; expired: number } {
  const now = Date.now();
  let restored = 0, expired = 0;
  for (const row of undecidedGates()) {
    if (row.expires <= now) {
      const out = timeoutOutcome();
      // out.reason verbatim — never backfilled. timeoutOutcome() leaves the
      // reason EMPTY on a fail-open allow on purpose, so the re-attaching hook
      // falls through to Claude Code's own permission prompt; a non-empty reason
      // makes the hook force-allow and skip that prompt. The live-timeout path
      // (finish → resolveGateRow) preserves the empty reason too, and a restart
      // must not silently turn a pending gate into a prompt-skipping auto-allow.
      resolveGateRow(row.id, out.decision, out.reason, "restart", now);
      expired++;
      continue;
    }
    waiters.set(row.id, {
      id: row.id,
      source_app: row.source_app,
      session_id: row.session_id,
      tool_name: row.tool_name,
      summary: row.summary,
      created: row.created,
      expires: row.expires,
      timer: arm(row.id, row.expires),
    });
    restored++;
  }
  if (restored || expired) onChange();
  return { restored, expired };
}

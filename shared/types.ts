// Shared event + analytics contract between server and web.
// Keep this file dependency-free so both sides can import it.

export type HookEventType =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "PreCompact";

/** Raw payload posted by the Claude Code hook. */
export interface IngestBody {
  source_app: string;
  session_id: string;
  hook_event_type: HookEventType | string;
  /** Opaque retry key, unique within one source_app + session_id. */
  event_id?: string;
  /** Authoritative cost for this event when the sender already knows it. */
  reported_cost_usd?: number;
  payload?: Record<string, unknown>;
  /** The tmux pane the agent is running in (`%3`), when the sender is inside
   *  one. Only the hook can know this — see panewt.ts. */
  tmux_pane?: string;
  /** Optional transcript array (assistant/user messages with `usage`). */
  chat?: unknown[];
  summary?: string;
  model_name?: string;
  timestamp?: number; // ms; server stamps if absent
}

/** A normalized, stored event as returned by the API / WS. */
export interface WatchEvent {
  id: number;
  source_app: string;
  session_id: string;
  event_id?: string | null;
  hook_event_type: string;
  tool_name: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  model_name: string | null;
  /** Coarse vendor for this event's model (providerOf), set at insert. NULL when
   *  the model never resolved. Per-event so a session that switched providers is
   *  attributed to the model that actually produced each event. */
  provider: string | null;
  is_error: number; // 0 | 1
  error_text: string | null;
  duration_ms: number | null; // filled on PostToolUse via pre→post pairing
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /**
   * Every token class weighted by its own price and expressed in uncached input
   * tokens — one comparable number in place of four kinds of token that differ
   * by up to fifty times in what they cost.
   *
   * Derived on the server, where the price table lives, exactly as `cost_usd`
   * already is. Optional because an older server does not send it: absent means
   * unknown, and a reader must fall back to the raw classes rather than to 0.
   */
  equiv_tokens?: number;
  cost_usd: number;
  summary: string | null;
  timestamp: number; // ms
  payload: Record<string, unknown>;
}

export interface SessionRollup {
  session_id: string;
  source_app: string;
  model_name: string | null;
  /** Directory the session ran in — what a resume needs to run in the right
   *  place. Null for rows recorded before the column existed. */
  project_path?: string | null;
  /** The exact checkout it ran in, when that isn't the repo root — a linked
   *  worktree or a monorepo subdir. This is what tells two agents apart when
   *  several are working the same project on different branches. */
  cwd_path?: string | null;
  /** What this session is called. `custom_title` is a rename by hand and wins;
   *  `ai_title` is the one the agent generated. Both come from the transcript,
   *  so they're absent for hook-only sessions. Use sessionTitle() rather than
   *  reading them directly — the precedence is the whole point. */
  custom_title?: string | null;
  ai_title?: string | null;
  /**
   * The first thing you asked this session to do.
   *
   * Only present when there is no title, because that is the only time it is
   * needed — and it is what stops a list of thirty rows all reading
   * `agentglass:cd3fa401`. Derived from the `UserPromptSubmit` event that is
   * already in the database, so it names sessions recorded long before anyone
   * thought to write a title.
   */
  first_prompt?: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen: number;
  event_count: number;
  tool_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Weighted tokens in uncached-input units — see WatchEvent.equiv_tokens.
   *  Optional: absent means an older server, not zero. */
  equiv_tokens?: number;
  cost_usd: number;
}

export interface CostByModel {
  model_name: string;
  /**
   * True when at least one raw model id folded into this row has no rate in
   * the price table, so any cost here the provider did not report exactly is
   * a fallback at DEFAULT_PRICE. Optional — an older server does not send it,
   * and absent means unknown rather than false.
   */
  unpriced?: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Weighted tokens in uncached-input units — see WatchEvent.equiv_tokens.
   *  Optional: absent means an older server, not zero. */
  equiv_tokens?: number;
  cost_usd: number;
  sessions: number;
}

export interface ToolLatencyStat {
  tool_name: string;
  /** Every invocation — the count the totals row and the per-app rollup
   *  also use, so the panels agree. */
  calls: number;
  /**
   * How many of those calls the percentiles were actually computed from.
   *
   * A percentile is only as good as its sample, and a Post without a paired
   * Pre contributes a call but no duration — normal for the OTLP-logs path
   * and for hook payloads with no tool_use_id. So "200 calls · p95 5ms"
   * could be five milliseconds measured twice, and nothing on the wire said
   * so. Optional: an older server does not send it, and a missing value
   * means unknown, not zero.
   */
  timed?: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  avg_ms: number;
  total_ms: number;
}

export interface TimeBucket {
  t: number; // bucket start, ms
  events: number;
  errors: number;
  cost_usd: number;
  tokens: number;
}

/**
 * One UTC day of the fleet, from the retention rollup, the live events, or
 * both — the day the prune's cutoff falls in is split across the two and is
 * only whole once they are added.
 *
 * Day-grained on purpose. Everything here survives being folded into a daily
 * summary; a percentile does not (a mean of p95s is a p95 of nothing), so the
 * mean is the only latency this shape can honestly carry.
 */
export interface UsageDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  events: number;
  tool_calls: number;
  tool_errors: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Weighted tokens in uncached-input units — see WatchEvent.equiv_tokens.
   *  Optional: absent means an older server, not zero. */
  equiv_tokens?: number;
  cost_usd: number;
  sessions: number;
  /** Mean tool duration, ms. */
  avg_ms: number;
}

/** The daily series plus what it is honest about: where day summaries end and
 *  whole events begin, and how long events are kept in the first place. */
export interface UsageHistory {
  days: UsageDay[];
  /** UTC day the retention boundary falls in; null when nothing is pruned. */
  seam_day: string | null;
  /** AGENTGLASS_RETENTION_DAYS. 0 means events are never pruned. */
  retention_days: number;
  /** Oldest day the rollup holds, or null when it is empty. */
  rollup_from: string | null;
}

/** Named `QuotaWindow`, not `UsageWindow`: that name used to belong to the
 *  Anthropic-specific `{ utilization, remaining, resets_at }` in
 *  web/src/lib/api.ts. Two differently-shaped types under one name, in a
 *  file that consumed both, was a trap. That shape and its last consumer
 *  were deleted once this feature replaced them, but the distinct name is
 *  kept so a future `UsageWindow` cannot silently collide again. */
export type QuotaWindow = {
  /** "5h", "weekly" — derived from the provider's window length. */
  label: string;
  /** Window length in minutes, so consumers can order short-before-long
   *  without parsing the label back into a number. */
  minutes: number;
  usedPercent: number;
  /** ISO 8601, or null when the provider does not say. */
  resetsAt: string | null;
};

export type ProviderUsage = {
  provider: "anthropic" | "codex" | "antigravity";
  /** How the provider is named on screen. */
  label: string;
  available: boolean;
  windows: QuotaWindow[];
  /** Plan name where the provider reports one ("plus", "max"). */
  plan?: string;
  /** When this reading was taken, epoch ms. Live for Anthropic; the last
   *  recorded turn for Codex. Absent when there is no reading. */
  observedAt?: number;
  /** Why there is nothing, when there is nothing. Rendered to the user, so it
   *  is a sentence rather than an error code. */
  note?: string;
};

export interface SkillUsage {
  skill: string;
  calls: number;
  /** Cost attributed to this skill (events charged to the running skill). */
  cost_usd: number;
  last_used: number;
  /** Run counts across the window, oldest bucket first. */
  buckets: number[];
}

export interface AppUsage {
  source_app: string;
  events: number;
  sessions: number;
  tool_calls: number;
  cost_usd: number;
  tokens: number;
}

export interface TypeCount {
  hook_event_type: string;
  count: number;
}

/** A skill or slash-command discovered on disk, joined with its recorded usage. */
export interface SkillInfo {
  name: string;
  kind: "skill" | "command";
  description: string;
  argument_hint: string | null;
  /** Canonical origin: "user" or the project dir name (e.g. "shop-api"). */
  source: string;
  /** How many locations define it (worktree copies collapse into one entry). */
  copies: number;
  path: string;
  /** When the skill was ADDED: git first-commit date where available,
   *  otherwise the oldest file mtime across copies (checkout mtimes cluster,
   *  so git dates are strongly preferred for "newest" sorting). */
  added: number;
  /** Runs recorded in the events DB (bounded by retention). */
  calls: number;
  last_used: number | null;
  /** Cost attributed to this skill's runs (bounded by retention). */
  cost_usd: number;
  /** Derived grouping for discovery (e.g. "testing & QA", "PRs & review"). */
  category: string;
  /** The "Use when…" sentence extracted from the description, if present. */
  when_to_use: string | null;
}

export interface StatsSummary {
  totals: {
    events: number;
    sessions: number;
    tool_calls: number;
    /** Every errored event, whatever kind — the honest "how much went wrong". */
    errors: number;
    /**
     * Errors that were a tool call failing. The only numerator `tool_calls` is
     * a legitimate denominator for: `errors` also counts LLM spans and
     * notifications, which never enter `tool_calls`. Optional so an older
     * server's payload still renders — treat a missing value as unknown, not 0.
     */
    tool_errors?: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    /** Weighted tokens in uncached-input units — see WatchEvent.equiv_tokens.
     *  Optional: absent means an older server, not zero. */
    equiv_tokens?: number;
  };
  by_model: CostByModel[];
  tool_latency: ToolLatencyStat[];
  timeline: TimeBucket[];
  top_skills: SkillUsage[];
  by_app: AppUsage[];
  by_type: TypeCount[];
  /** Event counts by day-of-week × hour (length 168 = 7*24), local time. */
  heatmap: number[];
  window_ms: number;
  /** Wall-clock ms when the server process started — what the header's
   *  uptime counts from. Absent in demo mode, where nothing is "up". */
  server_started_at?: number;
  /**
   * AGENTGLASS_RETENTION_DAYS, so the window chips can tell the truth.
   *
   * Every number in this object comes from the events table, which is pruned
   * at that many days — so a window longer than it is answered with less data
   * than its own label claims. 0 means nothing is pruned and every window is
   * exactly what it says. Absent in demo mode's older payloads.
   */
  retention_days?: number;
}

/** One tmux window, as tmux itself reports it. The panel renders these as its
 *  own tabs; tmux stays the source of truth for which is active. `flags` is
 *  tmux's own marks (`*` current, `-` last, `!` bell, `#` activity, `Z` zoomed),
 *  passed through rather than interpreted server-side. */
export interface TmuxWindow {
  /** tmux's own id for the window (`@3`). Stable for the window's whole life,
   *  which the index is not: killing a window renumbers the ones after it when
   *  `renumber-windows` is on. Commands target this; the index is for display. */
  id: string;
  index: number;
  name: string;
  active: boolean;
  flags: string;
  /**
   * A prompt tmux would have drawn, handed to the panel instead.
   *
   * While the panel owns the status line there is no row for tmux to draw a
   * command prompt into, so `prefix ,` and `prefix .` set a window option here
   * rather than prompting. The server reads it on its next sweep, clears it,
   * and the panel opens its own input on that window. Absent almost always —
   * it exists for the one sweep between the keystroke and the panel reacting.
   */
  ask?: "rename" | "move";
  /**
   * A phone is looking at a pane in this window right now.
   *
   * Not something tmux reports — it is read back off our own grouped sessions,
   * which are named after the pane they joined. It is here because a phone is
   * otherwise completely invisible from the desk: it shares the window, so what
   * it does (a reflow, a moved cursor, a pane that scrolls on its own) arrives
   * with nothing to attribute it to. Absent, rather than false, when nobody is.
   */
  phone?: boolean;
  /**
   * The agent running in one of this window's panes finished its turn, and the
   * desk has not looked at this tab since.
   *
   * Derived server-side from the transcript's own end-of-turn event (`Stop`),
   * not from tmux's activity flag: the flag fires on any output — an agent still
   * working, nvim redrawing, every window at once when the desk re-attaches —
   * none of which is "done". A pane with no agent never sets this. Cleared the
   * moment the tab becomes the active one (you looked). Absent when not done.
   */
  agentDone?: boolean;
  /**
   * How big tmux is drawing this window right now.
   *
   * Here because `phone` cannot answer the question the desk actually has. A
   * phone that attached without asking for a fit costs the desk nothing, so a
   * notice fired on `phone` would cry wolf on the common case; the observable
   * that matters is *this window is narrower than my terminal*, and it is this
   * pair against the client size on the same frame.
   *
   * Compare COLUMNS only. Measured: a 200x50 client gives a 200x49 window
   * because tmux spends a row on the status line, so a rows comparison
   * false-positives by one on every desk that has a bar.
   *
   * Absent, rather than 0, when tmux did not answer with a size — a 0 reads as
   * "narrower than everything" and would put the notice on a window nobody has
   * touched. Guard for it (`w.cols && w.cols < client.cols`) rather than
   * defaulting it.
   */
  cols?: number;
  rows?: number;
}

/**
 * A tmux pane in the window on screen, and where it sits on the grid.
 *
 * Reported because the app cannot see it any other way. tmux draws its splits
 * INSIDE one terminal — a single xterm, one DOM element — so from the browser
 * there is nothing to hover: no element per pane, no boundary, no hit test.
 * With the geometry in hand the pointer's cell answers "which pane is this",
 * and tmux is told to select it.
 *
 * Bounds are inclusive cell coordinates in the window's own grid, exactly as
 * tmux reports them, and that grid is the terminal's — so a cell in the xterm
 * is a cell here with no conversion.
 */
export interface TmuxPane {
  /** tmux's own id (`%7`), which is what `select-pane` takes. */
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  active: boolean;
  /**
   * The window has a pane zoomed.
   *
   * Carried on every pane because it invalidates all of their geometry at once:
   * a zoomed pane covers the window while the others still report the bounds
   * they had, so more than one pane claims the same cell and "which pane is
   * under the pointer" has no answer worth acting on.
   */
  zoomed: boolean;
}

/**
 * The /terminal/pty protocol, server → client.
 *
 * The newest wire in the app and, until this, the only one with no contract at
 * all: the server hand-rolled each frame inside `ctl()`, the desk declared a
 * bag of optional fields at its `onmessage`, and the phone declared a DIFFERENT
 * bag at its own. Three descriptions of one protocol, and only ever two of them
 * were edited together — which is not a hypothesis. `TmuxWindow` above is the
 * payload of the `tmux` frame and has been in here all along; the frame that
 * carries it was not.
 *
 * What that cost, concretely: rename `by` on the `pane` frame, or fold `cols`
 * and `rows` into a `size` object, and the server and the desk stay green while
 * the phone silently loses its "you are seeing 80 of 200 columns" hint and
 * keeps a fitted UI over a window that is no longer fitted — the exact failure
 * TerminalView.tsx's own comment records as having shipped once.
 *
 * A discriminated union rather than one wide interface, so each end must narrow
 * on `t` before it can read a field, and so a field can only be read from the
 * frame that actually carries it.
 *
 * Binary frames are not in here and cannot be: they are raw pty bytes with no
 * envelope, which is the point of them.
 */
export type PtyServerFrame =
  /**
   * The shell is up. Sent exactly once per socket.
   *
   * `pane` is the tmux window's REAL size and is present only for a pane
   * attach: a phone needs it to know it is looking at a slice, because without
   * a fit tmux renders at the desk's width and the columns past the phone's own
   * never arrive. `resize` is false on the backends with no pty behind them,
   * where there is no TIOCSWINSZ to make.
   */
  | { t: "ready"; mode: "pty" | "pipe"; shell: string; cwd: string; resize: boolean; pane?: { cols: number; rows: number } }
  /**
   * The window changed size under an attach that is already open.
   *
   * The second writer of what `ready.pane` said once. `fit` is whether this
   * client is still the one the window is sized to, and `by` is who moved it.
   *
   * `"phone"` is this client's own width control coming back as a fact. It is
   * not bookkeeping: `window-size largest` means the window is as wide as the
   * widest client, so asking for 60 columns moves the real window ONLY when
   * nothing wider is attached — and nothing used to say which of those had
   * happened. The screen inferred it by comparing the one size it had ever been
   * told against the width it was asking for when it was told, and at a fresh
   * attach those are equal for a reason that has nothing to do with this phone:
   * an 80-column desk and an 80-column default. So a phone at 60 in front of an
   * 80-column desk claimed the window was 60 "for the computer too" while
   * twenty columns were falling off the right. Answering with the window's real
   * size after every resize is what makes the claim checkable instead of
   * guessed.
   */
  | { t: "pane"; cols: number; rows: number; fit: boolean; by: "desk" | "phone" }
  /**
   * tmux, as the server's twice-a-second sweep sees it.
   *
   * `session`, `prefix` and `client` ride only on the active frame — there is
   * no session to name when tmux has gone — so they are optional here and the
   * inactive frame is `{ active: false, windows: [], panes: [] }`.
   */
  | { t: "tmux"; active: boolean; windows: TmuxWindow[]; panes: TmuxPane[]; session?: string | null; prefix?: string[]; client?: { cols: number; rows: number } | null }
  /**
   * A window this socket was asked to open, and the pane it landed on.
   *
   * Answered rather than left to the poll, because the poll cannot tell the
   * caller WHICH tab is theirs. `/terminal/panes` is re-read every couple of
   * seconds and a phone that guessed "the newest one" would open whatever the
   * desk happened to create in the same beat. The id is the only unambiguous
   * answer, and it is what lets a `+` land the user inside the thing they just
   * asked for instead of next to it.
   *
   * `cwd` is the directory the window was actually opened in — the project
   * root, not the pane's subdirectory — so a client can say where it went
   * without asking a second question.
   */
  | { t: "opened"; pane: string; window: string; cwd: string }
  /**
   * That window did not open, and why — which is NOT a `fatal`.
   *
   * `fatal` means this socket is over: the client paints "Disconnected" and the
   * pane it was showing goes with it. A `+` that could not work out which
   * project the pane is in has broken nothing, and answering it with the frame
   * that tears the terminal down would turn a button that did not work into a
   * terminal that died.
   */
  | { t: "openfail"; error: string }
  /** The shell ended by itself. The socket closes right behind this. */
  | { t: "exit"; code: number | null }
  /** The server is refusing, and saying why — "that pane is gone", a disabled
   *  terminal, a shell that would not spawn. The one control frame the phone
   *  puts on screen verbatim, because it is an answer somebody can act on. */
  | { t: "fatal"; error: string };

/**
 * The /terminal/pty protocol, client → server.
 *
 * Everything under `t: "tmux"` is something a keybinding could already do, so
 * none of it adds capability to a socket that already carries a shell. Note
 * what is NOT here: a command string. The client sends a pull request number,
 * or a directory and a boolean, and the server builds what actually executes —
 * see ptyMessage, where that division is the security boundary.
 */
export type PtyClientFrame =
  /** Keystrokes, straight to the shell's stdin. */
  | { t: "in"; d: string }
  /** This client's grid. Also reflows the tmux window when the attach asked
   *  for a fit — see `fitWindow`. */
  | { t: "resize"; cols: number; rows: number }
  /** Show or hide tmux's own status line while the panel is drawing its own. */
  | { t: "tmux"; cmd: "status"; visible?: boolean }
  /** Focus-follows-mouse inside tmux. The narrowest command here on purpose:
   *  it is the only one sent without a click behind it. */
  | { t: "tmux"; cmd: "selectpane"; pane: string }
  /**
   * Move the pane's scrollback by `lines` — negative back into history.
   *
   * A COUNT, not a key. That distinction is the whole of it: a finger on a
   * phone used to be turned into wheel events, and xterm answers a wheel on the
   * alternate screen with no scrollback by sending a CURSOR KEY — measured
   * through the shipped page against a real pane running `cat -v`, one drag
   * delivered 53 of them, a mix of ESC[B and ESC O B. At a shell those walk
   * history onto the prompt; in an agent's TUI they move the selection, and one
   * of the things they can move is an Allow/Deny gate. A scroll must never be
   * able to become a keystroke a program can act on, so when nothing is
   * listening for a mouse the page stops synthesising input altogether and asks
   * for this instead. The server drives tmux's own copy mode, which is exactly
   * what tmux does for a wheel when it HAS the mouse — the same intrusion on the
   * shared pane, reached without putting bytes on the pane's stdin.
   */
  | { t: "tmux"; cmd: "scroll"; lines: number }
  /** Open a review of pull request `number` in a window of the user's tmux.
   *  A NUMBER and a directory: the prompt and the binary are the server's. */
  | { t: "tmux"; cmd: "review"; number: number; root: string }
  /** Start work on an issue in a window of the user's tmux. `agent` opens the
   *  CLI in it, `yolo` buys exactly one flag, and `title` is data that
   *  `sessionTitle` sanitises before it reaches an argv array. */
  | { t: "tmux"; cmd: "issue"; cwd: string; name?: string; prompt?: string; agent?: boolean; yolo?: boolean; title?: string }
  /** The tab strip's four window commands, plus take-over. Kept in step with
   *  `TmuxAction` in server/src/tmuxctl.ts, which is what runs them. */
  /** `fit` sizes the tmux window to THIS client — see tmuxctl.ts, and the
   *  reason it exists: with a bigger client attached, `window-size largest`
   *  leaves the bottom of the pane below the panel. */
  /**
   * A new window running the agent, in the project the attached pane is in.
   *
   * The client sends no path and no command — not as a convenience, but because
   * this is the one frame on this socket that starts a program with the
   * permission prompts turned off, and a directory from the client would make
   * "where" a thing the UI could choose. The server reads
   * `#{pane_current_path}` off the pane this socket is attached to and rolls it
   * up to that checkout's git root, which is what "the project I am working in"
   * means on a machine whose windows live in worktrees. A `new-window` with no
   * `-c` lands in the session's default directory — the home directory on this
   * machine — and a phone that opens the agent in `~` has opened it in the
   * wrong repository, silently.
   *
   * `yolo` buys exactly one flag, the same division `cmd:"issue"` already
   * makes. It is a boolean rather than a string for that reason.
   */
  | { t: "tmux"; cmd: "agent"; yolo?: boolean }
  | { t: "tmux"; cmd: "select" | "new" | "kill" | "rename" | "move" | "takeover" | "fit"; window?: string; name?: string;
      /** `fit` only: the asking panel's own grid. Range-checked on the server —
       *  it ends up in a `resize-window`, so it is a number to validate rather
       *  than to trust. */
      cols?: number; rows?: number };

/**
 * Every key any member of a union carries, and what that key can hold.
 *
 * Generic on purpose and not written against `PtyClientFrame` directly: a
 * conditional type only distributes over a naked TYPE PARAMETER, so the
 * concrete-union spelling of this quietly collapsed to `keyof (A | B | …)` —
 * the keys COMMON to every frame, which is `t` and nothing else. Measured: the
 * server stopped compiling on fifteen lines that read a field the wire has
 * carried all along.
 */
type UnionKeys<T> = T extends unknown ? keyof T : never;
type UnionValue<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

/**
 * A client frame as it comes off the socket: every field a maybe.
 *
 * Deliberately NOT `PtyClientFrame` itself, and this is a rule about the server
 * rather than a convenience. `JSON.parse` returns whatever a client felt like
 * sending; asserting it into the union above would tell the compiler that
 * `msg.d` is a string and `msg.cwd` is a path, and every runtime guard on this
 * socket would stop being required by anything. This socket is reachable from
 * the UI, so those guards are the whole defence.
 *
 * Derived from the union rather than written out again, because a second list
 * of the same field names is precisely what this contract exists to delete: a
 * rename in `PtyClientFrame` takes the key out of here, and the server stops
 * compiling at the line that reads it.
 */
export type PtyClientMessage = { [K in UnionKeys<PtyClientFrame>]?: UnionValue<PtyClientFrame, K> };

/** A tool call held at the gate, awaiting a remote approve/deny. */
export interface PendingGate {
  id: string;
  source_app: string;
  session_id: string;
  tool_name: string;
  summary: string;
  created: number;
  /**
   * Who is asking, in words — "agentglass · scratch:1 «AI»".
   *
   * Composed on the server because only the server can: the checkout comes from
   * the pane note the hook recorded, and the window name from tmux. The client
   * was building `${source_app}:${session_id.slice(0, 8)}` instead, which is a
   * project name and eight characters of a UUID and identifies nothing on a
   * machine with thirty worktrees of that project.
   */
  where?: string;
  /** The tmux pane it is running in, so the notification has somewhere to go. */
  pane?: string;
}

/** A gate request that has been resolved. `resolution` is who resolved it:
 *  a human from the dashboard, the timeout, or a restart that found the window
 *  already closed. The last one is why this record exists — an outcome nobody
 *  chose is exactly the one that must not disappear. */
export interface GateRecord extends PendingGate {
  expires: number;
  decision: "allow" | "deny";
  reason: string | null;
  resolution: "human" | "timeout" | "restart" | null;
  decided_at: number | null;
  /** *Which* human — a paired device's name, or the address the answer came
   *  from. NULL when nobody decided: a timeout is not an actor, and neither is
   *  a restart. Also NULL on rows written before the column existed, which is
   *  why an absent value is never read as "this machine". */
  decided_by: string | null;
}

/**
 * One write the cockpit performed, kept.
 *
 * `actor` is the most the server can honestly assert. A paired device has its
 * own credential and the name somebody accepted when they paired it, so it is
 * named — "iPhone · 3f9c21", with the device id because an unnamed phone
 * defaults to "A device" and two of those must not read as one. Otherwise it is
 * a place rather than a person: `local` for the loopback caller — this
 * machine's dashboard — and the address for anything else.
 */
export interface ActionRecord {
  id: number;
  at: number;
  actor: string;
  /** The route, which is the verb: `/git/discard`, `/docker/rm`, `/gate/deny`. */
  action: string;
  /** What it was done to, already shortened for a list. Empty when there is
   *  nothing more specific than the route itself. */
  target: string;
  ok: boolean;
  /** The server's error text when it failed. */
  detail: string | null;
}

export interface SearchHit {
  id: number;
  timestamp: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  tool_name: string | null;
  cost_usd: number;
  duration_ms: number | null;
  /** snippet with \x01…\x02 wrapping the matched terms */
  snippet: string;
}

export interface Insight {
  id: string;
  severity: "info" | "warn" | "bad";
  kind: "loop" | "spend" | "errors" | "burn";
  title: string;
  detail: string;
  session: string | null; // "source_app:session8"
  ts: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each begins with " ", "+" or "-"
}
/** One thing that happened in a session, in order — a message or a tool run.
 *
 *  The conversation used to be prompts and assistant replies only, which left
 *  out everything the agent actually *did*: the file it edited, the command it
 *  ran, the search it made. That is most of the work, and without it the panel
 *  can't replace the terminal you'd otherwise read it in. */
export interface TimelineEntry {
  kind: "message" | "tool";
  ts: number;
  /** kind === "message" */
  role?: "user" | "assistant";
  text?: string;
  /** kind === "tool" */
  tool?: string;
  /** What it acted on: a file path, a command, a URL, a query. */
  target?: string | null;
  /** A Bash tool's own description of its intent, when it gave one. */
  note?: string | null;
  is_error?: boolean;
  duration_ms?: number | null;
  /** Links a tool run to its diff in `changes`, so an edit can show what it
   *  changed rather than only that it happened. */
  tool_use_id?: string | null;
  /** Which subagent produced this, when it wasn't the main thread.
   *
   *  Subagent turns report the *parent's* session id, so everything a fleet of
   *  them does lands on one timeline. Without this tag those runs are
   *  indistinguishable from the main thread's, and four agents working in
   *  parallel read as one very busy one. */
  agent_id?: string | null;
  agent_type?: string | null;
  /** What the tool answered, trimmed. Seeing only what an agent *ran* and never
   *  what came back is what still sends you to the terminal — a failing test and
   *  a passing one look identical without it. */
  output?: string | null;
  /** True when `output` is only the head of a longer result, so the UI can say
   *  so instead of implying the command was that quiet. */
  output_clipped?: boolean;
}

export interface SessionDetail {
  session_id: string;
  source_app: string;
  model_name: string | null;
  /** Where it ran — a resume has to start in the same directory. */
  project_path?: string | null;
  /** The linked worktree / subdir it actually ran in, if not the repo root. */
  cwd_path?: string | null;
  /** See SessionRollup — same fields, same precedence. */
  custom_title?: string | null;
  ai_title?: string | null;
  /**
   * The first thing you asked this session to do.
   *
   * Only present when there is no title, because that is the only time it is
   * needed — and it is what stops a list of thirty rows all reading
   * `agentglass:cd3fa401`. Derived from the `UserPromptSubmit` event that is
   * already in the database, so it names sessions recorded long before anyone
   * thought to write a title.
   */
  first_prompt?: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen: number;
  events: number;
  tools: number;
  errors: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  /**
   * Weighted tokens in uncached-input units — see WatchEvent.equiv_tokens.
   *
   * The cache classes are not on this shape and never were, which is the whole
   * reason this pane's "Tokens" stat was input+output: not a decision, just the
   * two columns the query happened to select. They are summed in the query now
   * and weighted into this one figure rather than added to the type, since four
   * numbers here would only recreate the problem one field along.
   */
  equiv_tokens?: number;
  summary: string | null;
  tool_mix: { tool: string; n: number }[];
  subagents: { agent_id: string; agent_type: string; events: number }[];
  conversation: { role: "user" | "assistant"; text: string; ts: number }[];
  /** Messages and tool runs interleaved in time — what actually happened. */
  timeline: TimelineEntry[];
  changes: FileChange[];
}

export interface FileChange {
  id: number;
  timestamp: number;
  source_app: string;
  session_id: string;
  tool: string;
  file_path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** git ignores this path. The list hides these by default — an agent's edit
   *  to build output is recorded like any other, and on a busy session that
   *  buries the edits worth reviewing. Absent means "not asked" / "unknown",
   *  which is never hidden. */
  ignored?: boolean;
  /** This path is not in the open project — not the scoped repo, and not any of
   *  its linked worktrees. A session of this project still writes notes and
   *  scratch files elsewhere, and those are recorded like any other edit; they
   *  are just not what you opened a project-scoped diff to read. Hidden by
   *  default, on the same terms as `ignored`. Absent (and always so on an
   *  unscoped instance, where there is no project to be outside of) means never
   *  hidden. */
  outside?: boolean;
}

/** A tool call the server sees as still running: a PreToolUse with no matching
 *  Post yet, in a session that hasn't stopped. This is the authoritative "what's
 *  open right now" — independent of whether the Pre still lives in the client's
 *  bounded event buffer, which it may not on a busy fleet or after a reload. */
export interface OpenToolCall {
  session_id: string;
  source_app: string;
  tool_name: string;
  since: number; // ms — the PreToolUse timestamp
  /** The file this tool's own input said it would touch, when it named one.
   *  Null for Bash and for anything that writes nowhere in particular. */
  target?: string | null;
  /** When this session last showed evidence of being alive: the transcript
   *  growing, or the file above changing. Independent of the hook stream, which
   *  by definition has gone quiet while a call is open. Absent when there was
   *  nothing to read. */
  evidenceAt?: number;
  /** Which evidence the timestamp came from. `none` means no source was
   *  readable — deliberately not the same claim as "nothing happened". */
  evidenceKind?: "transcript" | "target" | "dir" | "none";
  /** The directory this call is running in, for tools whose only possible
   *  evidence is that something moved in it. */
  dir?: string | null;
  /** What the evidence supports. Absent from a server too old to send it, which
   *  the client reads as `unknown` rather than as good news. */
  liveness?: Liveness;
}

/**
 * What the evidence says about a running tool call.
 *
 * `unknown` is a real answer and is rendered as one: a WebFetch and a `curl`
 * leave nothing local behind, and claiming a hang we cannot see is how a
 * five-minute timer lost its credibility in the first place.
 *
 * `lost` is not a hang either — it is our own bookkeeping failing. The CLI
 * wrote more transcript after this call opened, so the result arrived and the
 * Post event did not.
 */
export type Liveness = "working" | "stuck" | "lost" | "unknown";

/**
 * The workspace views, in the rail's canonical order. Source of truth for the
 * *type*; the UI (web/src/components/workspace/views.ts) attaches the icons,
 * labels and hotkeys and re-exports this so both sides name one set.
 */
export type ViewId = "dash" | "git" | "diff" | "pr" | "docker" | "term" | "chat" | "browser" | "files" | "tasks";

/**
 * A UI-navigation command from an external controller (a Stream Deck, a phone),
 * delivered to every client over the /stream socket (see the server's
 * POST /control). It drives only client-side view state — open a view, toggle
 * the workspace, cycle the theme — and executes nothing, which is why it can
 * ride the same read-only socket the dashboard already holds.
 */
export type ControlCmd =
  | { cmd: "view"; to: ViewId }
  | { cmd: "workspace"; open?: boolean }
  | { cmd: "esc" }
  | { cmd: "open"; what: "stats" | "skills" | "search" | "help" | "palette" }
  | { cmd: "theme"; dir?: 1 | -1; name?: string }
  | { cmd: "zoom"; dir: 1 | -1 | 0 }
  /** Drive the chat view itself. Unlike the rest, this one needs the chat panel
   *  mounted to run — see web/src/lib/chatIntent.ts. */
  | { cmd: "chat"; do: "new" };

/** An agent asking the built-in browser to do one thing. Answered by whichever
 *  window is showing it, over POST /browser/result — see browserdrive.ts. */
/** What the Agent browser pane reports. Mirrors browseruse.ts, which explains
 *  why a symlink and a copy need different words for being broken. */
export interface BrowserUseStatus {
  cli: { state: "installed" | "dangling" | "missing"; path: string; target: string | null };
  skill: { state: "current" | "stale" | "missing" | "unshipped"; path: string; shipped: string | null };
  windows: number;
  desktop: boolean;
}

export interface BrowserAskFrame {
  id: string;
  /** Kept in step with BrowserOp in server/src/browserdrive.ts by hand, and the
   *  compiler notices when it drifts: the server assigns one to the other. */
  op:
    | "open" | "read" | "click" | "type" | "wait" | "shot"
    | "back" | "forward" | "scroll" | "press" | "text";
  args: Record<string, unknown>;
}

/** WebSocket frames. */
export type WsFrame =
  | { type: "initial"; data: WatchEvent[]; openTools?: OpenToolCall[] }
  | { type: "browser"; data: BrowserAskFrame }
  /** The open-tool list again, with fresh evidence. Pushed on a timer while any
   *  call is open: evidence is a claim about *now*, and one taken at connect
   *  time is worth nothing thirty seconds later. */
  | { type: "openTools"; data: OpenToolCall[] }
  | { type: "event"; data: WatchEvent }
  | { type: "session"; data: SessionRollup }
  /** Something mutated a repository. Carries no payload on purpose: the panels
   *  each need a different slice of git state, so they re-read what they show
   *  rather than the server guessing which of them cares about what. */
  | { type: "git" }
  | { type: "tasks" }
  /** A pull request's checks all finished. One frame per PR per verdict — the
   *  server holds the latch, so a suite of sixty-one checks sends one of these,
   *  not sixty-one. */
  | { type: "ci"; data: CiVerdict }
  /** A ClickUp card of yours was assigned or moved — see CardNote. */
  | { type: "card"; data: CardNote }
  /** One of agentglass's own push alerts (a gate hold, a permission wait, a tool
   *  error) — the same thing the server would hand to notify-send. Broadcast so a
   *  connected client can raise a NATIVE OS notification, which Electron routes to
   *  the OS on macOS and Windows too, not just Linux. */
  | { type: "alert"; data: AlertNote }
  /** A UI-navigation command from POST /control, rebroadcast to every client.
   *  It changes what is *shown*, never the fleet. */
  | { type: "control"; data: ControlCmd };

export interface AlertNote {
  title: string;
  body: string;
  /** freedesktop urgency: 0 low, 1 normal, 2 critical. */
  urgency: 0 | 1 | 2;
  /**
   * The tmux pane the agent this is about is sitting in, when one is known.
   *
   * What makes the notification somewhere to go rather than something to read.
   * Recorded by the hook that fired the event, so it travels WITH the news
   * instead of being guessed from it afterwards.
   */
  pane?: string;
}

/**
 * A ClickUp card of yours that moved, derived rather than received.
 *
 * ClickUp has no notifications API, so this is what a poll can honestly say —
 * see server/src/clickupwatch.ts. There is no "who": the query answers with
 * cards, not with an activity feed, and naming a person would be a guess.
 */
export interface CardNote {
  /**
   * Newly assigned to you, already yours and moved, commented on, or a comment
   * that named you.
   *
   * A mention is an id match on a `tag` block, not a search for your name — a
   * workspace with two Davids in it makes that difference the whole feature.
   */
  kind: "assigned" | "status" | "comment" | "mention";
  /** ClickUp's own id, which is what opens the card. */
  id: string;
  /** What a person calls it — `ORBIT-1042` — falling back to the internal id. */
  label: string;
  title: string;
  status: string;
  /** The status it left, on a `status` note. */
  was?: string;
  /** Who wrote it, on a `comment` or `mention`. Comments carry an author;
   *  assignments and status changes do not, so those never claim one. */
  who?: string;
  /** What they said, trimmed to a line. */
  said?: string;
  url?: string;
}

/** The aggregate outcome of a PR's checks, once every one of them is terminal. */
export interface CiVerdict {
  repo: string;
  number: number;
  title: string;
  verdict: "green" | "red";
  /** Named, so the message can say what broke instead of just that something did. */
  failing: string[];
  url: string;
  /**
   * Somebody with write access has approved it.
   *
   * Carried so the client can be told about checks only on the pull requests
   * that are about to merge — which is when a check result is a thing to act
   * on rather than a thing to glance at. Decided here because the poll has the
   * review decision in hand and the notification path does not.
   */
  approved: boolean;
}

// --- commit composer (live git working-tree) ---------------------------------
export interface GitFileStatus {
  path: string; // repo-relative
  code: string; // raw porcelain XY
  staged: boolean;
  unstaged: boolean;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged" | "type-changed";
}
export interface RepoStatus {
  root: string; // absolute repo top-level
  branch: string;
  files: GitFileStatus[];
  suggested: string[]; // repo-relative paths from the request that are currently dirty
}
export interface GitStatusResponse {
  repos: RepoStatus[];
  commitEnabled: boolean;
}
export interface CommitResult {
  ok: boolean;
  sha?: string;
  shortSha?: string;
  summary?: string; // e.g. "3 files, +40 −5"
  error?: string;
}

// --- live git panel (working tree, replacing lazygit) ------------------------
/** A working-tree diff, shaped as a FileChange so the diff renderer is reused. */
export interface GitFileChange extends FileChange {
  status: GitFileStatus["status"];
  staged: boolean;
  binary: boolean;
  oldPath?: string; // absolute, set for renames
}
/** What git is in the middle of. Half the commit operations are unavailable
 *  during any of these, and the useful action becomes continue/abort/skip. */
export type GitTreeState = "clean" | "rebasing" | "merging" | "cherry-picking" | "reverting" | "bisecting";

export interface GitBranchInfo {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  /** Absent on older payloads; treat as "clean". */
  state?: GitTreeState;
  /** The branch this one was cut from — what a PR calls its base. Null on the
   *  trunk itself. Merging it in is "update from base". */
  base?: string | null;
  /** Commits the base has that this branch does not. */
  behindBase?: number;
  /** `@{upstream}` and the base are the same branch under two names —
   *  a local-only branch tracking the trunk (upstream `origin/main`, base
   *  `main`). Then "behind upstream" and "behind base" count the same commits,
   *  and merging the base is the way to close both. Only computed while it
   *  could matter (behind > 0, base known); absent otherwise. */
  upstreamIsBase?: boolean;
  /** The tip is an unpushed merge on a clean tree — so it can be undone
   *  exactly, by resetting to its first parent. */
  canUndoMerge?: boolean;
}
export interface WorkingTree {
  root: string;
  branch: GitBranchInfo;
  staged: GitFileChange[];
  unstaged: GitFileChange[]; // modified + untracked (untracked rendered as all-added)
  clean: boolean;
  writeEnabled: boolean;
  error?: string;
}
/** A repo agentglass knows about (from telemetry paths + the server's own cwd). */
export interface GitRepoRef {
  root: string;
  name: string;
  branch: string;
  dirty: number; // count of changed files
  ahead: number;
  behind: number;
  /** Absolute path of the main repo, when this checkout is a *linked worktree*
   *  rather than a project of its own. Set on the per-project lists (where the
   *  worktrees belong and are selectable); the machine-wide picker folds them
   *  into their project instead of listing them. */
  worktreeOf?: string;
  /** How many linked worktrees were folded into this project — what the picker
   *  shows so a dozen hidden checkouts aren't invisible. */
  worktrees?: number;
  /**
   * When this checkout was last worked in, as an epoch ms — what the pickers
   * sort on, most recent first.
   *
   * Read from the mtime of the checkout's own `HEAD` and reflog, which git
   * writes on every commit, checkout, merge, rebase, reset and pull. That makes
   * it "when did I last do something here", which is the question a list of
   * seventeen ticket worktrees is really being asked — and it costs two stats
   * rather than a `git log` per checkout. See touchedAt() for why it is not the
   * index.
   *
   * 0 when it could not be read; those sort last rather than first.
   */
  touchedAt: number;
}
/** One candidate directory from the project picker's path completion. Names and
 *  a `.git` flag only — the completion endpoint never reports files. */
export interface FsEntry {
  name: string;
  path: string;
  repo: boolean;
}
export interface FsCompletion {
  /** Absolute, normalised directory the entries live in. */
  base: string;
  entries: FsEntry[];
  /** More matches existed than were returned — the UI says "keep typing". */
  truncated: boolean;
}
export interface GitActionResult {
  ok: boolean;
  error?: string;
  output?: string;
}
export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  track: string; // raw "[ahead 4, behind 53]" / "[gone]" / ""
  date: string;  // committerdate, relative
  subject: string;
  /** Contained in the repo's trunk (origin/HEAD, or main/master). Absent when
   *  there's no trunk to compare against — which is not the same as false.
   *
   *  This, not `git branch -d`, is the real "was it merged?": `-d` compares
   *  against whatever is checked out, so from a worktree on a ticket branch
   *  every merged PR looks unmerged. */
  mergedIntoTrunk?: boolean;
}
export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string; // relative, e.g. "3 hours ago"
  refs: string; // decorations
}
/** One rendered row of `git log --graph`: the graph glyphs, plus commit fields
 *  when the row is a commit (graph-only connector rows have no hash). */
export interface GitGraphLine {
  graph: string;
  hash?: string;
  author?: string;
  date?: string;
  subject?: string;
  refs?: string;
}
export interface GitStash {
  index: number;
  ref: string; // stash@{N}
  message: string;
}
/** One git command the server ran — the command log panel's row. */
export interface GitLogEntry {
  id: number;
  at: number;
  cwd: string;
  args: string[];
  exitCode: number;
  ms: number;
  /** Can it change the repository? The panel shows only these by default. */
  write: boolean;
  error?: string;
}
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** Branches on this remote, as short names ("main"), without the remote prefix. */
  branches: number;
}
/**
 * One branch on a remote, as the local repository last saw it.
 *
 * These come from `refs/remotes/<remote>/*` — what the last fetch left behind,
 * not a live call to the server. That distinction matters in the UI: a branch
 * pushed by a colleague ten seconds ago is not here until you fetch.
 *
 * `local` and `worktree` are the whole point of the list. On a repo with 800
 * remote branches the useful question is never "what exists" — it's "do I
 * already have this one, and where".
 */
export interface GitRemoteBranch {
  /** Short name, without the remote prefix — "WEB-1042-quota-banner". */
  name: string;
  /** Full short ref — "origin/WEB-1042-quota-banner", i.e. what you pass to git. */
  ref: string;
  hash: string;
  subject: string;
  author: string;
  date: string; // relative
  /** A local branch of the same name already exists. */
  local: boolean;
  /** …and it tracks this remote branch, rather than merely sharing its name. */
  tracking: boolean;
  /** A checkout that already has that local branch out, if any. */
  worktree?: string;
}
export interface GitTag {
  name: string;
  /** Annotated tags carry their own message; lightweight ones borrow the commit's. */
  subject: string;
  date: string;
  hash: string;
  annotated: boolean;
}
/** A reflog entry. Unlike a commit these are *local history* — where HEAD has
 *  been — which is what makes them the undo trail after a bad reset or rebase. */
export interface GitReflogEntry {
  ref: string;      // HEAD@{3}
  shortHash: string;
  action: string;   // "commit", "rebase (finish)", "reset"
  subject: string;
  date: string;
}
/** Repo analytics over a time window (see /git/stats). */
export interface RepoInsightContributor { name: string; email: string; commits: number; added: number; deleted: number }
export interface RepoInsightHotspot { path: string; commits: number; added: number; deleted: number }
export interface RepoInsightDay { date: string; commits: number; added: number; deleted: number }
export interface RepoStats {
  days: number;
  commitsPerDay: number;
  contributors: RepoInsightContributor[];
  filesTouched: number;
  linesChanged: number;
  topContributors: RepoInsightContributor[];
  hotspots: RepoInsightHotspot[];
  churn: RepoInsightDay[];
  error?: string;
}
export interface ChangelogEntry { kind: string; scope: string; breaking: boolean; subject: string; hash: string }
export interface ChangelogSection { title: string; entries: ChangelogEntry[] }
export interface Changelog { from: string; to: string; sections: ChangelogSection[]; error?: string }
/** A submodule as the panel shows it — the index pin, the URL, the checkout state. */
export interface GitSubmodule {
  name: string;
  path: string;
  url: string;
  sha: string;
  branch?: string;
  status: "clean" | "modified" | "uninitialized" | "conflict";
}
/** One line of blame — which commit wrote it, and the content. */
export interface BlameLine {
  line: number;
  sha: string;
  author: string;
  time: number;
  subject: string;
  content: string;
}
export interface FileHistoryEntry {
  hash: string;
  fullHash: string;
  author: string;
  time: number;
  subject: string;
}
/** The state of a `git bisect` session — parsed from `git bisect status`. */
export interface GitBisectStatus {
  ok: boolean;
  bisecting: boolean;
  error?: string;
  remaining?: number;
  steps?: number;
  current?: { sha: string; subject: string };
  firstBad?: { sha: string; subject: string };
}
/** One `git grep` hit — path:line + the matching line. */
export interface GitGrepHit {
  path: string;
  line: number;
  text: string;
}
export interface GitWorktree {
  path: string;    // absolute
  branch: string;  // branch short name, or "(detached)"
  head: string;    // short sha
  current: boolean;
  bare: boolean;
  locked: boolean;
  /** Git reports the registration as broken — its gitdir points nowhere valid.
   *  A fabricated entry (an attacker-written .git/worktrees/<x>/gitdir aimed at
   *  an arbitrary path) surfaces as prunable, so any privileged action must not
   *  trust a prunable path as a real worktree of this repo. */
  prunable?: boolean;
  /** The branch this one was cut from — trunk unless overridden per branch.
   *  Null on the trunk checkout itself, which has no base. */
  base?: string | null;
  /** Commits the base has that this checkout does not. */
  behindBase?: number;
  /**
   * Uncommitted entries in that checkout (`git status --porcelain` lines).
   *
   * Costs one `git status` per worktree, and is worth it: a merge into a dirty
   * checkout is refused by the server, so without this the panel offers a sync
   * button that can only fail. Undefined means "not asked" — a bare worktree,
   * or a caller that didn't want to pay for it.
   */
  dirty?: number;
}

/**
 * What removing a worktree would destroy, named before you agree to it.
 *
 * `git status` is not the answer to that question. It reports a checkout with a
 * `.env` and a page of local notes in it as perfectly clean, because both are
 * gitignored — and `git worktree remove` deletes the whole directory, ignored
 * files included, without `--force` and without a word. So a caller about to
 * offer "remove these worktrees" has to look at the disk itself.
 */
export interface WorktreeLeftovers {
  path: string;
  /** What would go, worst-first. Capped — see `more`. */
  entries: LeftoverEntry[];
  /** How many more there were beyond the ones listed. */
  more: number;
  /** Ignored entries dropped as rebuildable (`__pycache__/`, `node_modules/`).
   *  Reported so the count in the UI can say what it chose not to show. */
  skipped: number;
  /** Entries byte-identical to the same path in the main checkout. Counted and
   *  NOT listed: deleting a copy loses nothing, and listing them buried the
   *  four that mattered under twenty that didn't. */
  identical: number;
  /** Set when the directory could not be read — treat as "assume work is
   *  there", never as "nothing to lose". */
  error?: string;
  /** Files in this checkout owned by somebody else — almost always root,
   *  written by a container that mounted the repo and ran as root. Present
   *  means the removal CANNOT succeed and must not be attempted: git deletes
   *  the worktree's registration before its files, so a half-done removal
   *  leaves an orphan directory that no longer belongs to any repository. */
  blocked?: BlockedByOwner;
}

/** Why a worktree cannot be deleted, and the one command that fixes it. */
export interface BlockedByOwner {
  /** How many foreign-owned paths were found before the walk gave up. */
  count: number;
  /** True when the count is a floor rather than a total. */
  more: boolean;
  /** Top-level directories to hand to chown — the useful unit, since these
   *  come from a container writing a whole `tmp/` or `.mypy_cache/`. */
  paths: string[];
  /** Owner names seen, e.g. ["root"]. */
  owners: string[];
}

/**
 * One thing that disappears with the worktree, and what the main checkout has
 * to say about it.
 *
 * `vsMain` is the whole reason this can be offered as a rescue rather than just
 * a warning. A worktree is a second copy of a repo, so most of what looks
 * alarming in it — every `compose/envs/*.env`, every generated `reverse.js` —
 * is byte-identical to the file already sitting in the main checkout. Those are
 * dropped before they reach here (see `identical`). What remains is:
 *
 *   * `absent`  — the main checkout has nothing at this path. Copying it there
 *                 is pure gain and cannot destroy anything, so these are the
 *                 ones offered pre-selected.
 *   * `differs` — a file exists there and is NOT the same. Copying OVERWRITES
 *                 the main checkout's version, which is how a rescue turns into
 *                 the thing it was meant to prevent. Never pre-selected, and
 *                 the UI has to say "overwrites" out loud.
 *
 * A directory is reported `differs` whenever the main checkout has one at that
 * path, without recursing to prove it: walking a 12 MB `dist/` to answer a
 * question whose safe answer is already "don't pre-select it" is work spent to
 * reach the same place.
 */
export interface LeftoverEntry {
  /** Path relative to the worktree root. Trailing "/" when it's a directory. */
  path: string;
  /** Bytes, recursive for a directory. -1 when it could not be measured. */
  bytes: number;
  dir: boolean;
  vsMain: "absent" | "differs";
}

// --- live docker panel (lazydocker replacement) ------------------------------
export interface DockerContainer {
  id: string;        // short id
  name: string;
  image: string;
  state: string;     // running | exited | paused | created | restarting | dead
  status: string;    // "Up 4 hours" / "Exited (0) 2 hours ago"
  ports: string;
  project: string | null; // compose project
  service: string | null; // compose service
  /**
   * The directory the stack was brought up from, off compose's own
   * `working_dir` label. Null when the container carries no such label.
   *
   * On the wire because deciding which project a container belongs to is not
   * only the server's job any more — the companion has to group by project too,
   * and without this it was left comparing a compose project name to a raw
   * directory basename. Compose lowercases and strips punctuation, so
   * `~/code/My.App` runs as `myapp` and no basename ever matches it, while two
   * unrelated repositories both called `web` match each other. See
   * shared/projectKey.ts, which is the one rule both surfaces use.
   */
  workingDir: string | null;
  runningFor: string;
  size: string;
}
export interface DockerStat {
  id: string;
  cpu: number;       // percent
  mem: number;       // percent
  memUsage: string;
  netIO: string;
  blockIO: string;
  pids: number;
}
export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;   // "5 hours ago"
  containers: string;
  dangling: boolean;
}
export interface DockerVolume { name: string; driver: string; }
export interface DockerNetwork { id: string; name: string; driver: string; scope: string; }
/** Present only when the cockpit is open for one project, so the panel can say
 *  which slice of the host it is showing — and admit when the filter found
 *  nothing and fell back to the whole machine. */
export interface DockerScope {
  workspace: string;   // the open project's directory
  project: string;     // compose project name derived from it
  matched: number;     // containers that belong to it
  showingAll: boolean; // nothing matched, so every container is listed instead
}
export interface DockerOverview {
  available: boolean;
  writeEnabled: boolean;
  version: string | null;
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  scope?: DockerScope;
  error?: string;
}
export interface DockerActionResult { ok: boolean; error?: string; output?: string; }

/**
 * Whether docker is usable, told apart into the three states that need three
 * different answers on screen.
 *
 * The overview carries a single `available: false` + `error` for any failure,
 * which conflated the two that matter: a *missing binary* and a *downed daemon*
 * are different problems with different fixes ("install Docker" vs "start the
 * daemon"), and the panel used to send everyone to the daemon message — even on
 * a machine with no docker at all. This is the docker counterpart to
 * GitCapability, and `available` here means the same thing it does there: the
 * CLI is on PATH.
 *
 *   (a) not installed → available:false, reason names it (install guidance)
 *   (b) installed, daemon down → available:true, reason (no version)
 *   (c) OK → available:true, version (no reason)
 */
export interface DockerCapability {
  /** The `docker` CLI is on this machine. False → not installed at all. */
  available: boolean;
  /** The daemon's version, present only when it answered — i.e. state (c). */
  version?: string;
  /** Why docker isn't usable: the binary is missing (a), or the daemon isn't
   *  responding (b). Absent in the healthy case. */
  reason?: string;
}

// --- LLM walkthrough (AI-authored review itinerary) --------------------------
export interface WalkthroughInputFile {
  path: string;
  tool?: string;
  additions?: number;
  deletions?: number;
  patch?: string; // unified diff text (source of truth stays the telemetry/git diff)
}
export interface WalkthroughFile {
  path: string;
  description: string; // one-line, LLM-authored
  tag: string; // feature | fix | refactor | test | docs | config | style | chore
}
export interface WalkthroughResult {
  available: boolean;
  reviewFocus: string;
  files: WalkthroughFile[];
  error?: string;
  /**
   * Files whose contents were deliberately not sent — `.env`, keys, credential
   * files. Named rather than dropped: a summary that describes a different
   * changeset from the one on screen is worse than no summary, because it is
   * the one people trust.
   */
  withheld?: string[];
}

// --- chat attachments (images pasted into the composer) ----------------------
/** An image attached to a chat turn, carried inline as base64.
 *
 *  The browser has no path the server could read, so the bytes travel in the
 *  JSON body rather than as a file reference. `data` is unpadded-or-padded
 *  standard base64 with no `data:` URI prefix — the server strips the prefix on
 *  the way in so the field holds only what a Claude image block wants. */
export interface ChatImage {
  mediaType: ChatImageMediaType;
  data: string; // base64, no `data:image/png;base64,` prefix
}
/** The media types a chat attachment may declare. This mirrors the set the
 *  `claude` CLI itself accepts for image blocks, so anything outside it would be
 *  rejected downstream anyway. */
export type ChatImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** How a chat's turns are actually run.
 *
 *  `process` — one `claude -p` per turn. Nothing is left running between turns,
 *              so an idle chat costs nothing, and every turn pays the CLI's full
 *              session start (measured 2.9-3.8s on a machine with MCP servers).
 *  `tmux`    — one interactive `claude` per chat, alive in a pane on agentglass's
 *              own tmux server. The start-up cost is paid once (same turn
 *              measured at 1.2-1.4s), and because the pane is a real tmux
 *              session the user can attach and carry on in their own terminal.
 *              The trade is memory: a warm CLI is ~380MB and grows with use. */
export type ChatEngine = "process" | "tmux";

/** How hard the model is asked to think, lowest first.
 *
 *  The order is the whole point: this is a dial, not a set of unrelated
 *  choices, and everything that renders it — the meter in the chat header —
 *  reads the position from this array rather than carrying its own copy.
 *
 *  Taken from the CLI's own `/effort` picker. `ultracode` sits past `max` and
 *  is described there as "xhigh + workflows", so it is last rather than
 *  alphabetical. */
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

/** Whether the pane engine can be offered here, and why not when it cannot.
 *
 *  The reason is carried rather than derived in the UI because the two causes
 *  need different words — "tmux is not installed" is a thing the user can fix,
 *  "not on Windows" is not. */
export interface TmuxEngineInfo {
  available: boolean;
  reason: string;
  /** The server's own default, so the toggle can show what happens if the user
   *  never touches it. */
  defaultOn: boolean;
}

// --- in-browser terminal (real PTY shell per repo/worktree) ------------------
/** A ready-to-run project command surfaced in the terminal panel. */
export interface ProjectCommand {
  name: string; // target/script name
  cmd: string;  // exact command to run, e.g. "make test" / "bun run dev"
  desc: string; // what it does — from `## comment`, `# comment` above, or the script body
  dir: string;  // repo-relative folder the Makefile/package.json lives in ("" = repo root)
}
/** Why the terminal is off, when it is. "env" = the AGENTGLASS_TERMINAL_DISABLED
 *  kill switch; "windows" = no POSIX PTY backend on this host. Lets the panel
 *  print the server's actual answer instead of guessing from the browser. */
export type TerminalDisabledReason = "env" | "config" | "windows";
export interface TerminalCommands {
  enabled: boolean; // false when the shell backend is unavailable
  reason?: TerminalDisabledReason; // set only when enabled is false — why it's off
  make: ProjectCommand[];    // Makefile targets, with descriptions
  scripts: ProjectCommand[]; // package.json scripts, runner-aware
}

/** A model one of the chat CLIs currently offers.
 *
 *  Always read from the CLI itself rather than from a table in this repo —
 *  Codex from its own `models_cache.json`, Antigravity from `agy models`. A
 *  list checked in here is wrong the day the vendor ships anything, and the
 *  failure is silent: the dropdown keeps offering an id the CLI no longer
 *  serves. */
export interface AgentModel {
  id: string;    // the slug passed to the CLI's model flag
  label: string; // the CLI's own display name, or the slug when it has none
}

/** What the chat panel needs to decide whether to offer a CLI at all, and what
 *  to put in its model dropdown if it does. Both travel together because the
 *  panel cannot usefully draw one without the other. */
export interface AgentCliStatus {
  enabled: boolean;  // the binary is on PATH and not disabled by env
  bypass?: boolean;  // the operator opted into the unattended mode
  models: AgentModel[];
}

/** Named for the agents that use them. The shapes are identical — what differs
 *  is where the list comes from, which is each server module's business — so
 *  these stay aliases rather than three copies drifting apart. */
export type CodexModel = AgentModel;
export type CodexStatus = AgentCliStatus;
export type AntigravityModel = AgentModel;
export type AntigravityStatus = AgentCliStatus;

/** Whether `git` is on this machine at all. `available: false` is a first-class
 *  UI state — the git/diff/PR panels and the terminal all need git — not an
 *  error to bury behind an empty "no repos found". */
export interface GitCapability {
  available: boolean;
  version?: string;
  reason?: string;
}

/** One `<<<<<<< / ======= / >>>>>>>` region of a conflicted file. */
export type ConflictBlock = {
  index: number;
  /** 1-based line the `<<<<<<<` sits on. */
  line: number;
  ours: string[];
  theirs: string[];
  /** Only with merge.conflictStyle=diff3/zdiff3. */
  base?: string[];
  ourLabel: string;
  theirLabel: string;
  /**
   * Raw 1-based line numbers of the first line of each side, and of the
   * closing `>>>>>>>`.
   *
   * Raw, meaning the numbers the file has on disk with the markers still in
   * it — the same ones nvim shows when the panel jumps you there. Computed on
   * the server so the client never re-derives them and drifts.
   */
  ourLine?: number;
  theirLine?: number;
  endLine?: number;
};

/**
 * A conflicted file as alternating runs: text git left alone, and the regions
 * it could not decide.
 *
 * The parser always produced this; the old endpoint threw the text away and
 * sent only the conflicts, which is why the screen showed fragments with no
 * idea what surrounded them.
 */
export type ConflictSegment =
  | { kind: "text"; from: number; lines: string[] }
  | { kind: "conflict"; index: number };

export type ConflictFile = {
  ok: boolean;
  segments: ConflictSegment[];
  blocks: ConflictBlock[];
  /** Lines in the file, so the caller can decide to render it in a window. */
  lines: number;
  /**
   * Fingerprint of the file exactly as parsed.
   *
   * A choice made against one parse must never be written against another: if
   * anything touched the file in between — an agent in tmux, nvim, a rerun of
   * the merge — the block indices point somewhere else and applying them
   * resolves the wrong conflict with the wrong side, successfully.
   */
  stamp: string;
  error?: string;
};

/**
 * What to write for one block. `both` keeps ours then theirs.
 *
 * The four sides cover the conflicts where one branch is simply right. They do
 * not cover the ordinary case where neither is: two people changed the same
 * function for different reasons and the answer is a third thing. Without
 * `{ edit }` those conflicts had to leave the app for an editor, which is most
 * of the reason the resolver went unused.
 */
export type BlockChoice = "ours" | "theirs" | "both" | "theirs-first" | { edit: string[] };

/** What one stopped operation conflicted, including what is already resolved.
 *  Git keeps none of this once a file is staged, so the server does. */
export type MergeSessionView = {
  ok: boolean;
  /** Identifies this stop; empty when nothing is stopped. */
  op: string;
  /** Every file this stop conflicted, relative to the root, as first seen. */
  files: string[];
  /** Of those, the ones git still has unmerged right now. */
  left: string[];
  /** Of those, the ones resolved through this app rather than elsewhere. */
  mine: string[];
  error?: string;
};

/** One end of a stopped operation: what to call it, and what it actually is. */
export type MergeSide = {
  /**
   * A branch name when the commit is the tip of one — `main`, `origin/master`.
   * Null when it is not, which is the ordinary case for the commit a rebase or
   * a cherry-pick is replaying: it is a commit, not a branch, and calling it
   * one would be a guess.
   */
  ref: string | null;
  sha: string;
  /** The commit's first line, so a side with no ref can still be named. */
  subject: string;
};

/**
 * Which two things git has stopped between, read from `.git` rather than
 * derived.
 *
 * The panel used to build this sentence from the checkout's *base branch*,
 * which is a deduction. Merge a branch that is not your base, or cherry-pick,
 * and it names the wrong ref with complete confidence — the exact failure that
 * makes somebody resolve a conflict backwards.
 */
export type MergeInfo = {
  ok: boolean;
  state: GitTreeState;
  /** What `<<<<<<<` means in this operation. Null when nothing is stopped. */
  ours: MergeSide | null;
  /** What `>>>>>>>` means. */
  theirs: MergeSide | null;
  /**
   * Which commit of how many, for the operations that replay a series. A
   * rebase does not end when the last file is resolved: it stops again on the
   * next commit, possibly many times.
   */
  step?: number;
  total?: number;
  error?: string;
};

/**
 * A multi-commit cherry-pick. `hashes` are full or short commit ids — git's
 * sequencer replays them in one run, so the set stops together on the first
 * conflict instead of each commit being an independent attempt.
 */
export type CherryPickRequest = {
  root: string;
  hashes: string[];
  /** `-n`: apply to the index and working tree without committing. */
  noCommit?: boolean;
};

/** The notes for one release: the tag annotation the GitHub release was made
 *  from, read from the update clone when there is one and from the releases API
 *  otherwise. `source` says which, because "offline" is a useful thing to know
 *  when the answer is empty. */
export interface ReleaseNotes {
  ok: boolean;
  tag: string;
  notes: string;
  source: "clone" | "github" | "";
  error?: string;
}

/** What the installed app was built from, and what is waiting upstream. */
export type UpdateStatus = {
  ok: boolean;
  available: boolean;
  info: {
    version: string;
    /** HEAD at build time. Says where the build started, not what it contains. */
    commit: string;
    builtAt: string;
    source: string;
    /** Remote the updater clones from. */
    origin: string;
    /** Nearest release this build descends from, and how far past it — this,
     *  not `version`, is what decides whether a published tag is newer. */
    baseTag: string;
    distance: number;
    /** What the build IS: `9699619` for a tree that was exactly that commit,
     *  `9699619+dirty.a3f1c2e` for one that was not. This is the field to
     *  render; `commit` alone once named a commit that lacked the security fix
     *  the binary actually contained. */
    stamp: string;
    /** sha256 over the packaged source tree. "" on builds predating the stamp. */
    tree: string;
    dirty: boolean;
    /** How many packaged files differ from `commit`. */
    dirtyCount: number;
    /** Which ones, as `M path`. Desktop only — empty for a browser or a phone,
     *  because it names work in flight in the developer's checkout. */
    dirtyFiles: string[];
  };
  branch: string;
  behind: number;
  ahead: number;
  incoming: { sha: string; subject: string }[];
  blocked?: string;
  last?: { at: string; ok: boolean; tail: string };
};

// --- pull requests (gh-backed) ---------------------------------------------

/**
 * A repo's identity on the forge, not on disk.
 *
 * Eighteen worktrees of the same clone are one repo here. Keying PRs by path
 * would fetch the same list eighteen times — at ~1.9s a call on a server with
 * one thread, which is the stall this whole panel is written to avoid.
 */
export interface PrRepoId {
  /** "github.com/acme/orbit" — the cache key, and what `gh -R` is given. */
  key: string;
  host: string;
  owner: string;
  name: string;
  /** "acme/orbit" */
  nameWithOwner: string;
}

export type PrCheckState = "success" | "failure" | "pending" | "skipped" | "neutral";

export interface PrCheck {
  name: string;
  workflow: string;
  state: PrCheckState;
  /** Terminal means it will not change without a new push or a re-run. */
  done: boolean;
  url?: string;
}

export interface PrCheckRollup {
  total: number;
  success: number;
  failure: number;
  skipped: number;
  pending: number;
  /** Every check has reached a terminal state. The notification latch waits
   *  for this, so 61 checks produce one message rather than 61. */
  allDone: boolean;
  /** Only meaningful with `allDone`. Skipped never counts as failure. */
  verdict: "green" | "red" | null;
  /** The failing ones, named — a count alone sends you to the browser. */
  failing: PrCheck[];
}

export interface PrLabel { name: string; color?: string }

/** Somebody asked for a review. A team has no avatar and no login, so it is
 *  named rather than pictured — the row must not draw a broken image for it. */
export interface PrReviewer {
  /** A user's login, or a team's name when `isTeam`. */
  login: string;
  isTeam?: boolean;
}

/**
 * What a BY-BRANCH lookup can promise, which is much less than a list row.
 *
 * `prsForBranch` asks `gh` for the cheap field set on purpose — the check
 * rollup is a separate GraphQL walk per pull request, measured at four times
 * the cost of everything else together — so seven of `PrSummary`'s fields are
 * simply not there. It used to be cast to `PrSummary` anyway, and a consumer
 * that believed the cast and read `checks.failure` off it took the whole Source
 * control view to a black screen. The guard for that lives in one component;
 * this is the guard for every component after it, at compile time.
 */
export type PrBranchSummary = Pick<PrSummary,
  "number" | "title" | "author" | "state" | "isDraft" |
  "headRefName" | "baseRefName" | "url" | "updatedAt" | "reviewDecision">;

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: PrLabel[];
  /** Assignee logins, for the Assignee facet. Empty when nobody is assigned. */
  assignees: string[];
  /** Milestone title, or null when the PR is on no milestone. */
  milestone: string | null;
  /** Who has been asked to review, for the list's Reviewers column. Arrives on
   *  the same second pass as `checks` — until then it is empty, which reads as
   *  "not yet" rather than "nobody was asked". */
  reviewers?: PrReviewer[];
  checks: PrCheckRollup;
  /**
   * Whether GitHub can merge this without a human resolving something.
   *
   * On the SUMMARY as well as the detail, because the triage board files a row
   * by what it needs and a conflict is a different need from a red check. It
   * was detail-only, so the board read the checks alone and filed a conflicting
   * pull request as "open, green, nobody has been asked to look yet".
   *
   * `UNKNOWN` is a real answer and not a missing one: GitHub computes this
   * lazily and says UNKNOWN while it is still working, so a caller must not
   * treat it as "no conflict".
   */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /**
   * The commit `checks` describes — and therefore the only commit a merge
   * started from this row is allowed to land.
   *
   * Arrives with the second pass, off the same GraphQL node as the rollup, so
   * the two can never disagree. Undefined until then, which is honest: before
   * the checks are in, this row has no opinion about a commit and nothing
   * should merge from it.
   */
  headSha?: string;
  /** This checkout is on the PR's head branch — "you are here". */
  isCurrentBranch?: boolean;
  /** Whether `checks` has actually been fetched. The list arrives in two
   *  passes because the check rollup costs four times the rest of the row, and
   *  a row that has not had its second pass must say "loading" rather than
   *  "no checks" — those are different claims. */
  checksLoaded?: boolean;
}

/** Why the merge button is grey. A disabled control that can't say why is the
 *  thing this panel exists to replace. */
export type PrMergeState =
  | "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" | "UNSTABLE" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN";

/** One emoji tally on a comment, straight from GraphQL's `reactionGroups`.
 *  `viewerHasReacted` is what lets the button render as already-pressed. */
export interface PrReaction {
  /** GitHub's own name: THUMBS_UP, HEART, ROCKET, EYES, LAUGH, HOORAY, CONFUSED, THUMBS_DOWN. */
  content: string;
  count: number;
  viewerHasReacted: boolean;
}

/** How GitHub labels the person who wrote a comment: OWNER, MEMBER,
 *  COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE. Shown as the little
 *  badge beside the name — it is how a reader weighs a review at a glance. */
export type PrAuthorAssociation =
  | "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR"
  | "FIRST_TIME_CONTRIBUTOR" | "FIRST_TIMER" | "MANNEQUIN" | "NONE";

/** What everything a person wrote carries: who, when, whether they edited it,
 *  what standing they have, and how people reacted. */
export interface PrAuthored {
  reactions?: PrReaction[];
  /** Non-null when the comment was edited after posting — GitHub shows "edited". */
  editedAt?: string | null;
  association?: PrAuthorAssociation;
  /** You wrote it, so you may edit or delete it. */
  viewerDidAuthor?: boolean;
}

export interface PrThreadComment extends PrAuthored {
  id: string;
  /** The numeric id the REST reply endpoint wants; the `id` above is a GraphQL
   *  node id and the two are not interchangeable. */
  databaseId?: number | null;
  author: string;
  isBot: boolean;
  body: string;
  createdAt: string;
  /** Straight to this comment on GitHub, for when you need the full thing. */
  url?: string;
}

export interface PrThread {
  /** GraphQL node id — the only handle `resolveReviewThread` accepts. */
  id: string;
  path: string;
  line: number | null;
  /** The first line, when the thread covers a range. Null for one line. */
  startLine?: number | null;
  isResolved: boolean;
  /** The code under it has changed since; usually safe to skip. */
  isOutdated: boolean;
  /** The diff hunk GitHub kept with the comment. Present even when the thread
   *  is outdated and those lines are gone from the current diff. */
  diffHunk?: string;
  /** The line in the file as it was when the comment was written. */
  originalLine?: number | null;
  url?: string;
  comments: PrThreadComment[];
}

export interface PrReview extends PrAuthored {
  author: string;
  isBot: boolean;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  submittedAt: string;
  url?: string;
  /** GraphQL node id, for reacting to the review body. */
  nodeId?: string;
}

export interface PrComment extends PrAuthored {
  id: number;
  author: string;
  isBot: boolean;
  body: string;
  createdAt: string;
  url?: string;
  /** Bot noise reduced to its point — a 46KB coverage table is three numbers
   *  and 1,847 rows nobody reads. Null when nothing could be extracted. */
  digest?: string | null;
  /** GraphQL node id — what the reaction and edit mutations take. */
  nodeId?: string;
}

export interface PrCommit {
  oid: string;
  short: string;
  /** The subject line. */
  message: string;
  /** Everything after the subject — the paragraphs, the Co-authored-by
   *  trailers, the "why". Empty for a one-line commit. */
  body?: string;
  author: string;
  isMerge: boolean;
  /** Everyone credited, not just the first: a commit written with an agent
   *  carries a Co-authored-by trailer, and "X and claude committed" is the
   *  honest line. Includes the author; empty falls back to `author`. */
  authors?: string[];
  /** When it landed, so commits can be grouped by day like GitHub does. */
  committedAt?: string;
  /** A valid signature earns the Verified badge. */
  verified?: boolean;
  /** This commit's own check rollup: SUCCESS / FAILURE / PENDING / null. */
  checks?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  /** Unresolved threads anchored to this file. */
  comments: number;
  /** GitHub's own per-reviewer "viewed" tick, so marking a file read survives
   *  leaving the panel and matches what github.com shows. */
  viewed?: boolean;
  /** Where it came from, when the change is a rename. */
  previousPath?: string | null;
}

/** One entry in the conversation timeline that is not a comment: a push, a
 *  rename, a label, a merge. GitHub renders these inline between comments, and
 *  without them the conversation reads as if nothing happened between remarks. */
export interface PrEvent {
  kind:
    | "force-push" | "commit" | "renamed" | "labeled" | "unlabeled"
    | "assigned" | "unassigned" | "review-requested" | "review-request-removed"
    | "ready-for-review" | "convert-to-draft" | "merged" | "closed" | "reopened"
    | "cross-referenced" | "milestoned" | "demilestoned" | "head-ref-deleted"
    | "auto-merge-enabled" | "auto-merge-disabled";
  at: string;
  actor: string;
  /** One line of detail, already shaped for reading: the new title, the label
   *  name, the sha pair of a force-push, the PR that referenced this one. */
  detail?: string;
  /** Colour for the label chip on labeled/unlabeled. */
  tint?: string | null;
  url?: string;
}

/** One CI job behind a check — what actually has a log, and what a single
 *  re-run targets. */
export interface PrCheckJob {
  id: string;
  runId: string;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
}

export interface PrChecklistItem { checked: boolean; text: string }

/**
 * What "Update branch" can do to the copy of that branch on this machine.
 *
 * The button merges the base into the head ON GITHUB, so the moment it
 * succeeds the local copy of that branch is a commit behind the remote it
 * tracks — and nothing said so. These are the only outcomes worth having
 * a word for, and only one of them is a write:
 *
 *   absent    no local copy of this branch at all — nothing to sync
 *   ff        the local branch can be fast-forwarded onto the remote
 *   diverged  the local branch has commits GitHub does not have, so after
 *             GitHub's merge the two histories can no longer fast-forward
 *   dirty     it is checked out somewhere with uncommitted changes
 *   busy      that checkout is mid-merge, mid-rebase or conflicted
 *
 * Everything except `ff` is a sentence to show, never an operation to try.
 */
export type PrLocalSync = "absent" | "ff" | "diverged" | "dirty" | "busy";

/** The local copy of a pull request's head branch, read with git alone — no
 *  network, so it costs nothing to ask alongside the behind count. */
export interface PrLocalHead {
  branch: string;
  exists: boolean;
  /** Absolute path of the worktree it is checked out in, if any. A branch
   *  nobody has checked out is the easy case: its ref can be moved forward
   *  without touching a working tree at all. */
  worktree?: string;
  /** Commits the local branch has that its remote does not. */
  ahead: number;
  /** Commits the remote has that the local branch does not — before GitHub
   *  adds the merge this button is about to make. */
  behind: number;
  /** Uncommitted changes in that worktree. False when it is not checked out:
   *  somebody else's dirty tree is not this branch's problem. */
  dirty: boolean;
  sync: PrLocalSync;
}

/** The three ways GitHub will land a pull request. */
export type PrMergeMethod = "squash" | "merge" | "rebase";

/**
 * What the repository itself allows, rather than what we assume.
 *
 * Every one of these is a repository setting, and each of them used to be
 * guessed: the panel hard-coded "squash" as the method, offered auto-merge on
 * repositories that forbid it, and always asked gh to delete the head branch —
 * on a repository that deletes it on merge, that is a second call whose only
 * possible outcomes are "already gone" and a failure that reads as if the
 * merge itself failed.
 */
export interface PrMergePolicy {
  /**
   * The methods this repository permits, in GitHub's own precedence — the
   * first is the one its merge button arrives already checked on, which is
   * what "just press the blue button" means for whoever wrote the convention.
   */
  allowed: PrMergeMethod[];
  /** "Allow auto-merge", off by default on a new repository. */
  auto: boolean;
  /** The repository deletes the head branch itself once a PR merges. */
  deletesBranch: boolean;
}

export interface PrDetail extends PrSummary {
  body: string;
  mergeState: PrMergeState;
  /** Parsed out of the body — unchecked boxes are a merge signal on repos
   *  whose template carries a real checklist. */
  checklist: PrChecklistItem[];
  /** Same shape the row carries, and required here because the detail always
   *  fetches them. It used to be a bare `string[]`, which `extends PrSummary`
   *  made a compile error the moment the row learned about teams — and, before
   *  that, meant the sidebar asked the avatar proxy for a portrait of a team. */
  reviewers: PrReviewer[];
  assignees: string[];
  reviews: PrReview[];
  comments: PrComment[];
  threads: PrThread[];
  commits: PrCommit[];
  files: PrFile[];
  checks: PrCheckRollup;
  checksAll: PrCheck[];
  /** The author force-pushed after a review was submitted: that review is
   *  stale and the reviewer should be told rather than left guessing. */
  forcePushedSinceReview: boolean;
  /** You opened this one. GitHub will not let you review your own work, and
   *  neither should the panel. */
  viewerDidAuthor: boolean;
  /** Somebody asked you for a review. This is what the review tab is for. */
  viewerRequested: boolean;
  /** Everything that happened which is not a comment: pushes, renames, labels,
   *  the merge itself. Ascending, so it interleaves with comments by time. */
  timeline: PrEvent[];
  /** Everyone who has touched the conversation — the sidebar's avatar row. */
  participants: string[];
  /** Reactions on the pull request body itself. */
  bodyReactions: PrReaction[];
  /** Emoji on the body needs the PR's own node id. */
  nodeId?: string;
  projects: string[];
  /** Issues this pull request closes when it merges. */
  linkedIssues: { number: number; title: string; url: string; state: string }[];
  /** Armed auto-merge, so the UI can offer to cancel it rather than only arm it. */
  autoMerge?: { enabledBy: string; method: string } | null;
  mergedBy?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  createdAt?: string;
  /** You may edit the title/body. */
  viewerCanUpdate?: boolean;
  /** What this repository allows. Optional because a cached detail taken
   *  before this existed, and the demo fixture, have no opinion — the UI falls
   *  back to offering all three rather than to an empty menu. */
  mergePolicy?: PrMergePolicy;
  /** Who owns the head branch. GitHub's own merge commit names it
   *  ("Merge pull request #7 from owner/branch"), and a merge made from here
   *  should read like every other merge on the base branch. */
  headRepoOwner?: string;
  /** What the page could not show because a list hit its page size. Silence
   *  here used to be a lie: a hundred-and-first file simply vanished. */
  truncated?: { files?: number; commits?: number; comments?: number; threads?: number; checks?: number };
}

export interface PrListResponse {
  ok: boolean;
  /** Null when this directory has no forge remote we understand. */
  repo: PrRepoId | null;
  prs: PrSummary[];
  /** When the cached copy was taken. The UI shows this rather than pretending
   *  to be live — every number here costs a subprocess. */
  fetchedAt: number;
  stale: boolean;
  loading: boolean;
  /** The rows are here but their check states are still being fetched. */
  checksPending?: boolean;
  error?: string;
  /** `gh` missing or not logged in — a first-class state, not an error toast. */
  needsAuth?: boolean;
  /** How many pull requests match, across every page. */
  total?: number;
  /** Another page exists after this one. */
  hasNext?: boolean;
  /** Opaque cursor that fetches the page after this one. */
  cursor?: string | null;
  pageSize?: number;
}

export interface PrActionResult { ok: boolean; error?: string; detail?: string }

/** State of the Claude Code hook wiring (#187), read from ~/.claude/settings.json. */
export interface HookSetupStatus {
  /** Our forwarder is present in settings.json right now. */
  installed: boolean;
  /** The hook scripts are shipped with this build (a source checkout, or a
   *  packaged install that carries hooks/). False = install is unavailable. */
  bundled: boolean;
  /** Where the change is written, shown so the user knows what they are editing. */
  settingsPath: string;
  /** The interpreter the wired command uses (python3, or py on Windows). The
   *  hooks run under it; the install itself does not. */
  python: string;
}

export interface HookSetupResult {
  ok: boolean;
  /** The wiring state after this call. */
  installed: boolean;
  /** Whether settings.json actually changed (false = it was already so). */
  changed: boolean;
  /** The backup written before the change, when there was one. */
  backup?: string;
  settingsPath: string;
  error?: string;
}

// --- remote access ----------------------------------------------------------

/** An address another device could reach this machine on. */
export interface ReachableAddress {
  address: string;
  /** Interface name, so "which network is this" is answerable. */
  iface: string;
  /** A tailnet address (CGNAT 100.64/10) rather than a plain LAN one: works
   *  from anywhere, but only for devices already on the tailnet. */
  tailnet: boolean;
  /** CIDR of the local subnet, used to scope the firewall command. */
  subnet: string | null;
  /** The full base URL to open, when it is not the default `http://address:port`
   *  — a Tailscale HTTPS name, say. Present ⇒ the QR uses this verbatim. */
  url?: string;
  /** Served over HTTPS (a secure context): the only kind a phone can PAIR over. */
  secure?: boolean;
  /** A friendlier name than the raw address, e.g. "Tailscale (HTTPS)". */
  label?: string;
}

/** The firewall most likely to be dropping traffic, and the fix. Never run by
 *  the app: it prints the command for a human to read and paste. */
export interface FirewallHint {
  tool: "ufw" | "firewalld" | "nftables";
  command: string;
  undo: string | null;
}

/** A device that has reached this machine over the network. */
export interface RemoteDevice {
  address: string;
  firstAt: number;
  lastAt: number;
  /** Sockets open from it at this instant: the event stream, a terminal, the
   *  notification mirror. Above zero means it is connected now. */
  live: number;
  /** Its User-Agent, condensed to something a person recognises. */
  label: string;
  agent: string;
  hits: number;
  /** Refused at the door until it is let back in or the server restarts. */
  blocked: boolean;
  /** This machine reaching itself through one of its own addresses rather than
   *  loopback. Shown, named, and never offered a Disconnect. */
  self?: boolean;
}

/**
 * What a paired device is allowed to do. See server/src/devices.ts.
 *
 * Three levels rather than a permission matrix: looking at things, answering
 * the thing an agent is stopped on, and operating the machine.
 */
export type DeviceScope = "read" | "answer" | "full";

/** A phone (or anything else) that holds its own credential to this machine. */
export interface PairedDevice {
  id: string;
  /** Whatever it called itself when it paired. */
  label: string;
  scope: DeviceScope;
  createdAt: number;
  /** Last request it made, recorded at most once a minute. */
  lastSeenAt?: number;
  /** Set when forgotten. The row stays so "did I definitely cut it off" is
   *  answerable rather than inferred from an absence. */
  revokedAt?: number;
}

/**
 * A device that has typed the code and is waiting on somebody at the machine.
 *
 * Carries the code so the pane can show it beside the request: the person
 * accepting is meant to check that the six digits on the phone in their hand
 * are the six digits on the screen, which is the step that makes this more
 * than a button that says yes.
 */
export interface PairRequest {
  id: string;
  code: string;
  label: string;
  agent: string;
  ip: string;
  claimedAt: number;
  expiresAt: number;
}

/** The credential, sealed to the key the phone generated for this pairing. */
export interface PairWrapped {
  /** The server's ephemeral P-256 public key, base64url. */
  pub: string;
  iv: string;
  data: string;
}

/** Everything the Remote pane needs about pairing, in one poll. Local only. */
export interface PairState {
  /** The live invitation, if the pane has started one. */
  ticket: { id: string; code: string; expiresAt: number } | null;
  /** Claims waiting on a decision, oldest first. */
  pending: PairRequest[];
  devices: PairedDevice[];
}

/**
 * An agent CLI this app knows how to connect, and how.
 *
 * Everything not installed is listed too, rather than hidden: a list of what is
 * present says nothing about what is *supported*, and that is the question
 * somebody has before they decide to try a second agent at all.
 */
export interface KnownAgent {
  id: string;
  label: string;
  /** The executable looked for on PATH. */
  bin: string;
  /** How it reports: our own hook forwarder, its OpenTelemetry exporter, or —
   *  for a CLI that exports neither — the chat panel driving it, which turns
   *  the frames of its own turns into events. `chat` agents have nothing to
   *  connect and nothing to undo, and are only ever seen while a chat here is
   *  running them. */
  via: "hooks" | "otel" | "chat";
  /** The file connecting it writes. Shown, so nobody has to guess. */
  configPath: string;
  /** A fragment of the `source_app` its events arrive under. Not the whole
   *  thing: for an OTel agent that is the CLI's own `service.name`, which this
   *  app does not choose and cannot pin. */
  match: string;
  /** How to get it, for the ones that are not here. */
  install: string;
  /** What connecting it actually does, in a few words. */
  connects: string;
}

export interface AgentProbe extends KnownAgent {
  /** On PATH right now. */
  found: boolean;
  /** Where, when it was found. */
  path: string | null;
  /** Its config currently points at a local agentglass. */
  connected: boolean;
  /**
   * When an event from it last arrived, or null if one never has.
   *
   * The half that matters, and deliberately independent of `connected`: a
   * config that was written and an event that landed are different facts, and
   * every failure here looks like a successful write — a file in the right
   * shape the CLI does not read, a session started before the change, a typo in
   * an endpoint. A tick over a file that changed nothing stops the search.
   */
  seenAt: number | null;
}

/** How often a budget resets. Calendar periods, not trailing windows — the
 *  reset is what makes a number feel like a budget rather than an average. */
export type BudgetPeriod = "day" | "week" | "month";

/**
 * A spending limit somebody chose.
 *
 * The insights used to fire on constants, which makes them noise on a project
 * that genuinely costs that much and silent on one where a tenth would be
 * alarming. Three fields, deliberately: how much, over what period, for what.
 */
export interface Budget {
  /** Project root this applies to. Empty means the whole machine. */
  root: string;
  /** Exact model name this applies to. Empty means all of them. */
  model: string;
  /** In USD, matching every other cost in this app. */
  limit: number;
  period: BudgetPeriod;
}

/** A budget, and where it stands right now. */
export interface BudgetStatus {
  budget: Budget;
  /** The window evaluated, UTC and inclusive — so a panel can say which days
   *  the number covers rather than implying it covers all of them. */
  fromDay: string;
  toDay: string;
  spent: number;
  /** Fraction of the limit. Above 1 when over, which is left uncapped: "180%"
   *  is the useful number and "100%" would hide how far past it went. */
  pct: number;
  level: "ok" | "warn" | "over";
}

/**
 * A warm CLI held in a tmux pane, and what is known about it.
 *
 * Each is several hundred megabytes — that is the price of skipping the MCP
 * re-init a fresh turn pays — so "what is running" is a question with a number
 * attached to it, and until now the only place to ask it was a terminal.
 */
export interface ChatPane {
  /** The chat's session id, which is also the pane's name. */
  name: string;
  /** When this server last ran a turn in it. Null for a pane it has never
   *  served — a leftover from a previous run, or something started by hand. */
  lastUsedAt: number | null;
  /** Exempt from idle eviction until unpinned or closed. */
  pinned: boolean;
  /** Mid-turn at this instant. Never an orphan, and never safe to end. */
  running: boolean;
  /** No chat this client has open, and no turn in flight, points at it. */
  orphan: boolean;
}

export interface ChatPaneList {
  panes: ChatPane[];
  /** How long a pane may sit unused before it is reclaimed. 0 means eviction
   *  is switched off, which is a thing the UI has to say rather than imply. */
  idleEvictMs: number;
}

/** Whether another device can reach this server, and whether one ever has. */
export interface RemoteStatus {
  /** Bound off loopback, so off-box traffic can arrive at all. */
  exposed: boolean;
  bind: string;
  port: number;
  /** Private-network origins accepted. An exposed port without it 403s. */
  trustLan: boolean;
  tokenRequired: boolean;
  /** This port serves the dashboard itself, not only the API. */
  webUi: boolean;
  /** Ready-to-open addresses. Never a credential: a device is added by
   *  pairing (see PairState), not by being handed a link. */
  urls: string[];
  addresses: ReachableAddress[];
  clients: { count: number; lastAt: number | null; addresses: string[]; liveCount: number };
  /** One row per device that has reached this machine. `live` is sockets held
   *  open right now, which is the difference between "is here" and "was here". */
  devices: RemoteDevice[];
  firewall: FirewallHint | null;
  /** This machine's tailnet identity, and whether we could confirm it. Optional
   *  only so a client can talk to an older server without crashing. */
  tailnet?: TailnetHealth;
}

/**
 * What the server knows about this machine's Tailscale name, and how it knows.
 *
 * The gate that admits the phone's WebSocket reads this set, so an empty one is
 * not cosmetic — it refuses `/stream` while REST keeps answering, which is the
 * shape of "the app looks alive and stopped buzzing". `problem` is what makes
 * "no tailnet" and "could not ask tailscale" different answers on screen; they
 * used to be the same empty set. The server's remote.ts is the authority.
 */
export interface TailnetHealth {
  /** `tailscale` was on PATH at the last look. */
  installed: boolean;
  /** Names this machine is trusted to answer to right now. */
  names: string[];
  /** When the last ANSWER landed. 0 ⇒ there has never been one. */
  at: number;
  /** Set while tailscale cannot be asked: `names` is the last known value, held
   *  on a deadline, not a fresh one. */
  problem?: string;
  /** Consecutive failed probes. */
  fails?: number;
  /** The hold expired — `names` is empty because the server gave up on it, not
   *  because the tailnet is empty. A phone on its MagicDNS name is refused. */
  dropped?: boolean;
}

// --- what this machine is doing, and what is in this checkout ---------------
// Defined here rather than imported from server/src, so the web bundle names
// the same shapes without pulling a module that reads /proc into the browser.
// The server's machine.ts and files.ts are the authorities; these mirror them.

/** One listening TCP socket. */
/** One thing that has piled up in a checkout, and the line that clears it. */
export interface TidyFinding {
  id: string;
  title: string;
  what: string;
  items: string[];
  extra: number;
  /** Null where there is no command safe enough to offer — see `note`. */
  command: string | null;
  note?: string;
  /**
   * The three questions somebody should be able to answer before pressing
   * Enter on a command that changes their repository, and could not answer
   * from the list alone.
   *
   * `why` is the evidence — the actual thing git said that put this row here,
   * so the finding is checkable rather than trusted. `effect` is what the
   * command does, in plain words. `risk` is the worst case, including the
   * common one where git simply refuses.
   */
  why: string;
  effect: string;
  risk: string;
  /**
   * Items that are in the list but deliberately NOT in the command.
   *
   * Watching it run is what put this here: seven branches deleted cleanly and
   * two refused, in red, because they were checked out in a worktree. Both
   * refusals were predictable — `git worktree list` names every branch that is
   * checked out — so the panel knew and said nothing, and let the user find
   * out from stderr.
   */
  blocked: { name: string; why: string }[];
  /** A few lines of monospace drawing. The situations here are all shapes —
   *  something pointing at something that is gone — and a shape is faster to
   *  see than to read. */
  diagram: string[];
}

export interface TidyReport {
  root: string;
  base: string;
  findings: TidyFinding[];
  error?: string;
}

export interface PortEntry {
  port: number;
  addr: string;
  proc: string | null;
  pid: number | null;
  /** Where the process was started — the worktree, nine times out of ten. */
  cwd: string | null;
  /** Owned by the user running the server: the only ones we can name, and the
   *  only ones we would ever signal. */
  mine: boolean;
  /** Seconds since it started, or null when /proc would not say. Age is the
   *  difference between "the dev server I just started" and "something that
   *  has been holding a port since this morning". */
  ageSec: number | null;
  /**
   * Its ancestry runs through an agent's tool-call shell.
   *
   * A fact, not a verdict: an agent starts a server on purpose all the time.
   * What it buys is the answer to "who started this, then" for a process
   * nobody in front of the screen remembers launching — which is the whole
   * question you ask when a port is taken and you do not know by what.
   */
  fromAgent: boolean;
  /** Its working directory is gone. Whatever checkout it was serving has been
   *  deleted underneath it, so nothing it is doing can still matter. */
  cwdGone: boolean;
  /**
   * What started it, nearest first — `bun ← bash ← agentglass-server`.
   *
   * `fromAgent` answers yes-or-no; this answers "by what". The difference
   * matters when the chain is the explanation: a `bun` under a login shell is
   * something left running, and the same `bun` under this app's own sidecar
   * came out of an agent's terminal and inherited that terminal's environment
   * — which is how one ended up bound to every interface carrying a token
   * nobody meant to hand out.
   *
   * Empty for other users' processes and for orphans whose parents have gone.
   */
  ancestry: Forebear[];
  /** Bound to every interface rather than to loopback. Stated rather than left
   *  to be spotted in `addr`: it is the one fact on the row whose consequence
   *  leaves the machine. */
  publicBind: boolean;
  /** The binary behind it has been deleted or replaced on disk — the kernel
   *  keeps the inode alive, so it is still running code you no longer have.
   *  Usually a rebuild underneath a server somebody forgot to restart. */
  exeGone: boolean;
}
/** One rung of a process's ancestry. */
export interface Forebear { pid: number; name: string }
export interface PortsReport { ports: PortEntry[]; mine: number; external: number; error?: string }

/**
 * A git lock file, and whether anything is behind it.
 *
 * Git does not take a kernel lock — it creates a file and relies on O_EXCL, so
 * the lock IS the file's existence and nothing in it says who made it. The
 * holder is inferred from the other end: a live `git` working in this checkout.
 * See server/src/gitlocks.ts.
 */
export interface GitLock {
  /** The checkout it belongs to — a linked worktree in its own right. */
  repo: string;
  /** `index.lock`, `HEAD.lock`, `refs/heads/main.lock`. */
  name: string;
  path: string;
  ageSec: number;
  heldBy: { pid: number; cmd: string } | null;
  /** Nothing is holding it. Usually means safe to delete; `ageSec` is beside it
   *  because a two-second-old lock is a git mid-write the scan just missed. */
  stale: boolean;
}
export interface GitLocksReport { locks: GitLock[]; scanned: number; error?: string }

/** One environment variable, with its value withheld when it looks like a
 *  secret. `null` means hidden; `""` is a real, empty value. */
export interface EnvVar { key: string; value: string | null; masked: boolean }
/**
 * Everything about one process that will not fit on a row.
 *
 * The command line in full, what started it, and the environment it was given
 * — which is where the explanation for a stray process actually lives, and also
 * where its secrets do. See server/src/procdetail.ts for the masking rule.
 */
export interface ProcDetail {
  pid: number;
  comm: string;
  cmd: string;
  cwd: string | null;
  ageSec: number | null;
  ancestry: Forebear[];
  env: EnvVar[];
  error?: string;
}

/** One process worth showing. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  /** Percent of one core since the previous sample, or null on the first one —
   *  a rate needs two readings. */
  cpu: number | null;
  rss: number;
  cwd: string | null;
  /** Descended from this server (or from a tmux it started). */
  ours: boolean;
}
export interface MachineTotals {
  /** Busy percent across all cores, 0..100; null on the first sample. */
  cpu: number | null;
  cores: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  /** Hottest thermal zone in °C, or null where the kernel exposes none. */
  tempC: number | null;
  load1: number;
  diskFree: number;
  diskTotal: number;
}

export interface ResourceReport {
  procs: ProcEntry[];
  /** The whole machine, so the panel can say what share of it is ours. */
  machine: MachineTotals;
  totalCpu: number | null;
  totalRss: number;
  oursCpu: number | null;
  oursRss: number;
  seen: number;
  rated: boolean;
}

export interface SpaceDir { path: string; name: string; bytes: number; reclaimable: boolean }
export interface SpaceReport { root: string; bytes: number; freeable: number; dirs: SpaceDir[]; error?: string }

export interface FileEntry {
  name: string;
  rel: string;
  dir: boolean;
  size?: number;
  /** Git status in this checkout: M, A, D, R, ? untracked, · something below. */
  status?: string;
}
export interface TreeReport { ok: boolean; root: string; rel: string; entries: FileEntry[]; error?: string }
export interface FindReport {
  ok: boolean;
  files: string[];
  /** Directories whose path matches too.
   *
   *  Typing `guest-checkout-v2` used to answer with the forty files inside
   *  that folder and never with the folder — which is the one result that says
   *  "here is the thing you named". Kept apart from `files` rather than mixed
   *  in, because opening one is a different action: a file opens in the
   *  viewer, a directory moves the tree. */
  dirs: string[];
  truncated: boolean;
  via: string;
  error?: string;
}
export interface GrepHit { rel: string; line: number; text: string; at: number; len: number }
export interface GrepReport { ok: boolean; hits: GrepHit[]; files: number; truncated: boolean; via: string; error?: string }

// --- github issues ---------------------------------------------------------
// Mirrors server/src/issues.ts, which is the authority.

export interface IssueLabel { name: string; color: string }
export interface IssueRow {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: IssueLabel[];
  assignees: string[];
  comments: number;
  updatedAt: string;
  url: string;
}
/** How work on an issue was started, and where it lives. */
export type StartMode = "worktree" | "shell" | "claude" | "plan" | "branch";
export interface IssueWork {
  number: number;
  repo: string;
  branch: string;
  path: string;
  mode: StartMode;
  window?: string;
  startedAt: number;
}
export interface IssueDetail extends IssueRow {
  body: string;
  createdAt: string;
  milestone: string | null;
  work: IssueWork | null;
}
/**
 * A pull request that has something to do with an issue.
 *
 * `linked` is the difference between the two things GitHub's timeline calls a
 * reference, and it is not cosmetic: a linked pull request is one somebody
 * attached to the issue and is what will close it, while a mention is a `#123`
 * that appeared in a body somewhere. Showing the second as the first promises
 * a fix nobody committed to.
 */
export interface IssuePr {
  number: number;
  title: string;
  /** OPEN | CLOSED | MERGED, as GitHub spells it. */
  state: string;
  url: string;
  draft: boolean;
  linked: boolean;
}
export interface IssuePrsReport { ok: boolean; prs: IssuePr[]; error?: string }
export interface IssuesReport { ok: boolean; issues: IssueRow[]; error?: string }
export interface IssueStartResult {
  ok: boolean; error?: string; work?: IssueWork; prompt?: string; cwd?: string;
}
export interface IssueActionResult { ok: boolean; error?: string; detail?: string; dirty?: string[] }

/**
 * A tmux pane, and the agent found running inside it.
 *
 * `agentCwds` is the join key the UI matches a waiting session against — the
 * directories the agent processes inside this pane are in, which is what their
 * hook events report. Deliberately not `path`: that is the shell's directory,
 * and on a real machine several panes share it while the agent in one of them
 * sits in a worktree. A list because panes nest agents, and taking only the
 * outermost named the wrong directory. Empty where none was found, or off
 * Linux, where /proc is not there to ask.
 */
export interface AgentPane {
  session: string;
  sessionId: string;
  windowId: string;
  windowIndex: string;
  windowName: string;
  paneId: string;
  path: string;
  agentCwds: string[];
  /**
   * A tmux popup — a session that is only ever shown INSIDE another one.
   *
   * Read off the client's TERM (see `nestedSessions` on the server), which is
   * knowable only while the popup is open, so the route remembers every session
   * it has ever seen marked. The phone drops these from its strip: a scratchpad
   * is what you open over your work and dismiss, not a place to go.
   */
  popup?: boolean;
  /**
   * Somebody has this session on a screen.
   *
   * Here, in the contract, and that placement is the whole point. It used to be
   * declared inline in `listPanes`'s return type, where only the server could
   * see it — so renaming it typechecked green on the server AND on the desk
   * (which never reads it) while the phone's `pane.attached === false` filter
   * quietly became `undefined === false` and stopped firing, putting every
   * detached session on the machine back into the tab strip. tabs.ts records
   * that as a bug already fixed once.
   *
   * Optional because absent is a THIRD answer the phone acts on: a server too
   * old to say, whose panes it keeps rather than hides. That is why the test is
   * `=== false` and not `!attached`.
   */
  attached?: boolean;
  /** The agent session this pane last reported, from the `tmux_pane` its hooks
   *  carry. An exact answer where `agentCwds` can only offer a directory two
   *  agents may share — null when nothing ever reported one, which is every
   *  agent not started under a hook-wired CLI. */
  agentSession: string | null;
}

/**
 * What GET /terminal/panes answers — the desk's pane picker and the phone's
 * whole tab strip.
 *
 * Written down because two of the three ends had their own idea of it: the desk
 * declared the body inline and left `canAttach` out, the phone typed it as
 * `{ panes?: unknown }` and cast. Neither could be wrong about a field it did
 * not name, which is another way of saying neither could notice one changing.
 */
export interface PanesResponse {
  ok: boolean;
  /** Why there is nothing to point at, when the answer is not ok. The live
   *  route always answers ok; this is the demo build's sentence. */
  reason?: string;
  panes: AgentPane[];
  /**
   * This server understands `?pane=` on the terminal socket.
   *
   * A build without it ignores the parameter and opens a plain shell, so a
   * phone tapping a tab gets an empty prompt where the running session should
   * be, with nothing anywhere to say why. Optional, and checked as
   * `canAttach !== true` rather than `=== false`, because the build that cannot
   * do it is exactly the build that does not send the flag.
   */
  canAttach?: boolean;
}

// ---------------------------------------------------------------------------
// local tasks (Taskwarrior-backed)
// ---------------------------------------------------------------------------

/** Whether this machine can read a local task list, and if not, why not. The
 *  two failures are different and the panel says different things about them:
 *  a missing binary is a thing to install, an unconfigured one is a question
 *  only the user can answer. */
export interface TaskCapability {
  available: boolean;
  configured: boolean;
  version?: string;
  reason?: string;
}

/**
 * One task as this app models it.
 *
 * Taskwarrior's `id` is deliberately absent: it is a display number, reassigned
 * whenever the store is garbage-collected, so anything holding one across a
 * refresh acts on whatever task inherited it. `uuid` is the only reference.
 *
 * Notes and URLs are one field in Taskwarrior (annotations) and two here,
 * because one is prose to read and the other is a link to follow.
 */
export interface LocalTask {
  uuid: string;
  description: string;
  status: "pending" | "completed" | "deleted";
  project: string | null;
  priority: "H" | "M" | "L" | null;
  tags: string[];
  /** Local calendar dates, "YYYY-MM-DD" — converted from Taskwarrior's UTC. */
  due: string | null;
  created: string | null;
  completed: string | null;
  urgency: number;
  notes: string[];
  urls: string[];
}

export interface TasksListResponse {
  ok: boolean;
  tasks: LocalTask[];
  capability: TaskCapability;
  error?: string;
  /** The soonest live reminder per task uuid, so a list of rows can show its
   *  own without a request per row. */
  byTask?: Record<string, Reminder>;
  /** What the store looked like when this was read. Handed back with a write as
   *  its precondition: if the store has moved since, the row on screen is not
   *  the row being acted on. */
  fingerprint?: string;
}

export interface TaskWriteResponse {
  ok: boolean;
  error?: string;
  /** The store moved underneath — the caller re-renders from `tasks` rather
   *  than retrying, because a retry against a moved store is the clobber. */
  conflict?: boolean;
  tasks?: LocalTask[];
  fingerprint?: string;
}

/**
 * When to tell somebody about something.
 *
 * agentglass's own, not Taskwarrior's — which is what lets a reminder fire on a
 * machine where the task list cannot be read at all. `taskUuid` is nullable and
 * first-class: a reminder with nothing behind it is a legitimate thing to want.
 *
 * `civil` + `zone` are what the human asked for; `due` is those two resolved.
 * Keeping the pair rather than only the instant is what makes "Monday 9:00"
 * still mean nine o'clock after the clocks change.
 */
export interface Reminder {
  id: string;
  taskUuid: string | null;
  title: string;
  root: string | null;
  /** "2026-08-05T09:00" — local wall clock, as typed. */
  civil: string;
  /** IANA zone the civil time was written in. */
  zone: string;
  due: number;
  created: number;
  /** The ledger. Written inside the claim, before any delivery is attempted. */
  firedAt: number | null;
  ackedAt: number | null;
  cancelledAt: number | null;
  snoozeOf: string | null;
}

export interface RemindersResponse {
  ok: boolean;
  reminders: Reminder[];
  /** Keyed by task uuid — the soonest live reminder for each, so a list of rows
   *  can show its own without a query per row. */
  byTask?: Record<string, Reminder>;
}

// ---------------------------------------------------------------------------
// recipes — commands you saved, as opposed to commands we found
// ---------------------------------------------------------------------------

/**
 * A hole in a recipe, and what may fill it.
 *
 * Typed rather than free text wherever the app already knows the answer: a
 * `worktree` is chosen from the ones this repo has, so it cannot be misspelled
 * and cannot be anything else. That is not only convenience — see renderSteps
 * for why a typed value is also the safe one.
 */
export interface RecipeParam {
  /** What `{{this}}` is called in the steps. */
  key: string;
  label: string;
  /** `flag` is a yes/no — the `--rebuild-fe` of any script. */
  type: "text" | "choice" | "flag" | "repo" | "worktree" | "branch";
  /** For `choice`, the closed list. Ignored otherwise. */
  options?: string[];
  value?: string;
}

/**
 * A command with a name, saved by the person who wrote it.
 *
 * The other half of the terminal's command list: `ProjectCommand` is what we
 * DISCOVER by walking a repo's Makefiles and package.json, and it can only ever
 * be a single line with no arguments. This is what somebody keeps — several
 * steps, parameters, and a decision about where it runs.
 */
export interface Recipe {
  id: string;
  name: string;
  desc: string;
  /** In order. A step that fails stops the rest. */
  steps: string[];
  /** `repo` narrows it to one checkout and its worktrees. */
  scope: "global" | "repo";
  /** The repository root, when scoped to one. */
  repo?: string;
  params?: RecipeParam[];
  /** Long ones belong in tmux, so closing the app cannot take them with it. */
  tmux?: boolean;
  /** Ask before running, every time. Set by the author, and forced on by the
   *  server for anything that reads as destructive. */
  confirm?: boolean;
  addedAt: number;
}

export interface RecipesResponse { recipes: Recipe[] }

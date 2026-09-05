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
  /** What the session is to the app, from its pane's AGENTGLASS_ROLE: the
   *  Lantern's own chat is an observer, never an agent stopped on a person. */
  role?: string;
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
  /** tmux's own description of how the window is split (`#{window_layout}`),
   *  kept so a restore brings it back split the same way. */
  layout?: string;
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
  | {
      t: "tmux"; active: boolean; windows: TmuxWindow[]; panes: TmuxPane[]; session?: string | null;
      prefix?: string[]; client?: { cols: number; rows: number } | null;
      /**
       * Every session on this socket with a window in it.
       *
       * The tab strip shows the session its own client is attached to, so a
       * window opened elsewhere is invisible — and switching the client onto
       * it takes somebody's own four windows off the screen. This is what lets
       * the strip OFFER the others instead: the person chooses.
       */
      sessions?: { id: string; name: string; windows: number; locked?: boolean }[];
      /** This shell is on agentglass's OWN tmux, not the machine's. The panel
       *  hides "Use tmux's bar" there: that server keeps its status line off by
       *  design — the config gate refuses any config that turns it on — so the
       *  button would offer a bar that cannot arrive. */
      engine?: boolean;
      /**
       * A tmux popup — the scratch — is drawn over this terminal right now.
       *
       * A popup is a second client on the same server and tmux paints it INTO
       * this screen: same windows, same panes, same geometry, different pixels.
       * So anything the app draws on a pane has to stand down while it is up,
       * or it hovers over a popup on a pane nobody can see.
       */
      popup?: boolean;
    }
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
  /** The browser tab this panel lives in went hidden or came back — see
   *  `document.hidden` in TerminalPanel.tsx. Lets the server pause the 500ms
   *  tmux tab-strip sweep for a tab strip nobody can see, without touching
   *  the session itself. */
  | { t: "visible"; hidden: boolean }
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
   *  A NUMBER and a directory: the prompt and the binary are the server's.
   *  `recipe` names which entry of the Review menu — an ID the server looks up
   *  in its own catalogue, never the prompt itself, so this socket still cannot
   *  choose the text that reaches the agent. `card` is the tracker id the panel
   *  read off the branch, which the server has no way to work out. */
  | { t: "tmux"; cmd: "review"; number: number; root: string; recipe?: string; card?: string }
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
  | {
      t: "tmux"; cmd: "agent"; yolo?: boolean;
      /**
       * Which CLI, as an id from shared/agentKinds.ts.
       *
       * Absent means Claude, which is what this frame meant before the phone
       * had a menu — so every caller that predates it stays right without
       * passing a constant. Validated against the table on arrival: it decides
       * which executable runs, so it is an id or it is refused, never a string
       * that reaches a lookup.
       */
      kind?: string;
    }
  /**
   * Bring a past session back — the picker's "open this one".
   *
   * `id` is a transcript's name and `cwd` the checkout it ran in; both come
   * from `/agent/sessions`, and both are checked again on arrival because this
   * socket is reachable from a browser and they end up on a command line.
   * `split` puts it beside what is on screen instead of in a window of its own,
   * and `yolo` is the only flag the client may ask for — the binary and every
   * other argument are the server's.
   */
  | { t: "tmux"; cmd: "resume"; id: string; cwd: string; split?: boolean; yolo?: boolean }
  /* `session` shows another tmux session in this strip. It is a `switch-client`,
     the same call the app used to make BY ITSELF when it opened a window
     elsewhere — which took four windows of somebody's own work off their screen.
     Asked for by a person it is the opposite: they know where they are going,
     and the strip they came from is one choice away. */
  | { t: "tmux"; cmd: "select" | "new" | "kill" | "rename" | "move" | "takeover" | "fit" | "session" | "endsession" | "locksession"; window?: string; name?: string;
      /** `fit` only: the asking panel's own grid. Range-checked on the server —
       *  it ends up in a `resize-window`, so it is a number to validate rather
       *  than to trust. */
      cols?: number; rows?: number;
      /** `move` only: land AFTER the named window instead of before it. What
       *  the trailing drop zone at the end of the tab strip sends — it is the
       *  only way to make a window the last one. */
      after?: boolean;
      /** `new` only: the project the panel is showing, so the tab opens in it.
       *  Without it tmux starts the window in the SESSION's directory, which is
       *  wherever the server happened to be launched from — for a desktop build
       *  that is the install checkout, so every new tab landed in agentglass's
       *  own tree instead of the repository on screen. Checked on the server
       *  against the workspace before it reaches a command line. */
      root?: string };

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
/**
 * One changed file, as the Diff view lists it. No diff text.
 *
 * This exists because the view used to list `FileChange`, which describes
 * something else entirely: one agent's Edit call, with a database id, a session,
 * a tool name and the timestamp of the hook that recorded it. A file that git
 * says has changed has none of those, so every field was invented — the stamp
 * became "when the server was asked", the session became the literal string
 * "staged", and the id became a hash of the two. Every one of those inventions
 * turned into a bug the reader could see: times that were all the current clock,
 * groups called `git:unstaged`, and an id that changed when you ran `git add`,
 * which threw away the selection and the review tick with it.
 *
 * So: a row says what changed, where, how much and WHEN, and nothing about who
 * observed it. The diff text is a second request (`FileDiff`), because the list
 * is 400 rows and the reader is looking at one — carrying the hunks in the row
 * was 89% of a megabyte re-fetched every four seconds.
 */
export interface ChangeRow {
  /** `${repoRoot}\0${path}`. Stable across staging, across polls, across edits,
   *  and unique between two worktrees holding the same relative path — which is
   *  the whole reason a hash of anything else was wrong. */
  key: string;
  repoRoot: string;
  /** The branch the checkout is on, so the list can head a section with the
   *  thing the work is called rather than a folder name. */
  branch: string;
  /** Relative to `repoRoot`. Absolute paths are a rendering decision, not a
   *  storage one, and every consumer wants the short form. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "typechange";
  /** In ONE row. `git status` reports a partially staged file as two states of
   *  one file; the old list emitted two rows with nothing to tell them apart. */
  staged: "none" | "partial" | "full";
  /** Where a rename came from. Computed before and never rendered, which made a
   *  rename look like a brand-new file with an empty diff. */
  oldPath?: string;
  additions: number;
  deletions: number;
  /** Both mean "there is no text to show", and both are things the panel has to
   *  SAY rather than answer with a blank pane and "0 hunks". */
  binary: boolean;
  tooBig: boolean;
  /** When the file changed. Working: the file's mtime. Committed: the commit's
   *  own date. Never the time of the request. */
  changedAt: number;
  ignored: boolean;
  outside: boolean;
  /** Committed mode only: which commit this row came from. */
  commit?: { hash: string; subject: string; author: string; at: number };
}

/** The other half: the text of one file's diff, fetched when a row is opened. */
export interface FileDiff {
  key: string;
  /** Changes whenever the content does — mtime+size while uncommitted, the
   *  commit hash once committed. The client keys its cache on this, so a row
   *  that has not changed is never re-fetched, and one that has cannot be
   *  served stale. */
  sig: string;
  hunks: DiffHunk[];
  /** The diff was cut off — a generated file with 40k changed lines is not
   *  something to render, and pretending it rendered is worse. */
  truncated: boolean;
  binary: boolean;
  error?: string;
}

/** What `/git/changes-v2` answers. `truncated` counts rows NOT sent, so the
 *  view can say so instead of silently ending a worktree short. */
export interface ChangeRowsResult {
  rows: ChangeRow[];
  truncated: number;
  /** Repos that failed to read, by root — one broken checkout must not empty
   *  the list for the other eighteen. */
  failed?: string[];
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
export type ViewId = "dash" | "git" | "diff" | "pr" | "docker" | "term" | "chat" | "browser" | "files" | "tasks" | "understudy" | "lantern";

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
    | "back" | "forward" | "scroll" | "press" | "text"
    /* The tab verbs. The panel has had tabs since it had a panel; these are
       what let an agent reach them — see BrowserOp for why `open` still
       replaces the current view. */
    | "tabs" | "tab" | "newtab" | "closetab"
    | "console" | "network" | "resize" | "zoom" | "html" | "waitfor" | "observe"
    | "eval" | "select" | "reload" | "cookies" | "frames"
    /* §3's actionability half: click's other verbs, and a whole form as one
       call. See browserDrive.ts's `actionable()` for the gate all but
       focus/blur share. */
    | "dblclick" | "rightclick" | "hover" | "focus" | "blur" | "check" | "fill"
    /* §4 of the browser spec, the two verbs it names as the thing that
       unblocks everything else after `eval`. `addInitScript` runs before the
       page's own scripts, on every navigation, until removed or replaced by
       name; `expose` is a name the page can call back into, read back with
       `exposed`. */
    | "addInitScript" | "expose" | "exposed"
    /* §5: the DevTools protocol relayed whole, plus the two readings the spec
       names — which listeners a node has and where they come from, and which
       lines of JS and CSS actually ran. `cdp` counts as ACTING, because the
       protocol can navigate, click and evaluate. */
    | "cdp" | "listeners" | "coverage"
    /* §9: which isolated contexts exist. Tabs share a session, so "two actors
       at once" — one watching a panel while the other changes its state — is
       exactly what tabs alone cannot do; profiles are the isolation, and the
       panel has had them all along. */
    | "profiles"
    /* §10: "this page, as a phone, in Tokyo, in dark mode" is one thought, so
       it is one verb. Not cosmetic — colour scheme, timezone and language
       change what a real app renders. */
    | "emulate"
    /* §1: wait for something to happen instead of asking twenty times. The
       polling moves to the server, where it costs a loop instead of a process
       start and a context entry per turn. */
    | "events"
    /* §12: N frames at an interval, straight to disk and optionally a GIF —
       the thing that gets assembled by hand with ffmpeg today. */
    | "record"
    /* §11: click something that starts a download and wait for the file —
       never dispatched to the panel itself (the polling and the filesystem
       live server-side, same as `record`), listed here for the same reason
       `record` and `events` are: the ask is still typed against this union
       on its way through the relay. */
    | "download"
    /* §16's audit log, and §12's "export the session as an executable script"
       — the same list read twice. A GET route nothing outside the app could
       reach is not an exportable log. */
    | "audit"
    /* §5's debugger as one verb with an action. The protocol is reachable
       whole through `cdp`; this wraps the part that is genuinely awkward
       there — a pause is an EVENT, and reading a paused frame's scope is a
       three-call chain whose arguments come out of the previous answer. */
    | "debug"
    /* §13: the browser's own settings as an API — proxy, certificates, cache
       policy, blocking per origin — rather than as a screen only a person can
       reach. */
    | "settings"
    /* §3 and §11: a drag is a pointer sequence, not two clicks; a file input
       cannot be filled from script at all and needs the shell. */
    | "drag" | "upload"
    /* §7 and §10: the rest of a session (a login is as often a token in
       localStorage as a cookie), permissions granted by API rather than by a
       dialog nobody can click, and print-to-PDF. */
    | "storage" | "permission" | "pdf"
    /* §6: the other half of a broken API is a SLOW one, and a HAR is the
       evidence that outlives the session. */
    | "throttle" | "har"
    /* §12: DOM, network and console against one timeline, navigable
       afterwards — what happened, as an artefact rather than a reconstruction. */
    | "trace"
    /* §2: the tree of one subtree instead of the page — a modal is fifteen
       nodes inside three hundred, and the rest is paid for every turn. */
    | "region"
    /* §11: the clipboard through the route that works, and the page as one
       file that still renders offline. */
    | "clipboard" | "save"
    /* §6: extra headers for the session, not for one call — a page makes
       dozens of requests and a header on the one you named proves nothing. */
    | "headers"
    /* §6: pause a request at the network level and decide what happens to it —
       which catches what the page did not make through fetch. */
    | "intercept"
    /* §8: three minutes of real waiting, measured, for one screenshot of a
       thirty-second timer. `advanceMs` is `Emulation.setVirtualTimePolicy`;
       `seal` and `freezeAnimations` are the rest of what a REPEATABLE capture
       needs alongside the jump, in the same verb rather than three calls a
       caller has to remember to make together every time. */
    | "clock"
    /* §6: force a 404, a 500 or a hang on requests matching a URL pattern —
       "the board freezes when the API is down" could only be proved in a
       unit test without this. A lie told to the page on purpose, so every
       faked row in `network`/`observe` carries `fake: true` rather than
       looking like a real failure. */
    | "fake"
    /* One line: window open, panel mounted, page alive — see §15 of the
       browser spec. Answered even when there is nothing to drive, which is
       the point of it. */
    | "health";
  args: Record<string, unknown>;
}

/**
 * How far the understudy is allowed to go for one class of decision.
 *
 * A ladder, not a switch, and nothing on it ever climbs itself. `shadow` is
 * the whole of v1: the understudy writes down what it would have done and is
 * scored against what actually happened, and that is all it does. `guided`
 * would mean it proposes and a human presses; `auto-undo` that it acts where
 * the act is reversible and says so; `auto` that it acts. The last three exist
 * in the type today because the scorecard has to be able to SAY which rung a
 * class is being offered, and a promotion that has to invent its own vocabulary
 * later is a promotion nobody can review now.
 */
export type UnderstudyMode = "shadow" | "guided" | "auto-undo" | "auto";

/**
 * ═══ THE TWO AXES ═══
 *
 * "Directed / supervised / autonomous" was the first shape of this and it is
 * one dial doing two jobs. How much INITIATIVE a thing takes and how much
 * REACH it has are independent questions, and collapsing them makes two
 * perfectly sensible settings inexpressible: "only speaks when spoken to, but
 * may push to a shared branch" and "starts work by itself, but can never
 * produce anything more than a draft" are both things a person might want, and
 * neither survives a single scale.
 *
 * They are also different KINDS of question. Initiative is a matter of taste —
 * how much interruption you want. Reach is a matter of blast radius, and it is
 * the one that decides whether a mistake costs a keystroke or a job. Putting
 * them on one dial means every time you want a bit more help you also buy a bit
 * more danger, which is exactly the trade nobody should be forced into.
 *
 * So: a stance, a reach, and the floor of the two.
 */

/**
 * INITIATIVE — who starts, and who says yes.
 *
 * Seven rungs rather than three, because the interesting distinctions all live
 * in the middle. The gap between "it mentions what it would do" and "it
 * prepares the work and waits" is the difference between a hint and a queue,
 * and that is precisely the granularity a person wants when they are deciding
 * how much of their attention to sell.
 *
 *  off        Records nothing at all. Not a pause — the seams do not fire.
 *  watching   Records and predicts silently. Scored, says nothing. (v1's only rung.)
 *  asked      Answers when you ask it. Starts nothing.
 *  offering   Volunteers in place — "I would do X here" — where the decision is
 *             already being made. Nothing queues, nothing waits, ignoring it
 *             costs nothing.
 *  queued     Prepares the work for real and puts it in a queue. Every item
 *             waits for a person to approve it, one at a time.
 *  undo       Does it, captures the undo FIRST, and tells you. You audit after
 *             rather than before.
 *  acting     Does it.
 *
 * The rungs are ordered and the order is load-bearing: a class may sit at or
 * below the global stance and never above it.
 */
export type UnderstudyStance =
  | "off"
  | "watching"
  | "asked"
  | "offering"
  | "queued"
  | "undo"
  | "acting";

export const STANCES: readonly UnderstudyStance[] = [
  "off", "watching", "asked", "offering", "queued", "undo", "acting",
];

/**
 * REACH — what it is allowed to touch, whatever its stance.
 *
 * A hard cap and a separate decision. Each rung strictly contains the ones
 * before it, so this is a ceiling and not a menu.
 *
 *  read      Looks. Produces nothing that outlives the answer.
 *  draft     Produces text — a commit message, a PR body, a reply — that goes
 *            nowhere until a person takes it. The safe default for real help.
 *  own       May change files inside a worktree IT created. Nothing it did not
 *            make, and nothing anybody else is standing in.
 *  shared    May touch a branch other people use. Gated on the safety seals,
 *            because this is the first rung where a mistake reaches somebody
 *            else's afternoon.
 *  outward   Text may reach another human, or a system of record. Refused in
 *            this build at the route table, not here — a push, a task-tracker
 *            write, a review posted under the user's name. This rung exists so
 *            the refusal has a name, not so it can be selected.
 */
export type UnderstudyReach = "read" | "draft" | "own" | "shared" | "outward";

export const REACHES: readonly UnderstudyReach[] = ["read", "draft", "own", "shared", "outward"];

/** Where the pair currently sits, plus the per-class exceptions. */
export interface UnderstudyPosture {
  stance: UnderstudyStance;
  reach: UnderstudyReach;
  /**
   * Per class, a stance no higher than the global one.
   *
   * The point of the override is asymmetric: it exists to hold a class BACK.
   * A person who is happy for commit messages to be queued is not thereby happy
   * for merges to be, and the honest way to say that is one dial for the mood
   * and thirteen brakes for the specifics.
   */
  perClass: Record<string, UnderstudyStance>;
  /** The highest rung this build can reach at all, whatever is selected. */
  ceiling: UnderstudyStance;
  /** The highest reach this build allows, whatever is selected. */
  reachCeiling: UnderstudyReach;
}

/** One place the understudy may be taught from. */
export interface UnderstudySource {
  id: string;
  /** What it is, for a person: "Your conventions", "Project memory". */
  label: string;
  /** Where it lives. Shown so nobody has to guess what was read. */
  path: string;
  kind: "rules" | "precedents";
  /** Files found. 0 means the path exists and holds nothing we can read. */
  files: number;
  /** Rough size, bytes, for the ones worth warning about. */
  bytes: number;
  /** Present on disk right now. */
  found: boolean;
  /** The user has said yes to this one. Nothing is read without it. */
  allowed: boolean;
  /** Discovered by us, or typed in by the user. */
  added: boolean;
  /** Why it is worth reading, in one sentence, for the consent screen. */
  what: string;
  /**
   * Filed in the CLOSED partition rather than the open one.
   *
   * Not a judgement about whose work it is — it is all the user's work. It
   * decides where a row may travel: retrieval never crosses a partition, so a
   * prediction bound for a public repository can never surface something that
   * came out of a private one. That is the protection, and it is about where a
   * name may end up rather than about who did the work.
   */
  sensitive: boolean;
  /** In the set we would suggest starting from. Deliberately conservative. */
  recommended: boolean;
}

/** What an ingest run did, kept so the panel can say what it learned. */
export interface UnderstudyLearned {
  at: number;
  /** Rules compiled, and how many carry enough precedents to be backed. */
  rules: number;
  backed: number;
  /** Precedents banked. */
  precedents: number;
  /** Files read, and files skipped because the exclusion list matched. */
  filesRead: number;
  filesSkipped: number;
  /** Windows refused because a private term was found in them. */
  quarantined: number;
  /** Per source, what came out of it. */
  bySource: { id: string; label: string; rules: number; precedents: number; skipped: number }[];
}

/**
 * Why a class might never climb, regardless of how well it scores.
 *
 * `earn` is the ordinary case: agreement is measured and the class becomes
 * eligible to be offered. `key` is a class whose act is answering on somebody
 * else's behalf — a permission prompt — which stays in shadow for the whole of
 * v1 no matter what it scores. `sealed` is a class that stays in shadow for
 * ever by decision rather than by score, because the thing it would touch is
 * somebody else's record of what the work is.
 *
 * The distinction is kept in the data rather than in the panel's head, because
 * "this one is at 0.81 and still shadow" is the question the scorecard will be
 * asked most often, and the answer has to be visible next to the number.
 */
export type UnderstudyLock = "earn" | "key" | "sealed";

/** One class of decision, as the scorecard shows it. */
export interface UnderstudyClassRow {
  /** `C1`…`C13`. Stable — it is the key the ledger rows are filed under. */
  id: string;
  label: string;
  lock: UnderstudyLock;
  /** Where the class actually is. In v1 this is `shadow` for all thirteen. */
  mode: UnderstudyMode;
  /**
   * The thresholds are met and a human could be asked to promote it.
   *
   * Being offered is not being on, and the wording is load-bearing: nothing in
   * the understudy flips itself, so this flag is the strongest statement the
   * server ever makes about autonomy.
   */
  offered: boolean;
  /**
   * Scored decisions — the denominator. Only rows whose provenance was `typed`
   * or `clicked` count. An agent tolerating something is not the user agreeing
   * with it, and counting it would let the understudy grade its own homework.
   */
  n: number;
  /** Of those `n`, how many the prediction matched. */
  hits: number;
  /** `hits / n`, or 0 when `n` is 0. The honest ratio, which is not the gate. */
  raw: number;
  /** wilsonLower(hits, n) — see shared/wilson.ts. This is the gate. */
  lb: number;
  /**
   * Credit the class has banked: agreements in a row since the last differ.
   *
   * Nothing spends it — it is a reading, not a currency. It is here because a streak
   * is the part of the record a person actually reads — "it has been right the
   * last forty times" lands where a bound of 0.63 does not.
   */
  bank: number;
  /**
   * Why it is not being offered, as finished sentences the panel prints
   * verbatim — one per reason, in the order a reader should meet them: the lock
   * first when there is one, then too few decisions, then the raw rate, then
   * the bound.
   *
   * This field was specified as short categorical codes, on the reasoning that
   * a panel which has to parse a sentence to draw a chip draws the wrong chip
   * in another language. That reasoning is right and it is why the codes are
   * still here — they are just not in THIS field. `n`, `hits`, `raw`, `lb`,
   * `mode`, `offered` and `lock` sit on the same row, and every chip the panel
   * draws is drawn from those. Nothing parses `blocked`.
   *
   * What is left over once the chips are drawn is the explanation, and an
   * explanation assembled in the panel would have had to re-derive the
   * thresholds to phrase itself — putting `80`, `0.70` and `0.60` in the
   * renderer, which is exactly the duplication `understudy-no-thresholds.test.ts`
   * exists to forbid. The server owns the gate, so the server owns the sentence
   * that says why the gate is shut, and the panel stays a thing that cannot
   * disagree with it.
   */
  blocked: string[];
  /**
   * The two gates, already decided, so the panel can DRAW them.
   *
   * A class is offered when it has enough of the user's own decisions and
   * agrees with him often enough and the interval around that agreement is
   * tight enough. Showing only the total made the most informative state in the
   * feature unreadable — a class with plenty of data that is still refused
   * because it does not think like him — so the row draws a track per gate.
   *
   * Every one of these four is computed on the server for the same reason
   * `blocked` is: a track the panel filled in by comparing `n` to 80 itself
   * would be the thresholds living in two places, which is what
   * understudy-no-thresholds.test.ts exists to prevent. The panel is handed the
   * bar, told whether it was cleared, and draws exactly that.
   */
  countMet: boolean;
  /** The number of scored decisions this class needs. The bar, not a constant. */
  countBar: number;
  agreementMet: boolean;
  /**
   * What "your usual" would have scored on exactly the same rows.
   *
   * The number that decides whether any of this is worth keeping. A class where
   * somebody does the same thing nine times in ten is a class where a constant
   * scores 0.9 — and a predictor that also scores 0.9 has learned nothing about
   * the person, only that they have a setting. The GAP is the model's share.
   */
  baseRaw: number;
  baseN: number;
  /**
   * Where the agreement bar sits on a 0–100 track, for the notch. Null when the
   * class has no agreement gate to clear.
   */
  agreementBarAt: number | null;
}

/**
 * Everything the understudy view draws, in one frame.
 *
 * Pushed over the single /stream socket like every other frame here — panels
 * do not open their own sockets — and it carries the whole scorecard rather
 * than a delta, because the scorecard is thirteen rows and a diff of thirteen
 * rows costs more to reason about than it saves on the wire.
 */
export interface UnderstudyFrame {
  /** When the server computed this, epoch ms. */
  asOf: number;
  /**
   * Something stopped the understudy and it is recording nothing.
   *
   * Separate from `enabled` on purpose: `enabled` is a preference the user
   * expressed, `halted` is a fact about the process. A view that shows an empty
   * scorecard has to be able to say which of the two it is looking at.
   */
  halted: boolean;
  enabled: boolean;
  /** The ceiling no class may pass, whatever it has earned. `shadow` in v1. */
  level: UnderstudyMode;
  classes: UnderstudyClassRow[];
  /**
   * The whole scorecard as one number: agreements over scored decisions,
   * across every class, as a percentage. `null` when nothing is scored yet.
   *
   * Computed HERE and not in the panel, for the reason
   * web/test/understudy-no-thresholds.test.ts exists: a panel that divides
   * `hits` by `n` itself is a second opinion about what agreement means, and
   * the two agree right up until somebody changes which rows count. The
   * denominator is already narrower than it looks — only decisions the person
   * typed or clicked are scored at all.
   *
   * The RAW ratio, deliberately, not the interval's lower bound. The bound is
   * the gate and it belongs per class, where a promotion is decided; this is
   * the honest headline, and the feature is named after it.
   */
  agreement: number | null;
  /**
   * How many more scored decisions the nearest class needs before it could be
   * offered — the smallest remaining gap across the classes that can still
   * earn one. `null` when none can, or when they all already have.
   */
  toNextRung: number | null;
  /**
   * How the seal discipline is holding, counted over the same window.
   *
   * The seal is what makes a score mean anything: the situation is hashed and
   * written before the user can answer it, so a prediction cannot be fitted to
   * an answer already known. These four numbers are how you check that from
   * outside. `late` predictions are kept and scored — dropping them would
   * quietly select for the easy situations — and `unsealed` actuals are
   * counted precisely because they are the failure that flatters the score.
   */
  seals: {
    /** Situations sealed. */
    sealed: number;
    /** Of those, how many got a prediction at all. */
    predicted: number;
    /** Predictions that landed after the user had already answered. */
    late: number;
    /** Actuals that arrived with no seal in front of them. */
    unsealed: number;
    /*
     * WHEN each failure last happened, 0 for never — the difference between a
     * hole and a scar.
     *
     * A coverage gap poisons its counter for as long as the window is wide,
     * and until these existed nothing on the panel could tell a seam that is
     * still broken from one that was fixed hours ago. Both showed the same red
     * number, so the honest indicator became one people learn to ignore, which
     * is the worst thing a safety indicator can become.
     */
    lastUnsealed: number;
    lastLate: number;
  };
}

/*
 * The backtest: the same measurement, taken from decisions already made.
 *
 * The live scorecard needs eighty scored decisions per class, which is weeks of
 * ordinary work. A git history already holds hundreds of real ones, dated, in
 * the same categorical shape — so they are replayed oldest-first, each predicted
 * from strictly what came before it.
 *
 * It is reported BESIDE the live figure and never merged into it. The live one
 * counts what the person typed or clicked; this counts what they had already
 * done. Two populations, two claims, and averaging them would destroy both.
 */
export interface UnderstudyBacktestClass {
  cls: string;
  n: number;
  /** How often the model matched what they actually did. */
  raw: number;
  /** How often the dumbest possible rule would have matched. */
  base: number;
  /** The difference — the only part of `raw` that belongs to the model. */
  edge: number;
  declined: number;
}

export interface UnderstudyBacktest {
  at: number;
  repos: string[];
  decisions: number;
  classes: UnderstudyBacktestClass[];
}

/*
 * A drafted action, waiting on a person.
 *
 * The whole thing is written down before anybody agrees to it — the route, the
 * body that would be sent, why, and the evidence it stood on — because the
 * question this answers is not "would it have guessed my answer" but "would it
 * have done the right thing", and that cannot be answered from a percentage.
 */
export interface UnderstudyProposalEvidence {
  kind: "rule" | "precedent";
  text: string;
  from: string;
}

export interface UnderstudyProposal {
  id: number;
  cls: string;
  label: string;
  title: string;
  route: string;
  method: string;
  args: Record<string, unknown>;
  /** What it is about — the branch, the number — not what it would send. */
  subject: string;
  repo: string;
  partition: string;
  why: string;
  evidence: UnderstudyProposalEvidence[];
  confidence: number;
  createdAt: number;
  state: "pending" | "approved" | "discarded" | "done" | "failed";
  decidedAt: number | null;
  decidedBy: string;
  result: string;
}

/*
 * A shift: the understudy standing in, for a bounded while.
 *
 * The limits are fixed when the person hands over, not consulted as it goes —
 * an end time, a budget of actions, a scope. And why it stopped is recorded,
 * because the first question on coming back is "what did it do and why did it
 * quit", and a shift that cannot answer the second half is unauditable.
 */
export interface UnderstudyShift {
  id: number;
  goal: string;
  startedAt: number;
  endsAt: number;
  maxActions: number;
  actions: number;
  state: "running" | "done" | "stopped";
  stoppedAt: number | null;
  stoppedReason: string;
  scope: string;
  msLeft: number;
  actionsLeft: number;
}

/*
 * Something it did on its own, and how to put it back.
 *
 * The undo recipe is recorded at the moment of acting rather than derived when
 * somebody asks for it — a repository moves on, and a reversal worked out later
 * is a guess about a world that has changed since.
 */
export interface UnderstudyAct {
  id: number;
  shiftId: number;
  proposalId: number | null;
  cls: string;
  title: string;
  repo: string;
  at: number;
  ok: boolean;
  result: string;
  undoKind: string;
  undoArg: Record<string, unknown>;
  undoneAt: number | null;
  /** In words, for somebody reading what happened while they were out. */
  undoSays: string;
}

/*
 * One task the work loop took on, start to finish.
 *
 * DECLARED HERE rather than in the server module that writes it, because the
 * panel draws these rows and a shape copied into a second file is a shape that
 * drifts. `server/src/understudy-work.ts` imports this one.
 */
export interface UnderstudyWorkRun {
  id: number;
  shiftId: number | null;
  source: string;
  itemId: string;
  title: string;
  repo: string;
  /** The disposable checkout it worked in. A failed run leaves it on disk on
   *  purpose, so this is where somebody goes to look. */
  worktree: string;
  branch: string;
  /** What its branch pointed at the last time anything looked, so a branch that
   *  is later merged and DELETED can still be recognised as landed work rather
   *  than as a task nobody ever started. */
  tipSha?: string;
  /** The tmux pane its agent is in. The handle used to be the window's NAME,
   *  and tmux renames a window when the program inside sets a title — one
   *  failed match and a working run was declared dead. */
  paneId?: string;
  startedAt: number;
  finishedAt: number | null;
  /** `uncommitted`: the tests passed on the working tree but nothing was
   *  committed — the exact shape of a run that finished and then sat waiting
   *  for a background process instead of stopping to record what it did. The
   *  work is not lost (the worktree is kept, same as `failed`); it is just
   *  not on the branch yet.
   *  `empty`: the other half of that same failure. No commit, a clean tree
   *  (there was never anything to be uncommitted), and its own last words did
   *  not argue for that being correct — the shape of a run that stopped after
   *  "investigating" and never came back. Not `failed`: nothing went wrong.
   *  Not `done`: nothing was delivered. Kept distinct so a person sees it
   *  instead of a queue that reads it as success. */
  state: "running" | "done" | "failed" | "abandoned" | "uncommitted" | "empty";
  /** What the tests said, verdict first. Not what the agent claimed. */
  outcome: string;
}

/** Something a source is offering. Empty `repo` means nobody has said which
 *  checkout it belongs in, which is a refusal rather than a default. */
export interface UnderstudyWorkItem {
  id: string;
  source: string;
  title: string;
  detail: string;
  repo: string;
  weight: number;
  url?: string;
  /**
   * The file this task owes, when what it owes is a file rather than a commit.
   *
   * A run that writes code is judged by the tests and by whether it committed.
   * A study, a design, an audit legitimately touches nothing in the repository,
   * so both of those pass on a run that produced nothing at all — measured on
   * the task-provider design run, which sat waiting on two subagents that never
   * returned, wrote no file, and recorded itself as `done`.
   */
  deliverable?: string;
}

/** A row on the queue he fills by hand — the only source that can say which
 *  checkout the work belongs in. */
/**
 * The understudy asking a person for something.
 *
 * The measured failure this exists for is silence: of 108 runs, 26 ended having
 * delivered nothing and not one of them said what it needed. An open row is a
 * question still waiting; `tried` is what it already attempted, so an answer
 * does not have to begin by reconstructing the attempt.
 */
export interface UnderstudyHelp {
  id: number;
  runId: number | null;
  title: string;
  question: string;
  tried: string;
  repo: string;
  at: number;
  answeredAt: number | null;
}

export interface UnderstudyAsked {
  id: number;
  title: string;
  detail: string;
  repo: string;
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
  /** Somebody said something on a pull request you have a stake in. One frame
   *  per pull request per poll — the server holds the latch, exactly as it does
   *  for `ci` — and never a bot. See PrTalkNote. */
  | { type: "talk"; data: PrTalkNote }
  /** A ClickUp card of yours was assigned or moved — see CardNote. */
  | { type: "card"; data: CardNote }
  /** One of agentglass's own push alerts (a gate hold, a permission wait, a tool
   *  error) — the same thing the server would hand to notify-send. Broadcast so a
   *  connected client can raise a NATIVE OS notification, which Electron routes to
   *  the OS on macOS and Windows too, not just Linux. */
  | { type: "alert"; data: AlertNote }
  /** A UI-navigation command from POST /control, rebroadcast to every client.
   *  It changes what is *shown*, never the fleet. */
  | { type: "control"; data: ControlCmd }
  /** The understudy scorecard, recomputed and pushed whole. It reports what
   *  the understudy WOULD have done and how often that matched; it commands
   *  nothing, which is why it rides the same read-only socket. */
  | { type: "understudy"; data: UnderstudyFrame };

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
  /**
   * A reminder the user set, as opposed to news about the fleet.
   *
   * The difference is not decoration: everything else behind the bell is
   * something that HAPPENED and can be read whenever — a branch fell behind, a
   * tool failed, somebody commented. An alarm is a promise the user made to
   * themselves at a particular minute, and one that arrives as the seventeenth
   * grey row of the day has failed at the only job it had. So it is marked, and
   * the surfaces that receive it treat it as an alarm: it takes the screen, it
   * makes a sound, and it does not go away until it is answered.
   */
  /** What kind of thing this is, when it is not ordinary news. "reminder" is an
   *  alarm somebody set; "understudy" is the clone saying it is stopped and
   *  needs a person — both are raised as a card that takes the screen rather
   *  than as another row behind the bell. */
  kind?: "reminder" | "understudy";
  /** The reminder's id, so the alarm can acknowledge or snooze the exact one. */
  id?: string;
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
   * workspace with two people called Ada in it makes that difference the whole feature.
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

/**
 * A person spoke on a pull request of yours, or on one you were asked to look
 * at. Derived from the list poll rather than received: GitHub's own
 * notifications are an inbox, not an event feed you can subscribe to from a
 * desktop app, and its unread state is per notification and gone the moment you
 * glance at the page from anywhere else.
 *
 * One of these per pull request per poll, no matter how much arrived — the
 * newest remark, plus how many others came with it. A review carrying nine line
 * comments is one thing that happened, and nine pop-ups is how a notification
 * feature teaches people to turn it off.
 */
export interface PrTalkNote {
  /** `owner/name`, so the note can be clicked through to the pull request. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The newest remark. */
  who: string;
  kind: "comment" | "review";
  /** A review's verdict — the thing that was asked for by name: whether it is
   *  changes requested, an approval, or just a comment. */
  state?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  /** Line comments that came with that review. */
  lines?: number;
  at: string;
  /** Other remarks that arrived in the same poll, so one note can say so
   *  instead of five notes saying it separately. */
  more?: number;
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
  /**
   * `git log --graph`'s own ASCII art, kept only for a row git gave us with no
   * commit on it. The graph is DRAWN from `parents` now: on a repository with
   * twenty-seven branches this string is forty characters of `| | * | \ \ |`
   * that pushed the subject off the right-hand edge, which is what "everything
   * breaks" was.
   */
  graph: string;
  hash?: string;
  /** Abbreviated parent hashes, in git's order: the first is the commit this
   *  one continues, the rest are what it merged. The whole shape of the graph
   *  is in here, and the client draws lanes from it. */
  parents?: string[];
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

  /* ---- what a row needs to be read at a glance ---------------------------
   * Everything below is ADDITIVE and optional on the wire: an older companion,
   * the demo adapter and a cached shape from a previous version all keep
   * working, and anything that could not be worked out is absent rather than
   * faked. None of it adds a call to the poll — where each one comes from, and
   * what it costs, is written in server/src/dockerfacts.ts.
   * ---------------------------------------------------------------------- */

  /** `ports`, read (server/src/dockerports.ts). Absent when the column was
   *  empty or in a shape this version does not know — the raw string stays, so
   *  the worst case is exactly what the panel showed before. */
  portList?: DockerPort[];
  /** Out of the status sentence, so free. `null` means the container declares
   *  no health check at all, which is not the same as "not healthy". */
  health?: "healthy" | "unhealthy" | "starting" | null;
  /** The status without its health parenthesis: "Up 4 hours". */
  uptime?: string;
  /** From a batched `docker inspect` on a slower clock (the medium lane in
   *  server/src/docker.ts). Absent until that lane has run once. */
  restarts?: number;
  startedAt?: string | null;
  /** The last failing probe's own output — the line that says WHY something is
   *  unhealthy, which today costs a trip nobody makes. */
  healthError?: string | null;
  healthFailures?: number;
  /** The checkout the stack was brought up from, resolved against the
   *  worktrees of the open project. */
  owner?: DockerOwnerRef;
  /** Named volumes this container mounts, from the same batched inspect. */
  mounts?: { name: string; rw: boolean; destination: string }[];
}

/** One mapping out of the ports column. See server/src/dockerports.ts. */
export interface DockerPort {
  host: number | null;
  hostEnd: number | null;
  hostIp: string | null;
  container: number;
  containerEnd: number;
  proto: "tcp" | "udp";
  /** Worth offering to open in a browser. A guess that only decides whether an
   *  affordance appears, never whether the port is shown. */
  web: boolean;
}

/** The checkout a container came out of. `foreign` is the one worth a colour:
 *  it is running, it just isn't the project you have open. */
export interface DockerOwnerRef {
  worktree: string;
  branch: string | null;
  foreign: boolean;
  path: string;
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
export interface DockerVolume {
  name: string;
  driver: string;
  /* ---- additive, and each one absent rather than faked -------------------
   * The ledger half (who wrote it, which checkouts have) is free: it is a JSON
   * file agentglass keeps itself, so it rides along with the poll. The size is
   * NOT free — `docker system df -v` makes the daemon walk every layer — so it
   * arrives from /docker/disk when somebody opens the volumes section.
   * ---------------------------------------------------------------------- */
  bytes?: number | null;
  /** Containers docker says are holding it. From the same `system df -v`. */
  links?: number;
  /** The last container observed to finish writing to it, and where it came
   *  from. Absent when agentglass never saw one — which is a real answer, and
   *  usually means the volume is safe to delete. */
  lastWrite?: { worktree: string; branch: string | null; at: string; via: string } | null;
  /** Every checkout ever seen writing to it. Length > 1 is the fact that
   *  explains "why is my app serving somebody else's bundle". */
  worktrees?: string[];
}

/** One volume, asked about directly. */
export interface DockerVolumeDetail {
  name: string;
  bytes: number | null;
  mountedBy: { name: string; state: string }[];
  lastWrite: DockerVolume["lastWrite"];
  worktrees: string[];
}

/** What `docker system df` says, plus what agentglass can work out about it. */
export interface DockerDisk {
  images: number;
  containers: number;
  volumes: number;
  buildCache: number;
  reclaimable: number;
  /** Images tagged for a worktree that no longer exists on disk. Not deleted,
   *  not hidden — named, with their size, because that is the pile nobody
   *  remembers making. */
  orphans: { id: string; tag: string; bytes: number | null; worktree: string }[];
  /** Every volume's size, from the same walk. Carried here rather than fetched
   *  per volume: `system df -v` is the expensive call, and asking it once per
   *  row would be thirty of them. */
  volumes_: { name: string; bytes: number | null; links: number }[];
  at: number;
}

/** One variable, as two containers have it. A credential's value is compared
 *  on the server and never travels: `masked` says so, and `change` still tells
 *  you it differs. */
export interface DockerEnvRow {
  name: string;
  change: "only-a" | "only-b" | "changed" | "same";
  a?: string;
  b?: string;
  masked: boolean;
}

/** A look inside a volume: one read-only `ls`, capped. */
export interface DockerPeek {
  ok: boolean;
  entries?: { name: string; dir: boolean; bytes: number | null; when: string }[];
  /** The image the look was taken with, so it is obvious nothing was pulled. */
  image?: string;
  error?: string;
  /** The command to run by hand, when there is no local image to look with. */
  hint?: string;
}
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

  /**
   * How old this answer is, and whether it is still being refreshed.
   *
   * The overview is cached and the poll can queue behind a slow daemon, so
   * without these the panel shows a snapshot of unknown age as if it were live
   * — and a panel that goes quietly stale is worse than one that says
   * "reintentando", because the first one you believe. `at` is the epoch
   * millisecond the data was gathered, not the moment it was served.
   */
  at?: number;
  /** live: just gathered · stale: served from cache · retrying: the daemon did
   *  not answer in time and this is the last good answer · down: no data. */
  freshness?: "live" | "stale" | "retrying" | "down";
  /** How long the gather took, so a daemon that is merely slow can be told from
   *  one that is gone. */
  tookMs?: number;
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
/**
 * One resumable agent session, as the terminal's picker draws it.
 *
 * Read from `~/.claude/projects` — the same transcripts `/resume` lists — so
 * the picker and the CLI cannot disagree about what exists. See
 * server/src/agentsessions.ts.
 */
export interface AgentSessionRow {
  /** What `--resume` takes. */
  id: string;
  title: string;
  /** The first user message, when the title came from somewhere else. */
  opening: string;
  /** The last thing said in it. "Which one was I on" is a question about the
   *  end of a conversation, not its beginning. */
  last: string;
  /** The checkout it ran in, and where resuming it has to start. */
  cwd: string;
  /** Last write to the transcript, ms since epoch. */
  at: number;
  size: number;
  /** Where it is running right now, when it is. A session already open is not
   *  one to resume — it is one to go to. */
  openIn?: {
    /** The tmux session's NAME, for saying where; and its id, for going there.
     *  Both, because a name is what a person reads and an id is what addresses
     *  the same session on a server where names repeat. */
    session: string;
    sessionId: string;
    windowId: string;
    windowIndex: string;
    windowName: string;
    paneId: string;
  };
}

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

/**
 * One thing a PERSON said on a pull request, as the list can afford to know it.
 *
 * The conversation panel already answers "what has been said since I last
 * looked", and it answers it from the full detail — one GraphQL walk per pull
 * request, which is not something a board of twelve cards can do. So the list's
 * own second pass carries the last few remarks per pull request, timestamps and
 * authors only: enough for a card to say "two new", not enough to draw them.
 *
 * Bots are not here at all. On a live pull request the machines outnumber the
 * people two to one — the same reason the conversation has a Humans filter — and
 * a badge that lights up for a coverage report is a badge nobody reads.
 */
export interface PrTalk {
  /** ISO 8601, as GitHub gave it. */
  at: string;
  who: string;
  kind: "comment" | "review";
  /** What a review decided. Absent on a plain conversation comment. */
  state?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  /**
   * Line comments that arrived with this review.
   *
   * GitHub records a review for every batch of line comments, so a reply on one
   * line is a `COMMENTED` review with an empty body — see `reviewSpeaks`. The
   * count is how the board's number agrees with the conversation's: that panel
   * counts each line comment, so a review carrying three of them is three
   * things to read, not one.
   */
  lines?: number;
  /**
   * Whether the review itself says anything — a body, or a verdict other than
   * "commented". False for a pure batch of line comments, whose remarks are
   * counted by `lines` and would otherwise be counted twice.
   */
  says?: boolean;
  /**
   * Yours.
   *
   * Kept rather than dropped, because "since my own last word" is the mark a
   * pull request has before this browser has ever opened it — the same fallback
   * the conversation uses (`bootstrapSince`), and without your own remarks here
   * the board could not work it out.
   */
  mine?: boolean;
}

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
  /**
   * What a PERSON decided, which is not what `reviewDecision` says.
   *
   * GitHub counts any reviewer with write access, and on this machine that
   * includes the auto-review bot: a pull request nobody has read comes back
   * `reviewDecision: "APPROVED"` because `claude` approved it. The board drew
   * that as a green tick beside a card whose only human had commented —
   * reported straight away: "this one is approved by claude... by a bot... that
   * doesn't count".
   *
   * Computed server-side from the reviews the list query ALREADY fetches
   * (`SEL_TALK`), so it costs no request. Absent until the second pass lands,
   * like `reviewers` and `checks` beside it.
   */
  /** Line threads still open on this pull request, from the same request as
   *  the verdict. `more` when the count stopped at the first hundred. */
  openThreads?: { open: number; more: boolean };
  humanReview?: {
    kind: "approved" | "changes" | "awaiting" | "commented";
    /** Whose verdict it is — or, for `awaiting`, who is being waited on. */
    who: string[];
    /** When it was decided (the newest of the set), ISO. Absent for `awaiting`. */
    at?: string;
    /** The review comment itself, so a press can land on it rather than on the
     *  conversation and a hunt through forty comments. */
    url?: string;
    /**
     * Commits landed AFTER the verdict, so it no longer covers the code.
     *
     * GitHub says this on the pull request's own page ("N files have changed
     * since your review") and the board did not, so an approval of something
     * else read as a green light.
     */
    stale?: boolean;
    /** The reader is one of them — said in the second person, because your own
     *  name in the third person is a line you read twice. */
    mine?: boolean;
    /** How many people landed on the OTHER verdict. A pull request with one
     *  approval and one rejection is not "changes requested" alone. */
    others?: number;
    /** They already spoke, and were asked to look again since — GitHub's ↻.
     *  The verdict still blocks the merge exactly as GitHub shows it; this is
     *  the other half of that same screen, that a re-request already went
     *  out and the ball is with them again, not with the reader. */
    askedAgain?: boolean;
  } | null;
  /**
   * The tracker card this pull request came from, when we already know it.
   *
   * A pull request's own row said its card's ID and nothing else — not what
   * state the work is in, not how urgent it is — while the tasks view three
   * clicks away knew both. "it would be super mega ideal if the linked cards
   * carried information about their current status".
   *
   * FROM THE CACHE ONLY, and that is what makes it affordable. `boardHolding`
   * walks the saved boards this app already keeps on disk and matches on
   * `customId`; measured on a real board, eleven of fourteen pull requests
   * found their card there with no ClickUp request at all. The other three are
   * simply absent — the field is optional and a missing card draws nothing,
   * which is honest: "we have not seen it" is not "it has no status".
   *
   * A per-card lookup for the stragglers would be one request each on a list of
   * four hundred rows, which is the cost this deliberately does not pay.
   */
  card?: {
    id: string;
    customId?: string;
    title: string;
    url?: string;
    status: string;
    statusColor?: string;
    /** `done` when the card is in a closed state — for the pair that reads
     *  wrong: a finished card under a pull request still open. */
    statusKind?: "open" | "done" | "other";
    priority: "urgent" | "high" | "normal" | "low" | null;
    /**
     * Who the card is on — ClickUp's own people, not GitHub logins.
     *
     * Drawn first with `<Avatar login={...}>`, which asks GitHub for a portrait
     * of "Antonio García" and gets a blank circle back: a name on a tracker
     * board is not a username on a forge. The tracker already hands over the
     * photo, the initials and the colour it assigned each person, and the tasks
     * view has drawn them that way all along.
     */
    people?: { id?: number; name: string; initials: string; color?: string; avatar?: string; me?: boolean }[];
    /**
     * WHEN THAT BOARD WAS LAST READ, in epoch ms.
     *
     * The cache is refreshed when somebody opens the tasks view, not on a
     * timer, so a row can be hours old — and it showed a card as "in
     * development, assigned to him" while ClickUp had it in "code review" on
     * somebody else. A wrong status is not a smaller version of no status.
     *
     * Shipped rather than hidden: the reading is still useful, and the screen
     * says how old it is instead of presenting it as current.
     */
    at?: number;
  };
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
  /**
   * The last few human remarks, so a card can say how many are unread.
   *
   * Arrives on the second pass, off the same batched query as the checks.
   * `undefined` means nobody has asked yet — which is not the same fact as an
   * empty array, and a badge must not appear or disappear on the difference. See
   * PrTalk, and `carryOver`, which holds the previous answer while the fast pass
   * is on screen.
   */
  talk?: PrTalk[];
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
  /** The commit this review was written against — what "since my last review"
   *  actually means, where a timestamp is only a guess at it. */
  commit?: string;
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
/** A folder the machine search may be rooted at — see server/src/disk.ts.
 *  `places` is a menu, `roots` is the boundary; the two are not the same list. */
export interface DiskPlace { path: string; label: string }
export interface DiskPlaces { ok: boolean; home: string; roots: string[]; places: DiskPlace[]; error?: string }

/* --- browsing a place, and looking at a file ------------------------------
 * Mirrors server/src/browse.ts, which is the authority. One pair of shapes for
 * BOTH worlds the finder can see — the open checkout and the home folders —
 * because the split between them was invisible to whoever was using it. */

export type BrowseKind = "dir" | "file" | "link";

export interface BrowseEntry {
  name: string;
  kind: BrowseKind;
  /** Bytes for a file; null for a folder, which shows `items` instead. */
  bytes: number | null;
  items: number | null;
  /** Epoch millis; rendered relative on the client, where the clock is. */
  mtime: number;
  hidden: boolean;
}

export interface BrowseReport {
  ok: boolean;
  path: string;
  /** Null at the boundary, which is what stops `..` from walking out of it. */
  parent: string | null;
  entries: BrowseEntry[];
  more: number;
  /** How many entries the dotted-path rule left out — said rather than hidden. */
  hiddenSkipped: number;
  error?: string;
}

export type PreviewKind = "image" | "image-convert" | "text" | "pdf" | "video" | "audio" | "binary" | "dir";

export interface FileFacts {
  ok: boolean;
  path: string;
  name: string;
  kind: PreviewKind;
  mime: string;
  bytes: number;
  mtime: number;
  /** Read from the file's own header — no decoder, no dependency. */
  width?: number;
  height?: number;
  /** The head of a text file, so a preview needs no second call. */
  text?: string;
  textTruncated?: boolean;
  /** For an image the browser cannot draw: the tool on this machine that
   *  could convert it, or null when there is none. */
  converter?: string | null;
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
  /**
   * This pane is on the tmux server agentglass itself works on.
   *
   * A machine has several. `listPanes` walks the socket directory and answers
   * for every server somebody is attached to, so a tmux the test suite left
   * running — or another agent's — arrives beside the one you work in, and on
   * the wire the two are indistinguishable: the socket is a filesystem path
   * and the panes route strips it on purpose. Measured on a rig with two
   * servers, one real and one a test's: both sessions came back `attached:
   * true`, and both panes were `%0`, because pane ids are per SERVER.
   *
   * Names are no help either. Three servers on this machine each held a
   * session called `agentglass-understudy`.
   *
   * So the server says which is its own, and says only that — a boolean
   * carries the distinction without carrying the path. The phone drops the
   * rest; the desk ignores it, since its terminal panel is on that server by
   * construction.
   *
   * Optional because absent is a THIRD answer, the same way `attached` is: a
   * server too old to say, whose panes the phone keeps rather than hides. It
   * is also absent-meaning-unknown when this app has never attached anything
   * and has no server of its own to compare against. Hence `=== false`.
   */
  own?: boolean;
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
  /** Run in the docked console each time the app starts, without being asked.
   *  Mutually exclusive with parameters, a confirm, and anything destructive —
   *  there is nobody at boot to ask. */
  boot?: boolean;
  addedAt: number;
}

export interface RecipesResponse { recipes: Recipe[] }

/**
 * One entry in the "Review with Claude" menu: a title, the prompt behind it,
 * and optionally the skill it runs instead.
 *
 * Kept as data because a review is not one job — reviewing a colleague's change
 * for the first time, going back over one you have already reviewed, replying
 * to comments on your own — and because the wording is the whole product here.
 * The defaults live in the server's catalogue; anything the user edits is
 * stored by the same id and wins over the default, so a built-in can be
 * reworded without becoming a copy that never gets the next improvement.
 */
export interface ReviewRecipe {
  /** Stable. A built-in keeps its id when edited, which is how an edit stays
   *  an edit rather than a duplicate. */
  id: string;
  /** What the menu shows. */
  title: string;
  /** The prompt, with `{number}`, `{repo}`, `{head}`, `{branch}`, `{title}`,
   *  `{author}`, `{url}`, `{since}` and `{card}` filled in when it is used. */
  body: string;
  /**
   * A skill to run instead of — or before — the prose, written the way you
   * would type it: `/pr-resolve-reviews {number} interactive`. Placeholders
   * work here too. When set, this is the first line of what Claude receives and
   * `body` follows it, so a skill can still carry a sentence of context.
   */
  skill?: string;
  /** Which heading it sits under in the menu. */
  group: ReviewRecipeGroup;
  /** The situation it is FOR. Only ever decides what goes first — every recipe
   *  is always in the menu, because GitHub's fields describe what somebody
   *  remembered to set. */
  when: ReviewRecipeWhen;
  /** It came from the catalogue rather than from this user. */
  builtIn?: boolean;
  /** A built-in the user deleted. Kept as a tombstone, or the catalogue would
   *  hand it straight back on the next start. */
  hidden?: boolean;
  /** Sort order inside a group, ascending. Absent means "where the catalogue
   *  put it". */
  rank?: number;
}

/**
 * `telling` is the odd one and deliberately in the same catalogue: it is not a
 * prompt for reading a pull request but for saying it is ready, and it is there
 * because the thing that matters about both is identical — the wording is
 * PERSONAL, it must be editable, and it must not live in this repository. The
 * "Review with Claude" menu lists its three groups by name, so this one does
 * not appear in it; Settings lists them all, which is where it is edited.
 */
export type ReviewRecipeGroup = "reviewing" | "focused" | "mine" | "telling";

/**
 * Which day a recipe is written for:
 *   any           — always sensible, never the top suggestion on its own
 *   asked         — your review has been requested
 *   reviewed      — you have reviewed it before and it has moved since
 *   card          — it carries a tracker id
 *   mine          — you opened it
 *   mine-changes  — you opened it and the review asked for changes
 */
export type ReviewRecipeWhen = "any" | "asked" | "reviewed" | "card" | "mine" | "mine-changes";

/** What a prompt's placeholders are filled in from. */
export interface ReviewRecipeContext {
  number: number;
  repo: string;
  head: string;
  branch: string;
  title: string;
  author: string;
  url: string;
  /** The commit your last review was written against, when you have one. */
  since?: string | null;
  /** The tracker id in the branch or title, when there is one. */
  card?: string | null;
  /** That card's address, when the tracker is one we can link to. `{card}` is
   *  the name people say; this is the thing you click, and a message asking for
   *  a review carries both. */
  cardUrl?: string | null;
  /** Who the message is for, by name — the person on the card, not a login.
   *  Empty when nobody is on it, which is a message addressed to a channel
   *  rather than to somebody. */
  who?: string | null;
  /** Anything typed into the box beside the button, verbatim: what to look at
   *  first, why it is urgent, a caveat. Empty most of the time. */
  note?: string | null;
}

export interface ReviewRecipesResponse {
  ok: boolean;
  recipes?: ReviewRecipe[];
  error?: string;
}

/**
 * One row of GitHub's notification inbox.
 *
 * Read through `gh api /notifications` — see server/src/ghinbox.ts. The id is
 * the THREAD's, which is what every write takes and is not the pull request's
 * number; `number` is the pull request or issue this is about, absent for a
 * subject that has none (a release, a check suite).
 */
export interface InboxItem {
  id: string;
  unread: boolean;
  /** GitHub's own word: mention, review_requested, author, subscribed… */
  reason: string;
  /** PullRequest, Issue, Release, Discussion, CheckSuite. */
  type: string;
  repo: string;
  title: string;
  at: number;
  number?: number;
}

/**
 * A plugin as the reviewer sees it. Mirrors server/src/plugins.ts'
 * `PublicPlugin` — the running/pid pair is live process state, never
 * persisted, so a restart with nothing running is the honest default rather
 * than a stale "on".
 */
/** Where a plugin came from — mirrors `InstallSource` in
 *  server/src/plugin-sources.ts. A marketplace install carries both the
 *  catalogue it was found in and the plugin entry inside it. */
export type InstallSource =
  | { kind: "local-path"; path: string }
  | { kind: "git"; url: string; ref: string | null }
  | {
      kind: "marketplace";
      marketplace: { url: string; ref: string | null; resolvedCommit: string | null };
      plugin: { url: string; ref: string | null };
    };

export interface PublicPlugin {
  name: string;
  publisher: string;
  description: string;
  entrypoint: string;
  scope: DeviceScope;
  source: InstallSource;
  installDir: string;
  manifestHash: string;
  /** Hash of everything under `installDir` except `.git`. */
  contentHash: string;
  /** Folds the declared capability set and `contentHash` together — what
   *  `enablePlugin` actually gates on. See `consentFingerprint`. */
  fingerprint: string;
  /** The commit a git/marketplace source resolved to, or `null` for a
   *  local-path install. */
  resolvedCommit: string | null;
  /** The hash reviewed when a human last enabled this, or `null` if it has
   *  never been reviewed. Differs from `manifestHash` exactly when the
   *  install on disk asks for something the last approval did not cover. */
  approvedHash: string | null;
  approvedFingerprint: string | null;
  enabled: boolean;
  installedAt: number;
  /** Has a human ever approved a version of this plugin, whether or not that
   *  approval still holds. Distinguishes "never reviewed" from "an update
   *  asked for something different since it was approved". */
  hadApproval: boolean;
  running: boolean;
  pid: number | null;
}

export interface PluginsStatus {
  master: boolean;
  plugins: PublicPlugin[];
}

/** One entry in somebody else's catalogue. Mirrors `CataloguePlugin` in
 *  server/src/plugin-catalogue.ts. */
export interface CataloguePlugin {
  id: string;
  source: { kind: "git"; url: string; ref: string | null };
  description: string;
  categories: string[];
}

/** A fetched catalogue document. Mirrors `Catalogue` in
 *  server/src/plugin-catalogue.ts — fetched fresh every browse, never cached
 *  as something to trust between reads. */
export interface Catalogue {
  name: string;
  owner: string;
  plugins: CataloguePlugin[];
}

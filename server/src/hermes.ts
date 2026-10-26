// Hermes — the CLI's argv for a worker run, and the check that a resume cannot
// move the turn or bring Bypass back.
//
// `hermes chat -q … --format stream-json` is Hermes's equivalent of `claude -p
// --output-format stream-json`; follow-ups go through `--resume <id>`. This
// module does not write ~/.hermes/config.yaml, open a pane, or touch ACP.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

/**
 * The Hermes home a turn will use. Read-only — this module never writes in it.
 *
 * `AGENTGLASS_HERMES_HOME`, else `HERMES_HOME`, else `~/.hermes`; and then the
 * sticky profile, the way `hermes` itself resolves it at startup: a root (not
 * already a `profiles/<name>` dir) whose `active_profile` names another profile
 * means that profile's directory. The spawn pins the child's HERMES_HOME to
 * this value, so the state.db the resume check reads is the one Hermes opens.
 *
 * Which `active_profile` is read follows hermes_constants.get_default_hermes_root:
 * a home anywhere under `~/.hermes` takes the sticky profile of `~/.hermes`
 * itself, not its own; a home elsewhere takes its own.
 * Exported for tests.
 */
export function hermesHome(env: Record<string, string | undefined> = process.env): string {
  const native = join(env.HOME || homedir(), ".hermes");
  const root = env.AGENTGLASS_HERMES_HOME?.trim() || env.HERMES_HOME?.trim() || native;
  if (basename(dirname(root)) === "profiles") return root;
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const r = real(root), n = real(native);
  const base = r === n || r.startsWith(n + sep) ? native : root;
  try {
    const name = readFileSync(join(base, "active_profile"), "utf8").replace(/^\uFEFF/, "").trim();
    if (name && name !== "default" && /^[A-Za-z0-9_.-]{1,64}$/.test(name) && !name.startsWith(".")) {
      return join(base, "profiles", name);
    }
  } catch { /* no sticky profile */ }
  return root;
}

/**
 * Why a resume must not run as asked, or null when it may.
 *
 * Read in Hermes upstream at e0550c97bbd916cd5ff8fa0450e6291c31921b94
 * (hermes_cli/cli_agent_setup_mixin.py, `_load_resumed_history_late` →
 * `_restore_session_state`): `hermes chat -q … --resume <id>` restores two things from
 * the session's row in `<HERMES_HOME>/state.db`, whatever this turn asked for.
 *
 *  - The directory. `_restore_session_cwd` chdirs to the row's `cwd`, and
 *    `--no-restore-cwd` does not stop it — that flag only guards an earlier
 *    chdir in hermes_cli/main.py. A session id names a row; nothing ties it to
 *    the directory this server just checked, so a resume could run the turn
 *    in a repo outside the open project.
 *  - Bypass. A `--yolo` launch or a `/yolo` toggle stores `yolo_mode: true` in
 *    the row's `model_config`, and `_restore_session_yolo` turns it back on, so
 *    a chat switched back from Bypass would go on running everything.
 *
 * So the row is read first, with the compression continuations Hermes follows
 * to (`parent_session_id`), and the turn is refused when any of them recorded
 * another directory, or Bypass while this turn is not Bypass. A row it cannot
 * read is a refusal too: the check exists because the answer matters.
 *
 * `yolo_mode` is read the way Hermes reads it, `bool(...)` in Python, so `1`,
 * `"true"` and even `"false"` are Bypass too; and a row whose `cwd` is not an
 * absolute path is refused, because Hermes resolves it against the spawn
 * directory and this check could not see the same place.
 *
 * Ceiling: this checks the rows. Two settings in Hermes's own config.yaml also
 * decide what runs, and both are the operator's and are not overridden here:
 * `approvals.mode: off` is Bypass for every turn, and
 * `approvals.single_query_mode: approve` makes a default single-query turn run
 * the flagged commands it would otherwise refuse. Exported for tests.
 */
/** Python's `bool(v)` for a value that came out of `json.loads`. */
const pyTruthy = (v: unknown): boolean =>
  !(v == null || v === false || v === 0 || v === ""
    || (Array.isArray(v) ? !v.length : typeof v === "object" && !Object.keys(v as object).length));

export function hermesResumeRefusal(
  id: string, dir: string, mode: "default" | "yolo", dbPath = join(hermesHome(), "state.db"),
): string | null {
  type Row = { id: string; cwd: string | null; model_config: string | null };
  let rows: Row[];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      rows = db.query(`
        WITH RECURSIVE chain(id) AS (
          SELECT id FROM sessions WHERE id = ?1
          UNION SELECT s.id FROM sessions s JOIN chain c ON s.parent_session_id = c.id
        )
        SELECT s.id, s.cwd, s.model_config FROM sessions s JOIN chain c ON s.id = c.id
      `).all(id) as Row[];
    } finally { db.close(); }
  } catch {
    return "cannot read Hermes's session store to confirm where this session would resume — start a new chat";
  }
  if (!rows.length) return "Hermes has no session with that id — start a new chat";
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const here = real(dir);
  for (const r of rows) {
    const cwd = (r.cwd ?? "").trim();
    if (cwd && (!isAbsolute(cwd) || !here || real(cwd) !== here)) {
      return "this Hermes session belongs to another directory, and resuming it would move the turn there — start a new chat here";
    }
    let yolo = false;
    // A config this side cannot parse counts as Bypass: Python's json also
    // reads NaN and Infinity, which JSON.parse refuses, so "unparseable here"
    // is not "off there" — the same fail-closed rule as an unreadable store.
    try { yolo = pyTruthy((JSON.parse(r.model_config || "{}") as { yolo_mode?: unknown })?.yolo_mode); } catch { yolo = true; }
    if (yolo && mode !== "yolo") {
      return "this Hermes session ran in Bypass, and Hermes turns that back on when it resumes — keep Bypass or start a new chat";
    }
  }
  return null;
}

// --- putting a chat on the radar --------------------------------------------

// --- driving a turn ---------------------------------------------------------

/**
 * The command line for one turn.
 *
 * Exported for tests, because the mode / resume / model mapping is the part
 * worth pinning: a regression here is silent rather than loud.
 *
 * The prompt goes in argv as one `--query=<text>` element, never shell-split
 * and never a separate element: argparse reads a separate value that starts
 * with `-` as the next flag, so a prompt like "-m evil" would have stopped
 * being the prompt.
 * The working directory is set on the spawn rather than with `--in`.
 */
export function hermesArgs(bin: string, model: string, resumeId: string, mode: "default" | "yolo", message: string): string[] {
  // `--no-restore-cwd` stops the chdir hermes_cli/main.py makes before the
  // agent starts. It is not enough on its own: the resume path restores the
  // row's cwd again later, which is why hermesStream checks the row first —
  // see hermesResumeRefusal.
  const args = [bin, "chat", `--query=${message}`, "--format", "stream-json", "--no-restore-cwd"];
  if (model) args.push("-m", model);
  if (resumeId) args.push("--resume", resumeId);
  if (mode === "yolo") args.push("--yolo");
  return args;
}


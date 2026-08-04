// One answer to "what am I still missing?".
//
// The probes themselves are not new: git, docker, gh, tmux and the notification
// bus each had a capability endpoint already, because each panel needs its own
// answer to render. What did not exist was the sum of them, and the three that
// nothing ever reported at all: python3, setsid and `script`. Those three are
// the ones that fail quietly, which is exactly why they belong on a list. A
// missing python3 leaves the hooks installed and dead (nothing streams, nothing
// says why) and drops the terminal into a mode where full-screen programs do
// not render; a missing setsid leaves stray processes behind a closed shell.
//
// Read-only throughout: this route probes and reports, it never installs.
import { DEPS, usedOn, type DepReport, type DepSpec, type DepStatus, type DepsResponse } from "../../shared/deps.ts";
import { gitCapability } from "./git.ts";
import { dockerCapability } from "./docker.ts";
import { ghCapability } from "./prs.ts";
import { tmuxCapability } from "./tmuxpane.ts";
import { notifyCapability } from "./notifications.ts";
import { HAS_NVIM } from "./editor.ts";
import { taskCapability } from "./tasks.ts";
import { PTY_BACKEND } from "./terminal.ts";

/** The interpreter the hook forwarder is written against, resolved the way
 *  hooksetup.ts resolves it: python3 everywhere but Windows, where python3 is
 *  usually absent and `py`/`python` is what exists. */
function pythonBin(): string | null {
  const order = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  for (const c of order) { const p = Bun.which(c); if (p) return p; }
  return null;
}

/** A plain PATH lookup, for the tools whose only question is "is it there". */
const found = (bin: string): boolean => !!Bun.which(bin);

const ok = (detail?: string) => ({ status: "ok" as DepStatus, detail });
const missing = (detail?: string) => ({ status: "missing" as DepStatus, detail });
const attention = (detail: string) => ({ status: "attention" as DepStatus, detail });

/**
 * Probe one tool.
 *
 * Everything that already has a capability function uses it rather than a
 * second `Bun.which`, so this list can never disagree with the panel it is
 * describing. The subprocess-backed ones (docker, gh) cache inside their own
 * modules, so asking here costs at most what the panel would have cost.
 */
async function probe(spec: DepSpec): Promise<{ status: DepStatus; detail?: string }> {
  switch (spec.id) {
    case "git": {
      const c = gitCapability();
      return c.available ? ok(c.version) : missing(c.reason);
    }
    case "claude":
      return found("claude") ? ok() : missing("not on PATH");
    case "python": {
      const py = pythonBin();
      if (!py) return missing("no python3 on PATH: hooks cannot forward events, and the terminal has no pseudo-terminal");
      // Present, but the terminal may still be degraded: the bridge needs a
      // python that can import `pty`, and the backend was resolved at boot.
      return PTY_BACKEND === "pty"
        ? ok(py)
        : attention(`${py} is on PATH, but the terminal is running in ${PTY_BACKEND} mode`);
    }
    case "tmux": {
      const c = tmuxCapability();
      return c.available ? ok() : missing(c.reason);
    }
    case "gh": {
      const c = await ghCapability();
      if (!c.available) return missing(c.reason);
      return c.authed ? ok(c.login ? `logged in as ${c.login}` : undefined) : attention(c.reason || "not logged in yet");
    }
    case "docker": {
      const c = await dockerCapability();
      if (!c.available) return missing(c.reason);
      return c.version ? ok(c.version) : attention(c.reason || "the daemon is not responding");
    }
    case "nvim":
      return HAS_NVIM ? ok() : missing("not on PATH");
    case "task": {
      // Reuses the panel's own probe rather than running `task` again here:
      // one answer, one cache, and no second place for the wording to drift.
      // The `configured` half is the whole reason this case exists — an
      // installed Taskwarrior that has never been set up is not a missing
      // install, it is one question away from working, and it hangs rather
      // than fails if anything ever pipes it a stdin. Same shape as gh's
      // "installed but not logged in".
      const c = await taskCapability();
      if (!c.available) return missing(c.reason || "not on PATH");
      return c.configured
        ? ok(c.version)
        : attention(c.reason || "installed, but its data store has not been created yet — run `task` once and answer its setup question");
    }
    case "dbus-monitor": {
      const c = notifyCapability();
      // `supported` folds two causes together, and only one of them is an
      // install: no session bus is a headless box, not a missing package.
      if (c.supported) return ok();
      return found("dbus-monitor") ? attention(c.reason || "no session bus") : missing(c.reason);
    }
    case "opener":
      // Only Linux has anything to install here; the other two ship an opener.
      return found("xdg-open") ? ok() : missing("no xdg-open on PATH");
    case "script":
      // Wanted only as the fallback, so a machine with python3 is not lacking
      // anything by not having it.
      return found("script") ? ok() : PTY_BACKEND === "pty" ? ok("not needed: python3 is backing the terminal") : missing("not on PATH");
    default:
      return found(spec.bin) ? ok() : missing("not on PATH");
  }
}

// Probing costs a handful of PATH lookups plus, at worst, two cached
// subprocess answers. Cheap, but the pane can be opened and closed repeatedly
// and nothing here changes between two clicks: a binary does not appear
// mid-session. Long enough to make reopening free, short enough that "install
// it, then press Recheck" tells the truth.
const TTL_MS = 10_000;
let cache: { at: number; res: DepsResponse } | null = null;

export async function dependencyReport(force = false): Promise<DepsResponse> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.res;
  const platform = process.platform;
  const deps: DepReport[] = await Promise.all(
    DEPS.map(async (spec): Promise<DepReport> => {
      if (!usedOn(spec, platform)) {
        return { ...spec, status: "unsupported", detail: `not used on ${platform}` };
      }
      const r = await probe(spec);
      return { ...spec, ...r };
    }),
  );
  const res: DepsResponse = { platform, deps };
  cache = { at: Date.now(), res };
  return res;
}

/** Cleared by the tests, which install their own fake PATH entries. */
export function resetDependencyCache(): void { cache = null; }

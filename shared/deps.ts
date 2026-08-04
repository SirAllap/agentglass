// The outside tools agentglass shells out to, in one place.
//
// Every panel that needs a binary already probes for it and says so on its own
// (git, docker, gh, tmux). What nobody could answer was the whole question:
// "what am I still missing for this app to work end to end?" That answer needs
// a list, and a list needs a single source, or the wording drifts between the
// six places that already tell part of the story.
//
// GENERIC ON PURPOSE. There is one macOS, one Windows and an unbounded number
// of Linux distributions, so a package-manager line is wrong for most readers
// and stale for the rest. Each entry names the tool, says what stops working
// without it, and links the project's own page. How the reader installs
// software on their machine is theirs to know, not ours to guess.

/** Platforms a tool is used on at all. Anywhere else the row reads "not used
 *  here" rather than "missing", because a mac with no `pkexec` is not broken. */
export type DepPlatform = "linux" | "darwin" | "win32";

export type DepId =
  | "git" | "claude" | "python" | "tmux" | "gh" | "docker" | "nvim" | "task"
  | "setsid" | "script" | "ss" | "dbus-monitor" | "notify-send" | "opener" | "pkexec" | "bash";

export interface DepSpec {
  id: DepId;
  /** The command as it has to appear on PATH. Shown as-is, so it is also the
   *  string a reader searches for. */
  bin: string;
  /** Sentence case, the way it is written on screen. */
  title: string;
  /** What stops working without it. Written as a consequence, not a category:
   *  "the terminal cannot open" beats "terminal support". */
  what: string;
  /** Required means the app is visibly broken without it. Optional means one
   *  feature stands down and the rest carries on. */
  required: boolean;
  /** The project's own page. Never a package-manager command. */
  url: string;
  /** Absent means every platform. */
  platforms?: DepPlatform[];
  /** One extra thing a reader cannot infer from the name, when there is one. */
  note?: string;
}

/** The catalog. Order is the reading order: the things that break the app
 *  first, then what each feature wants, then the small POSIX pieces. */
export const DEPS: DepSpec[] = [
  {
    id: "git", bin: "git", title: "Git", required: true,
    what: "Source control, file changes, pull requests and worktrees all shell out to it, and the terminal uses it to decide where to open.",
    url: "https://git-scm.com/downloads",
  },
  {
    id: "claude", bin: "claude", title: "Claude Code CLI", required: true,
    what: "The chat panel runs it: every turn, the tmux pane engine, Review with Claude, and the walkthrough.",
    url: "https://docs.claude.com/en/docs/claude-code/setup",
    note: "agentglass reads Claude Code's own transcripts either way, so sessions still show up without it. Only chatting from the app needs the CLI.",
  },
  {
    id: "python", bin: "python3", title: "Python 3", required: true,
    what: "Two separate jobs: it runs the hook forwarder that streams sessions here live, and it backs the terminal's pseudo-terminal.",
    url: "https://www.python.org/downloads/",
    note: "Without it the hooks stay written but fail on every event, so nothing arrives live and nothing says why. The terminal keeps opening, in a degraded mode where full-screen programs do not render. On Windows the hooks use `py` or `python`.",
  },
  {
    id: "tmux", bin: "tmux", title: "tmux", required: false,
    what: "Runs each chat as a live pane you can attach to from your own terminal, shows your tmux windows as tabs in the terminal panel, and takes the app's theme.",
    url: "https://github.com/tmux/tmux/wiki/Installing",
    platforms: ["linux", "darwin"],
    note: "Without it chats still run, one process per turn, which is slower to start but costs nothing while idle.",
  },
  {
    id: "gh", bin: "gh", title: "GitHub CLI", required: false,
    what: "Everything in the pull requests panel: the list, the diff, reviews, checks and merges.",
    url: "https://cli.github.com",
    note: "Installing it is half the job. It also has to be logged in before the panel can read anything.",
  },
  {
    id: "docker", bin: "docker", title: "Docker", required: false,
    what: "The containers, images, volumes and logs panel.",
    url: "https://docs.docker.com/get-started/get-docker/",
    note: "The CLI on its own is not enough: the daemon has to be running for the panel to show anything.",
  },
  {
    id: "task", bin: "task", title: "Taskwarrior", required: false,
    what: "The half of the Tasks view that is yours: the local list you add to, edit and tick off. GitHub issues are read over the network and arrive either way.",
    url: "https://taskwarrior.org/download/",
    note: "Its absence is the quiet kind — the view opens, the issues load, and the list you were expecting is simply not there. Which is why it is on this page.",
  },
  {
    id: "nvim", bin: "nvim", title: "Neovim", required: false,
    what: "Sends a file straight to a running editor from the diff and file panels, and keeps it on the app's theme.",
    url: "https://neovim.io",
    note: "With any other $EDITOR the app hands you the command to paste instead.",
  },
  {
    id: "setsid", bin: "setsid", title: "setsid (util-linux)", required: false,
    what: "Gives every shell and chat its own process group, so closing one takes its children with it.",
    url: "https://github.com/util-linux/util-linux",
    // Used wherever it is found, not only on Linux: the terminal prepends it
    // whenever `Bun.which` turns one up. macOS simply does not ship one, which
    // is why a Mac shows this row as absent rather than as not applicable.
    platforms: ["linux", "darwin"],
    note: "Without it a closed terminal or chat can leave background processes behind. macOS does not ship it.",
  },
  {
    id: "script", bin: "script", title: "script (util-linux)", required: false,
    what: "The terminal's fallback pseudo-terminal, used when Python 3 is absent.",
    url: "https://github.com/util-linux/util-linux",
    platforms: ["linux"],
  },
  {
    id: "ss", bin: "ss", title: "ss (iproute2)", required: false,
    what: "The Ports panel: what is listening on this machine, and which checkout it belongs to.",
    url: "https://github.com/iproute2/iproute2",
    platforms: ["linux"],
    note: "Ships with iproute2 and is present on almost every Linux, which is why its absence is confusing rather than obvious: the panel simply lists nothing.",
  },
  {
    id: "dbus-monitor", bin: "dbus-monitor", title: "D-Bus tools", required: false,
    what: "Mirrors your desktop notifications onto the notch, so Slack and the rest stay visible in fullscreen.",
    url: "https://www.freedesktop.org/wiki/Software/dbus/",
    platforms: ["linux"],
    note: "It also needs a session bus, which a headless box or an SSH session does not have.",
  },
  {
    id: "notify-send", bin: "notify-send", title: "notify-send (libnotify)", required: false,
    what: "Raises a desktop alert when an agent needs you and no agentglass window is open to show it.",
    url: "https://gitlab.gnome.org/GNOME/libnotify",
    platforms: ["linux"],
  },
  {
    id: "opener", bin: "xdg-open", title: "Desktop opener", required: false,
    what: "Opens the link behind a mirrored notification in your browser.",
    url: "https://www.freedesktop.org/wiki/Software/xdg-utils/",
    platforms: ["linux"],
    note: "macOS and Windows use their built-in openers, so there is nothing to install there.",
  },
  {
    id: "pkexec", bin: "pkexec", title: "polkit", required: false,
    what: "Hands a worktree back to you when its files ended up owned by another user, for example after a container wrote into it.",
    url: "https://gitlab.freedesktop.org/polkit/polkit",
    platforms: ["linux"],
  },
  {
    id: "bash", bin: "bash", title: "Bash", required: false,
    what: "The shell the terminal falls back to when $SHELL is not set, and what the self-update script runs under.",
    url: "https://www.gnu.org/software/bash/",
    platforms: ["linux", "darwin"],
  },
];

export const depSpec = (id: DepId): DepSpec | undefined => DEPS.find((d) => d.id === id);

// --- what the server found (the wire shape) ---------------------------------
//
// These live here rather than in types.ts because they are the answer to this
// catalog, and types.ts is kept dependency-free: it could not name a DepId
// without importing this file.

/** Four states, because "not here" is three different problems on screen.
 *
 *  `ok`          usable right now.
 *  `attention`   installed, but not usable yet: gh with no login, a docker CLI
 *                with no daemon behind it. The fix is not another install.
 *  `missing`     not on PATH.
 *  `unsupported` not used on this platform, so there is nothing to do. */
export type DepStatus = "ok" | "attention" | "missing" | "unsupported";

export interface DepReport extends DepSpec {
  status: DepStatus;
  /** A version when we have one cheaply, otherwise why it is not usable.
   *  Written for a reader, and it is the server's words, not a code. */
  detail?: string;
}

export interface DepsResponse {
  /** `process.platform`, so the UI can say "on Linux" without guessing from
   *  the browser, which may not be the machine the server runs on. */
  platform: string;
  deps: DepReport[];
}

/** Whether a tool is used on this platform at all. */
export function usedOn(spec: DepSpec, platform: string): boolean {
  return !spec.platforms || (spec.platforms as string[]).includes(platform);
}

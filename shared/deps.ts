// The outside tools agentglass shells out to, in one place.
//
// Every panel that needs a binary already probes for it and says so on its own
// (git, docker, gh, tmux). What nobody could answer was the whole question:
// "what am I still missing for this app to work end to end?" That answer needs
// a list, and a list needs a single source, or the wording drifts between the
// six places that already tell part of the story.
//
// It USED to say: generic on purpose, no package-manager lines, "how the reader
// installs software is theirs to know, not ours to guess". That reasoning was
// sound and the conclusion was wrong, so it is worth saying why it changed
// rather than quietly deleting it.
//
// The objection was that a guess is wrong for most readers and stale for the
// rest. True — and it only matters if the guess RUNS. What the panel does now
// is type the command into a real terminal and stop: the prompt is yours, the
// Enter is yours, and a wrong guess costs one keystroke to correct instead of
// installing the wrong thing. At that point a command that is right most of the
// time beats a link that is right always and helps nobody who is missing a
// package at 1am. It also means `sudo` is typed by the person who owns the
// machine, into their own shell, rather than asked for by an app.
//
// Two rules keep the guess honest:
//   * `pkg` is per manager and OPTIONAL. Where there is no one-line answer —
//     Docker, the Claude CLI — there is no entry, and the reader gets the
//     project's page exactly as before. A fabricated apt line for Docker would
//     install the wrong daemon from the wrong repository.
//   * Names nobody is sure of are left out rather than approximated. A missing
//     row costs a search; a wrong one costs a package.

/** Platforms a tool is used on at all. Anywhere else the row reads "not used
 *  here" rather than "missing", because a mac with no `pkexec` is not broken. */
export type DepPlatform = "linux" | "darwin" | "win32";

export type DepId =
  | "git" | "claude" | "python" | "tmux" | "gh" | "glab" | "docker" | "nvim" | "task"
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
  /**
   * What this tool is called to each package manager, where a plain install is
   * an honest answer.
   *
   * Absent on purpose for anything whose install is a repository, a script or a
   * runtime of its own — see the note at the top of this file. Partial on
   * purpose too: a manager missing from the record is one whose package name
   * nobody here was sure of, and the reader gets the project's page for it.
   */
  pkg?: Partial<Record<PkgManager, string>>;
  /**
   * The project's own one-line install, for tools no package manager owns.
   *
   * `pkg` covers everything a distribution packages. This covers the rest —
   * and "the rest" includes a REQUIRED tool, which is the whole reason it
   * exists: the Claude CLI is not in anybody's repositories, so the page could
   * name the one dependency most likely to be missing and then offer nothing
   * but a link. Taken verbatim from the project's own documentation, never
   * invented, and used only when `pkg` has no answer for this machine.
   */
  installer?: string;
}

/** The package managers worth detecting. Ordered by how much they are the
 *  machine's own: a Linux box with both apt and brew is an apt box that also
 *  has brew, and `sudo apt-get` is what its docs, its forums and its other
 *  packages assume. */
export type PkgManager = "apt" | "dnf" | "pacman" | "zypper" | "apk" | "brew";

/** How each one is asked to install something. `sudo` is part of the string
 *  rather than something the app arranges: it is typed into the user's own
 *  shell, where their password belongs. brew refuses to run under sudo. */
export const PKG_INSTALL: Record<PkgManager, (pkg: string) => string> = {
  apt: (p) => `sudo apt-get install -y ${p}`,
  dnf: (p) => `sudo dnf install -y ${p}`,
  pacman: (p) => `sudo pacman -S --needed ${p}`,
  zypper: (p) => `sudo zypper install -y ${p}`,
  apk: (p) => `sudo apk add ${p}`,
  brew: (p) => `brew install ${p}`,
};

/**
 * Does this line fetch something off the internet and run it?
 *
 * Derived rather than declared, so a future entry cannot forget to say so. The
 * console shows every command before running it, but "read this first" carries
 * more weight for a script nobody can read until it has already been fetched
 * than it does for `apt-get install`, and the two deserve different words.
 */
export const isRemoteScript = (cmd: string): boolean =>
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(cmd);

/** The catalog. Order is the reading order: the things that break the app
 *  first, then what each feature wants, then the small POSIX pieces. */
export const DEPS: DepSpec[] = [
  {
    id: "git", bin: "git", title: "Git", required: true,
    what: "Source control, file changes, pull requests and worktrees all shell out to it, and the terminal uses it to decide where to open.",
    url: "https://git-scm.com/downloads",
    pkg: { apt: "git", dnf: "git", pacman: "git", zypper: "git", apk: "git", brew: "git" },
  },
  {
    id: "claude", bin: "claude", title: "Claude Code CLI", required: true,
    what: "The chat panel runs it: every turn, the tmux pane engine, Review with Claude, and the walkthrough.",
    // Moved host: the old docs.claude.com path 301s here. A link that redirects
    // still works and still rots — this one was found pointing at the old host
    // while reading the page for the install line below.
    url: "https://code.claude.com/docs/en/setup",
    note: "agentglass reads Claude Code's own transcripts either way, so sessions still show up without it. Only chatting from the app needs the CLI.",
    // The native installer, which is what the setup page presents as the
    // recommended method on macOS, Linux and WSL. Not a package: there are
    // signed apt/dnf/apk repositories, but each is a key plus a repository plus
    // an install — three commands and a fingerprint to check, which is a
    // documentation link's job, not a button's.
    installer: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  {
    id: "python", bin: "python3", title: "Python 3", required: true,
    what: "Two separate jobs: it runs the hook forwarder that streams sessions here live, and it backs the terminal's pseudo-terminal.",
    url: "https://www.python.org/downloads/",
    note: "Without it the hooks stay written but fail on every event, so nothing arrives live and nothing says why. The terminal keeps opening, in a degraded mode where full-screen programs do not render. On Windows the hooks use `py` or `python`.",
    pkg: { apt: "python3", dnf: "python3", pacman: "python", zypper: "python3", apk: "python3", brew: "python" },
  },
  {
    id: "tmux", bin: "tmux", title: "tmux", required: false,
    what: "Runs each chat as a live pane you can attach to from your own terminal, shows your tmux windows as tabs in the terminal panel, and takes the app's theme.",
    url: "https://github.com/tmux/tmux/wiki/Installing",
    platforms: ["linux", "darwin"],
    note: "Without it chats still run, one process per turn, which is slower to start but costs nothing while idle.",
    pkg: { apt: "tmux", dnf: "tmux", pacman: "tmux", zypper: "tmux", apk: "tmux", brew: "tmux" },
  },
  {
    id: "gh", bin: "gh", title: "GitHub CLI", required: false,
    what: "Everything in the pull requests panel: the list, the diff, reviews, checks and merges.",
    url: "https://cli.github.com",
    note: "Installing it is half the job. It also has to be logged in before the panel can read anything.",
    pkg: { apt: "gh", dnf: "gh", pacman: "github-cli", zypper: "gh", apk: "github-cli", brew: "gh" },
  },
  {
    id: "glab", bin: "glab", title: "GitLab CLI", required: false,
    what: "Reads merge requests and pipelines from GitLab, the way `gh` does for GitHub.",
    url: "https://gitlab.com/gitlab-org/cli",
    note: "Only worth installing if you have a GitLab remote. Like `gh`, it has to be logged in — `glab auth login` — before anything can be read.",
    pkg: { apt: "glab", dnf: "glab", pacman: "glab", zypper: "glab", apk: "glab", brew: "glab" },
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
    pkg: { apt: "taskwarrior", dnf: "task", pacman: "task", apk: "taskwarrior", brew: "task" },
  },
  {
    id: "nvim", bin: "nvim", title: "Neovim", required: false,
    what: "Sends a file straight to a running editor from the diff and file panels, and keeps it on the app's theme.",
    url: "https://neovim.io",
    note: "With any other $EDITOR the app hands you the command to paste instead.",
    pkg: { apt: "neovim", dnf: "neovim", pacman: "neovim", zypper: "neovim", apk: "neovim", brew: "neovim" },
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
    pkg: { apt: "util-linux", dnf: "util-linux", pacman: "util-linux", zypper: "util-linux", apk: "util-linux" },
  },
  {
    id: "script", bin: "script", title: "script (util-linux)", required: false,
    what: "The terminal's fallback pseudo-terminal, used when Python 3 is absent.",
    url: "https://github.com/util-linux/util-linux",
    platforms: ["linux"],
    pkg: { apt: "bsdutils", dnf: "util-linux", pacman: "util-linux", zypper: "util-linux", apk: "util-linux" },
  },
  {
    id: "ss", bin: "ss", title: "ss (iproute2)", required: false,
    what: "The Ports panel: what is listening on this machine, and which checkout it belongs to.",
    url: "https://github.com/iproute2/iproute2",
    platforms: ["linux"],
    note: "Ships with iproute2 and is present on almost every Linux, which is why its absence is confusing rather than obvious: the panel simply lists nothing.",
    pkg: { apt: "iproute2", dnf: "iproute", pacman: "iproute2", zypper: "iproute2", apk: "iproute2" },
  },
  {
    id: "dbus-monitor", bin: "dbus-monitor", title: "D-Bus tools", required: false,
    what: "Mirrors your desktop notifications onto the notch, so Slack and the rest stay visible in fullscreen.",
    url: "https://www.freedesktop.org/wiki/Software/dbus/",
    platforms: ["linux"],
    note: "It also needs a session bus, which a headless box or an SSH session does not have.",
    pkg: { apt: "dbus", pacman: "dbus", zypper: "dbus-1" },
  },
  {
    id: "notify-send", bin: "notify-send", title: "notify-send (libnotify)", required: false,
    what: "Raises a desktop alert when an agent needs you and no agentglass window is open to show it.",
    url: "https://gitlab.gnome.org/GNOME/libnotify",
    platforms: ["linux"],
    pkg: { apt: "libnotify-bin", dnf: "libnotify", pacman: "libnotify", zypper: "libnotify-tools", apk: "libnotify" },
  },
  {
    id: "opener", bin: "xdg-open", title: "Desktop opener", required: false,
    what: "Opens the link behind a mirrored notification in your browser.",
    url: "https://www.freedesktop.org/wiki/Software/xdg-utils/",
    platforms: ["linux"],
    note: "macOS and Windows use their built-in openers, so there is nothing to install there.",
    pkg: { apt: "xdg-utils", dnf: "xdg-utils", pacman: "xdg-utils", zypper: "xdg-utils", apk: "xdg-utils" },
  },
  {
    id: "pkexec", bin: "pkexec", title: "polkit", required: false,
    what: "Hands a worktree back to you when its files ended up owned by another user, for example after a container wrote into it.",
    url: "https://gitlab.freedesktop.org/polkit/polkit",
    platforms: ["linux"],
    pkg: { apt: "policykit-1", dnf: "polkit", pacman: "polkit", zypper: "polkit" },
  },
  {
    id: "bash", bin: "bash", title: "Bash", required: false,
    what: "The shell the terminal falls back to when $SHELL is not set, and what the self-update script runs under.",
    url: "https://www.gnu.org/software/bash/",
    platforms: ["linux", "darwin"],
    pkg: { apt: "bash", dnf: "bash", pacman: "bash", zypper: "bash", apk: "bash", brew: "bash" },
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
  /**
   * The line to type, already resolved for THIS machine's package manager.
   *
   * Resolved on the server because only the server knows what is installed
   * where it runs — the browser may not even be on that machine. Absent when
   * the tool has no one-line install, or when no manager was recognised, and
   * the panel falls back to the project's page.
   */
  install?: string;
}

export interface DepsResponse {
  /** `process.platform`, so the UI can say "on Linux" without guessing from
   *  the browser, which may not be the machine the server runs on. */
  platform: string;
  /** Which package manager the install lines were written for, so the panel can
   *  name it. A reader who sees `apt-get` on a machine where they use brew
   *  needs to know we chose, not that we were confused. */
  manager?: PkgManager;
  deps: DepReport[];
}

/** Whether a tool is used on this platform at all. */
export function usedOn(spec: DepSpec, platform: string): boolean {
  return !spec.platforms || (spec.platforms as string[]).includes(platform);
}

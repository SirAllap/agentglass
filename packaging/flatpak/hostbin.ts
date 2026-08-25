// The shims that let a sandboxed agentglass reach the tools it supervises.
//
// agentglass drives things that live on the user's machine: `claude`, `git`,
// `docker`, `gh`. Inside a Flatpak none of them exist, so `Bun.which` comes back
// empty and the deps panel reports a machine with nothing installed on it. Each
// shim written here is a two-line script on /app/hostbin that hands the call to
// the host through the Flatpak portal.
//
// The list is DERIVED from shared/deps.ts rather than typed out. That is the
// whole reason this file is code instead of a directory of checked-in scripts:
// a hand-written list is wrong the moment a fourth agent CLI lands in DEPS, and
// wrong in the way nobody notices, because the symptom is one row of a panel
// saying "not on PATH" — exactly what it says for a tool you genuinely have not
// installed. Deriving it means the two cannot disagree.
//
// Run on the runner, before flatpak-builder: the build sandbox has no bun.
//   bun packaging/flatpak/hostbin.ts <outdir>
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPS, type DepId } from "../../shared/deps.ts";

/**
 * Tools that must keep running INSIDE the sandbox, and why each one.
 *
 * This is not a performance list, it is a correctness list — shimming any of
 * these to the host breaks the feature it belongs to.
 *
 *  python   backs the terminal's pseudo-terminal, and a PTY is only useful to
 *           the process that holds the master fd. Sent to the host it would
 *           allocate a terminal nothing here can read.
 *  setsid   puts the in-sandbox child in its own process group. It has to be on
 *           this side of the boundary to have anything to act on.
 *  script   the PTY fallback when python is missing. Same reasoning as python.
 *  tmux     already shipped by scripts/build-tmux-static.sh, and the pane engine
 *           runs its own — the user's tmux was never involved.
 *  opener   xdg-open in the runtime is portal-backed, which is the correct way
 *           out of a sandbox and better than the host's.
 *  bash     the runtime's own is what in-sandbox scripts run under. The user's
 *           login shell is a separate question, answered by `hostshell` below.
 */
const IN_SANDBOX: ReadonlySet<DepId> = new Set<DepId>(["python", "setsid", "script", "tmux", "opener", "bash"]);

/**
 * Names DEPS does not carry but the code still reaches for.
 *
 * `whisper` because the whisper row is declared as `whisper-cli` and its note
 * says either that or OpenAI's `whisper` will do — a shim for the row's `bin`
 * alone would satisfy half the sentence.
 */
const EXTRA = ["whisper"];

/** `exec`, not a call: the shim must not sit in the process tree holding a pipe
 *  open, or a caller waiting on EOF waits on the shim instead of the tool. */
const shim = (bin: string) => `#!/bin/sh\nexec flatpak-spawn --host ${bin} "$@"\n`;

/**
 * The user's real login shell, indirected through a variable.
 *
 * Flatpak overwrites $SHELL with /bin/sh, so the app cannot simply read it —
 * measured, not assumed, and it is why this file exists at all rather than the
 * terminal just working. The launcher looks the real one up over the portal and
 * leaves it here. The fallback is not decoration: without it a failed lookup
 * would exec the empty string and the terminal would fail with nothing to
 * report.
 */
const HOSTSHELL = `#!/bin/sh\nexec flatpak-spawn --host "\${AGENTGLASS_HOST_SHELL:-/bin/sh}" "$@"\n`;

const out = process.argv[2];
if (!out) {
  console.error("usage: bun packaging/flatpak/hostbin.ts <outdir>");
  process.exit(2);
}

mkdirSync(out, { recursive: true });

const bins = [...DEPS.filter((d) => !IN_SANDBOX.has(d.id)).map((d) => d.bin), ...EXTRA].sort();
for (const bin of bins) {
  const path = join(out, bin);
  writeFileSync(path, shim(bin));
  chmodSync(path, 0o755);
}

const hostshell = join(out, "hostshell");
writeFileSync(hostshell, HOSTSHELL);
chmodSync(hostshell, 0o755);

console.log(`${bins.length + 1} shims -> ${out}`);
console.log(bins.join(" "));

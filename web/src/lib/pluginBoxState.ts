/*
 * What the box card says, decided from a plugin's box-related fields alone —
 * pulled out of PluginDeclaration.tsx so the wording is a pure function of
 * every state a box can be in, testable without a renderer.
 */
import type { PublicPlugin } from "../../../shared/types.ts";
import type { BoxPlan } from "../../../shared/pluginBoxPlan.ts";

export type BoxWording =
  | { tone: "boxed"; text: string; refused?: { path: string; why: string }[] }
  | { tone: "warning"; text: string; fix?: string; willNotStart?: true }
  | { tone: "neutral"; text: string };

/** The one-time fix for Ubuntu's AppArmor limit on unprivileged user
 *  namespaces, which blocks bwrap outright until a profile allows it. Shown
 *  as a copyable block rather than prose: it is a command, and a paraphrase
 *  of a command is something to mistype. */
export const USERNS_FIX = `sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor`;

type UnboxedReason = "missing" | "userns-blocked" | "failed";

/** Why the host cannot build the box, and the one-time fix where there is one. */
function whyNoBox(reason: UnboxedReason, detail: string | undefined): { cause: string; fix?: string; todo?: string } {
  switch (reason) {
    case "userns-blocked":
      return { cause: "This system blocks the box (Ubuntu's AppArmor limit on user namespaces)", fix: USERNS_FIX };
    case "missing":
      return { cause: "bubblewrap is not installed", todo: "Install the `bubblewrap` package and restart the plugin." };
    case "failed":
      return { cause: `The box failed to start: ${detail ?? "no detail"}` };
  }
}

/** What a start does is not the same claim at every moment, and "runs as you"
 *  is only true of two of them. Linux with no box and no consent REFUSES the
 *  start (server/src/plugins.ts); consent, or `AGENTGLASS_PLUGINS_UNBOXED=1`,
 *  lets it run unboxed; anywhere but Linux there is no box to build and it
 *  runs unboxed by design. `plan` is the server's own answer (shared/
 *  pluginBoxPlan.ts), because the probe alone says "missing" on macOS and
 *  Windows, where nothing is wrong and nothing can be fixed. */
const NO_BOX_HERE = "Boxes are built on Linux only, so on this system the plugin runs as you.";

function unboxedWording(
  reason: UnboxedReason, detail: string | undefined, plan: BoxPlan | undefined, running: boolean,
): { text: string; fix?: string; willNotStart?: true } {
  if (plan === "unboxed-platform") return { text: NO_BOX_HERE };
  const { cause, fix, todo } = whyNoBox(reason, detail);
  if (running) return { text: `${cause}, so the plugin runs as you.${todo ? ` ${todo}` : ""}`, ...(fix ? { fix } : {}) };
  // Anything but a recorded consent is a refused start: no plan at all is
  // read the way Linux's default is, never as a promise that it runs.
  if (plan !== "unboxed-consented") {
    return { text: `${cause}, so the plugin will not start until you allow it to run unboxed or fix the host.${todo ? ` ${todo}` : ""}`, ...(fix ? { fix } : {}), willNotStart: true };
  }
  return { text: `${cause}. It was allowed to run unboxed, so the plugin runs as you.${todo ? ` ${todo}` : ""}`, ...(fix ? { fix } : {}) };
}

/**
 * Two moments this has to speak to, and they are not the same claim:
 *
 *  - RUNNING: `boxState` says what actually happened for the process on
 *    screen right now.
 *  - NOT RUNNING: nothing has happened yet, but `sandboxProbe` still knows
 *    whether THIS HOST can build a box at all — so a system that blocks bwrap
 *    says so before the person ever switches the plugin on, not only after.
 *    `lastBoxFailure` covers the narrower case the probe cannot see: the host
 *    can build boxes in general, but THIS plugin's own box died in its first
 *    instant last time (a bad grant, a missing dependency inside it).
 */
export function boxWording(
  plugin: Pick<PublicPlugin, "sandbox" | "running" | "boxState" | "sandboxProbe" | "boxPlan" | "lastBoxFailure">,
): BoxWording | null {
  if (!plugin.sandbox) return null;

  if (plugin.running && plugin.boxState) {
    const s = plugin.boxState;
    if (s.kind === "boxed") {
      return {
        tone: "boxed",
        text: "Runs in a box: the system's own folders are read-only, and it can otherwise reach only its own installed folder, its data folder, any program folders it needs, and the paths listed below.",
        ...(s.refused && s.refused.length > 0 ? { refused: s.refused } : {}),
      };
    }
    // "no-block" is not reachable here: `plugin.sandbox` is set (checked
    // above), and `startProcess` only ever gives that reason when it isn't.
    if (s.reason === "no-block") return { tone: "neutral", text: "Will run in a box when started." };
    return { tone: "warning", ...unboxedWording(s.reason, s.detail, plugin.boxPlan, true) };
  }

  // Not running: the probe is what THIS HOST can do, checked before a start
  // is ever attempted — worth a red warning now, not only after the person
  // has already switched the plugin on and watched it run unboxed.
  if (plugin.sandboxProbe && !plugin.sandboxProbe.ok) {
    return { tone: "warning", ...unboxedWording(plugin.sandboxProbe.reason, plugin.sandboxProbe.detail, plugin.boxPlan, false) };
  }
  if (plugin.lastBoxFailure) {
    return { tone: "warning", text: `The box failed to start last time, so the plugin did not start: ${plugin.lastBoxFailure}` };
  }
  return { tone: "neutral", text: "Will run in a box when started." };
}

/**
 * Which sentence the "What it runs" block opens with. `neutral` is "will run
 * in a box when started" — the state of every declared plugin until it is
 * switched on — so it takes the boxed sentence: the block above it promises a
 * box, and "runs as you" right beside that promise was two answers to one
 * question. Only no box block at all, or a box that is known not to be
 * there, gets the process warning.
 */
export function processIsBoxed(box: BoxWording | null): boolean {
  return box?.tone === "boxed" || box?.tone === "neutral";
}

/** The box card says the plugin will not start: the process block must not
 *  say it "runs as you" in the same breath. */
export function processWillNotStart(box: BoxWording | null): boolean {
  return box?.tone === "warning" && box.willNotStart === true;
}

/** The red line for a plugin that runs outside its box while another holds a
 *  key: a same-user process reads the key file. Generic, any plugin, any key. */
export function neighbourKeyWording(plugin: Pick<PublicPlugin, "name" | "canReadKeysOf">): string | null {
  const holders = plugin.canReadKeysOf;
  if (!holders?.length) return null;
  return `${plugin.name} runs outside its box and can read ${holders.join(", ")}'s key.`;
}

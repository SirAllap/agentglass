/*
 * What the box card says, decided from a plugin's box-related fields alone —
 * pulled out of PluginDeclaration.tsx so the wording is a pure function of
 * every state a box can be in, testable without a renderer.
 */
import type { PublicPlugin } from "../../../shared/types.ts";

export type BoxWording =
  | { tone: "boxed"; text: string; refused?: { path: string; why: string }[] }
  | { tone: "warning"; text: string; fix?: string }
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

/** The red text for a specific reason the box did not (or could not) build —
 *  shared between "it just failed while running" and "the host can never
 *  build one, before a start was even tried" (see `boxWording` below). */
function unboxedWording(reason: UnboxedReason, detail: string | undefined): { text: string; fix?: string } {
  switch (reason) {
    case "userns-blocked":
      return { text: "This system blocks the box (Ubuntu's AppArmor limit on user namespaces), so the plugin runs as you.", fix: USERNS_FIX };
    case "missing":
      return { text: "bubblewrap is not installed, so the plugin runs as you. Install the `bubblewrap` package and restart the plugin." };
    case "failed":
      return { text: `The box failed to start, so the plugin runs as you: ${detail ?? "no detail"}` };
  }
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
  plugin: Pick<PublicPlugin, "sandbox" | "running" | "boxState" | "sandboxProbe" | "lastBoxFailure">,
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
    return { tone: "warning", ...unboxedWording(s.reason, s.detail) };
  }

  // Not running: the probe is what THIS HOST can do, checked before a start
  // is ever attempted — worth a red warning now, not only after the person
  // has already switched the plugin on and watched it run unboxed.
  if (plugin.sandboxProbe && !plugin.sandboxProbe.ok) {
    return { tone: "warning", ...unboxedWording(plugin.sandboxProbe.reason, plugin.sandboxProbe.detail) };
  }
  if (plugin.lastBoxFailure) {
    return { tone: "warning", text: `The box failed to start last time, so the plugin ran as you: ${plugin.lastBoxFailure}` };
  }
  return { tone: "neutral", text: "Will run in a box when started." };
}

/** The red line for a plugin that runs outside its box while another holds a
 *  key: a same-user process reads the key file. Generic, any plugin, any key. */
export function neighbourKeyWording(plugin: Pick<PublicPlugin, "name" | "canReadKeysOf">): string | null {
  const holders = plugin.canReadKeysOf;
  if (!holders?.length) return null;
  return `${plugin.name} runs outside its box and can read ${holders.join(", ")}'s key.`;
}

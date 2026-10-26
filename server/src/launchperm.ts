/**
 * THE permission flags of every terminal agentglass opens with an agent in it.
 *
 * One place, because there were five: the review window started Claude with no
 * mode at all, the resume picker wrote `--dangerously-skip-permissions` inline,
 * a hand-off passed a boolean, and none of them carried a deny list. A tab that
 * starts in another mode than the person's other agents holds every message
 * sent to it until somebody answers a prompt in it by hand.
 *
 * Every spawn site resolves a `LaunchPerm` here and hands it to `agentArgv`
 * (agentticket.ts) or `launchFlags`; server/test/launch-helper-guard.test.ts
 * fails when one does not.
 *
 * Not here, on purpose: the unattended one-shots (headless.ts, the
 * understudy, the judge), whose modes are part of what they are.
 */
import { agentKind } from "../../shared/agentKinds.ts";
import { isLaunchMode, type LaunchMode } from "../../shared/launchModes.ts";
import { launchDeny, launchMode } from "./config.ts";

export interface LaunchPerm { mode: LaunchMode; deny: string[] }

/**
 * The mode one launch starts in: an override that names a real mode (a prompt's
 * own setting, a one-off "Run with…"), else the old `yolo` boolean, else the
 * global setting. The deny list is always the global one: an item can loosen
 * how often it is asked, never what it may not do.
 */
export function launchPerm(override?: unknown, yolo?: boolean): LaunchPerm {
  const mode = isLaunchMode(override) ? override : yolo === true ? "bypassPermissions" : launchMode();
  return { mode, deny: launchDeny() };
}

/**
 * The flags, for one CLI.
 *
 * Claude Code: `--disallowedTools '<rules>' --permission-mode <mode>`, the shape
 * of a hand-started worker. The deny list goes FIRST and as one element:
 * `--disallowedTools` is variadic, and whatever follows it up to the next flag
 * is read as more tools — a prompt placed after it would be denied rather than
 * asked. `--permission-mode` after it closes the list.
 *
 * Any other CLI has neither flag. Bypass becomes its own skip flag where the
 * table has one; every other mode is that CLI's default, and the deny list is
 * not passed, because there is nothing to pass it to.
 */
export function launchFlags(kindId: string, perm: LaunchPerm): string[] {
  if (kindId === "claude") {
    return [...(perm.deny.length ? ["--disallowedTools", perm.deny.join(" ")] : []), "--permission-mode", perm.mode];
  }
  const flag = agentKind(kindId)?.yoloFlag;
  return perm.mode === "bypassPermissions" && flag ? [flag] : [];
}

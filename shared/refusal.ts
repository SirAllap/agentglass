/**
 * Every refusal a worker meets names the layer that made it, the rule, and the
 * one place to change it. One builder, so the sentence has one shape.
 *
 * Layers, outermost first:
 *   floor    what the seat must not run either (sudo, another checkout's gitdir)
 *   rule     the project's agent rules, checked before every tool call
 *   envelope the flags a worker was started with (commit, network, docker, worktree ops)
 *   sandbox  Claude Code's own sandbox (writes, sockets, the network)
 *   flow     the Flow role's own `allow`
 */
export type RefusalLayer = "floor" | "rule" | "envelope" | "sandbox" | "flow";

export const REFUSAL_WHERE: Readonly<Record<RefusalLayer, string>> = {
  floor: "nowhere: the seat is refused it too",
  rule: "`agentglass-ui rules` (Settings ▸ Agents ▸ Rules)",
  envelope: "the worker's start flags (--allow commit|network|docker) within the ceiling in Settings ▸ Orchestration",
  sandbox: "Settings ▸ Orchestration (Worker Unix sockets; network and docker flags drop the sandbox, which also drops the wall around the app's token)",
  flow: "Flow ▸ the role ▸ Extra commands this role may run",
};

export function refusal(layer: RefusalLayer, rule: string, what?: string): string {
  return `${what ? `${what}: ` : ""}refused by the ${layer} layer, rule: ${rule}. Change it at: ${REFUSAL_WHERE[layer]}.`;
}

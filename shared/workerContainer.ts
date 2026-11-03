/*
 * A WORKER'S CONTAINER NAME IS NAMESPACED, and the namespace is the isolation.
 *
 * The relay used to send a worker's own name as the container to mint, and the
 * panel resolves a wanted name against the profiles that already exist before
 * it mints one. So a worker called `work` beside a person's profile called
 * `work` got a tab in THAT container — the person's logins, and possibly the
 * tab the person was using — and the reply said `profile: "work"`, which was
 * the confirmation the registry trusted. The name was the whole check.
 *
 * A reserved prefix fixes it at the root instead of adding a second opinion
 * about names: the person-side cannot create a name that starts with it, and
 * the panel mints a reserved name fresh rather than resolving it to anything
 * that already exists. Two containers can then never share a name by accident.
 */
export const AGENT_CONTAINER_PREFIX = "agent:";

/** The key a worker or agent name is compared under. ONE fold: a credential's
 *  name reaches the relay, the lane table and the page registry in whatever
 *  case the person typed it, and `Alba` and `alba` are one worker. Never a cap:
 *  a container name is stored, not a path, and `NAME_RE` already bounds it. */
export function foldWorkerName(name: string): string {
  return name.trim().toLowerCase();
}

/** The container a worker's mints go to. */
export function agentContainerName(worker: string): string {
  return AGENT_CONTAINER_PREFIX + foldWorkerName(worker);
}

/** Whether a container name is in the reserved namespace. */
export function isAgentContainer(name: unknown): boolean {
  return typeof name === "string" && foldWorkerName(name).startsWith(AGENT_CONTAINER_PREFIX);
}

/** The identity a container belongs to: an agent's own name for a namespaced
 *  container, the name itself otherwise. Ownership is compared against this,
 *  never against the display name — `agent:work` is the container `work` acts
 *  in, and comparing the two strings raw refused the agent its own tab. */
export function containerOwner(name: string): string {
  return isAgentContainer(name)
    ? foldWorkerName(name).slice(AGENT_CONTAINER_PREFIX.length)
    : name.trim();
}

/*
 * "Analyze with agent": the prompt a cleanup agent starts from, and when the
 * button may be pressed.
 *
 * The agent starts where the Disk view stops: it gets the same figures
 * (`diskMath`), so its first plan can not disagree with the screen, and then it
 * reads what Docker cannot tell it (checkouts, compose files, branch ages).
 * Its rules are in the prompt, not only in the agent rules: a destructive
 * docker verb is "ask" by default there, but a prompt that says so keeps even a
 * permissive setup from removing a database.
 *
 * Lists are capped (LIST_MAX): a hundred dangling images are one sentence, the
 * agent can list them itself with a read-only command.
 */
import type { DockerContainer, DockerDisk, DockerImage, DockerVolume } from "../../../shared/types.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import { isNodeModulesVolume } from "../../../shared/dockerVolume.ts";
import { BUILD_CACHE_BUDGET, diskMath } from "./dockerDisk.ts";
import { KINDS, kindOf, needsYou, READ_ONLY_REASON } from "./dockerState.ts";
import type { Situation } from "./dockerView.ts";

const LIST_MAX = 12;

export interface AnalyzeSnapshot {
  project: string;
  workspace: string;
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: number;
  /** Null until the first `system df` answered. */
  disk: DockerDisk | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const listed = (items: string[]) => items.slice(0, LIST_MAX).join(", ") + (items.length > LIST_MAX ? `, and ${items.length - LIST_MAX} more` : "");

/** The figures the Disk view shows, as lines. */
function diskLines(s: AnalyzeSnapshot): string[] {
  const d = s.disk;
  if (!d) return ["Disk: not measured yet. Start with `docker system df -v`."];
  const m = diskMath(d, s.images);
  const sized = d.volumes_.map((v) => ({ ...v, nm: isNodeModulesVolume(v.name) }));
  const nm = sized.filter((v) => v.nm);
  const data = sized.filter((v) => !v.nm);
  const sum = (vs: typeof sized) => vs.reduce((n, v) => n + (v.bytes ?? 0), 0);
  return [
    `Disk: ${humanSize(m.total)} in total. Images ${humanSize(d.images)}, containers ${humanSize(d.containers)}, volumes ${humanSize(d.volumes)}, build cache ${humanSize(d.buildCache)}.`,
    `Can come back, by the Disk view's own count: ${humanSize(m.back)}.`,
    m.orphanCount > 0
      ? `- ${plural(m.orphanCount, "image")} whose worktree is gone (${humanSize(m.orphanBytes)}): ${listed(d.orphans.map((o) => `${o.tag} (${o.worktree})`))}`
      : "- No image whose worktree is gone.",
    `- ${plural(m.danglingCount, "dangling image")} (${humanSize(m.danglingBytes)}).`,
    `- Build cache: ${humanSize(d.buildCache)}, budget ${humanSize(BUILD_CACHE_BUDGET)}, ${m.underBudget ? "under the budget" : `${humanSize(m.cacheOver)} over`}.`,
    `- node_modules volumes: ${nm.length} (${humanSize(sum(nm))}). A rebuild is a cold install per worktree.`,
    `- Data volumes: ${data.length} (${humanSize(sum(data))})${data.length ? `: ${listed(data.map((v) => `${v.name} ${humanSize(v.bytes)}`))}` : ""}. These hold data.`,
  ];
}

export function analyzePrompt(s: AnalyzeSnapshot): string {
  const trouble = s.containers.filter(needsYou);
  const lines = [
    "You are helping me clean up Docker on this machine and get disk space back without losing anything I need.",
    "",
    `Project: ${s.project} (${s.workspace})`,
    `Counts: ${plural(s.containers.length, "container")}, ${plural(s.images.length, "image")}, ${plural(s.volumes.length, "volume")}, ${plural(s.networks, "network")}.`,
    ...diskLines(s),
    trouble.length
      ? `Containers that need attention: ${listed(trouble.map((c) => `${c.service || c.name} (${KINDS[kindOf(c)].word})`))}.`
      : "No container needs attention.",
    "",
    "How to work:",
    "1. READ-ONLY first. Run `docker system df -v`, `docker ps -a`, `docker images`, `docker volume ls`, `docker network ls`, `git worktree list`, and read the compose files in the checkouts and the branch ages. Change nothing in this step.",
    "2. Then write a short plan in three groups: safe to remove, look first, keep. For each item give the reason and the GB it frees.",
    "3. Ask me before EVERY removal, and run removals one at a time. Never batch them.",
    "4. NEVER remove a data volume unless I type its name. NEVER run `docker system prune --volumes`.",
    "5. For each thing you propose removing, explain what a rebuild would cost (time, network, a cold install) so I can weigh it.",
  ];
  return lines.join("\n");
}

/** Why the button is off, or "" when it may be pressed. */
export function analyzeGate(o: { readOnly: boolean; situation: Situation }): { disabled: boolean; reason: string } {
  if (o.situation === "notinstalled") return { disabled: true, reason: "Docker is not installed here" };
  if (o.situation === "down") return { disabled: true, reason: "Docker is not running" };
  if (o.readOnly) return { disabled: true, reason: READ_ONLY_REASON };
  return { disabled: false, reason: "" };
}

/** The tooltip: which agent will run. Null while the setting has not loaded. */
export const analyzeTitle = (agent: string | null): string =>
  agent
    ? `Opens a new tab where ${agent} reads this Docker setup and proposes a cleanup. It asks before every removal.`
    : "Opens a new tab with the agent set in Settings, Worker roles (builder), to propose a cleanup. It asks before every removal.";

/*
 * The on/off switch on each row of the Tasks "Sources" sheet (mock 11).
 *
 * The switch is not a new setting. The desk already keeps one per source,
 * `tasks.source.<id>` (web/src/lib/settingsRegistry.ts), and the settings door
 * reads and writes it for any caller; the phone asks the same door the
 * "Alerts on this phone" switch does (notifications/phoneAlertsPref.ts). So a
 * row here and the desk's Tasks page are the same switch.
 *
 * The phone's source ids are not the desk's: GitHub issues is `github`,
 * Taskwarrior is `local`, and the tracker row is named by its provider. A
 * tracker the desk has no switch for has no switch here either.
 */
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import type { TaskSource } from "./taskProviders.ts";

/** The desk's setting id for a source, or null when the desk has no switch. */
export function sourceSettingId(source: TaskSource): string | null {
  if (source.id === "issues") return "tasks.source.github";
  if (source.id === "jira") return "tasks.source.jira";
  if (source.provider === "clickup") return "tasks.source.clickup";
  if (source.provider === "taskwarrior") return "tasks.source.local";
  return null;
}

/** The ids of the sources still switched on. A source the desk has no switch
 *  for, or one not read yet, counts as on. The selector offers these only. */
export function sourcesOn(sources: TaskSource[], on: Record<string, boolean>): string[] {
  return sources.filter((s) => on[sourceSettingId(s) ?? ""] !== false).map((s) => s.id);
}

/** Whether the computer shows this source; null when it could not be asked. */
export async function readSourceOn(host: Host, id: string): Promise<boolean | null> {
  const answer = await ask<{ ok: boolean; value?: unknown }>(host, `/settings/door?id=${encodeURIComponent(id)}`);
  return answer.ok && typeof answer.value.value === "boolean" ? answer.value.value : null;
}

export async function setSourceOn(host: Host, id: string, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const answer = await ask<{ ok: boolean; error?: string }>(host, "/settings/door", { method: "POST", body: { id, value: on } });
  if (!answer.ok) return { ok: false, error: answer.error };
  return answer.value.ok === false ? { ok: false, error: answer.value.error ?? "The computer would not change it." } : { ok: true };
}

/**
 * A read that started before a flip must not undo it: the read can return
 * after the write landed with the value from before. Each key counts its flips;
 * a read is applied only if the count is the one it started with.
 */
export function switchReads() {
  const flips = new Map<string, number>();
  let epoch = 0;
  const count = (id: string): number => flips.get(id) ?? 0;
  return {
    /** Call when a read of `id` starts; call the result with the value when it returns. */
    begin(id: string): (on: boolean | null) => boolean | null {
      const at = count(id);
      const was = epoch;
      return (on) => (on !== null && count(id) === at && epoch === was ? on : null);
    },
    /** Call when the person flips `id` (and again if the write is put back). */
    flipped(id: string): void { flips.set(id, count(id) + 1); },
    /** Another computer: nothing in flight may land. */
    reset(): void { flips.clear(); epoch++; },
  };
}

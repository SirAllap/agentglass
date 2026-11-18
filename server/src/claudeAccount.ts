/*
 * Which Claude Code account a project's agents use.
 *
 * An account is a Claude Code config directory: the CLI keeps its login in
 * there, and `CLAUDE_CONFIG_DIR` picks which one a run uses. A project may name
 * one (`workers.claudeConfigDir`); with none named, the CLI's own default
 * stands.
 *
 * Only the PATH is handled here. Nothing in this file opens, lists or copies
 * anything inside that directory, so no credential is ever read: the CLI is the
 * only thing that looks in it.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { APP, getSetting, storedValues } from "./preflightStore.ts";

/** An empty value clears the choice. Otherwise: an absolute path with no control characters and no `..` step, which is a directory or does not exist yet (a new account the CLI will sign in to). */
export function checkAccountDir(raw: unknown): { value: string } | { error: string } {
  if (typeof raw !== "string") return { error: "a folder path, or empty" };
  const v = raw.trim();
  if (v === "") return { value: "" };
  if (/[\0-\x1f\x7f]/.test(v) || !isAbsolute(v)) return { error: "an absolute folder path, or empty" };
  if (v.split("/").includes("..")) return { error: "a folder path without .. in it" };
  try {
    if (!statSync(v).isDirectory()) return { error: "that path is a file, not a folder" };
  } catch { /* not there yet: the CLI creates it at its first sign-in */ }
  return { value: v };
}

/** The config directory this project's Claude agents start with, or null for the CLI's own default. Read again at every start: a hand-edited bad value is ignored, never passed on. */
export function claudeAccountDir(root?: string | null): string | null {
  const v = checkAccountDir(getSetting(root || APP, "workers.claudeConfigDir"));
  return "value" in v && v.value ? v.value : null;
}

/** Every account folder any project names and that passes the check, for the transcript sweep. */
export function claudeAccountDirs(): string[] {
  return storedValues("workers.claudeConfigDir").filter((v) => "value" in checkAccountDir(v));
}

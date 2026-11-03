// The reflog switch, shared by the server (which runs it) and the dock (which
// names it). Git records where HEAD has been only while this setting is on.
export const reflogEnableArgv = (): string[] => ["config", "core.logAllRefUpdates", "true"];

/** True only when `git config --get core.logAllRefUpdates` printed `false`.
 *  Unset prints nothing and means git's default, so it is not off. */
export const reflogOff = (configOutput: string): boolean => configOutput.trim().toLowerCase() === "false";

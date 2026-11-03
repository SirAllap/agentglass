/*
 * The kernel's parent-death signal, proved before it is used.
 *
 * A child spawned by this server should not outlive it, and the child ledger
 * cannot help when the server is SIGKILLed (nothing runs) or when the run's
 * state directory is deleted with the run. `setpriv --pdeathsig` makes the
 * kernel send a signal when the parent dies, whatever the parent was doing.
 *
 * setpriv is util-linux, and `--pdeathsig` only arrived in 2.33; busybox's
 * applet has no such option. Proved once on a `true`, refusal included, so a
 * machine without the option does not run a blocking setpriv on every monitor
 * restart. A refused option is an empty prefix and the caller spawns the tool
 * bare. The child ledger is then the only cover, and it does not survive a
 * state dir deleted with the run.
 */
let proved: string[] | null = null;

export function deathTie(): string[] {
  if (proved !== null) return proved;
  const setpriv = Bun.which("setpriv");
  const tie = setpriv ? [setpriv, "--pdeathsig", "TERM", "--"] : [];
  let ok = false;
  try { ok = !!setpriv && Bun.spawnSync([...tie, "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { /* not runnable */ }
  proved = ok ? tie : [];
  return proved;
}

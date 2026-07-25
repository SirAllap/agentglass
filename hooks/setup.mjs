import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function runSetup(undo, spawn = spawnSync) {
  const commands = [
    ["install_hooks.py", ...(undo ? ["--uninstall"] : [])],
    ["connect_opencode.py", ...(undo ? ["--undo"] : [])],
  ];

  let status = 0;
  for (const args of commands) {
    const result = spawn(process.execPath, ["hooks/run_py.mjs", ...args], {
      stdio: "inherit",
      shell: false,
    });
    if ((result.error || result.status !== 0) && status === 0) {
      status = result.status ?? 1;
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runSetup(process.argv.includes("--undo")));
}

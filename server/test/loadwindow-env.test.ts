import { describe, expect, test } from "bun:test";
import { runScript, shellEnv } from "../../scripts/loadwindow.ts";

describe("loadwindow run.sh environment", () => {
  test("a secret in the shell never lands in the written script; what the shell needs does", () => {
    const env = shellEnv(
      { FAKE_SECRET_TOKEN: "abc", ANTHROPIC_API_KEY: "sk-fake", PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000", LC_ALL: "C", AGENTGLASS_PORT: "9999", ELECTRON_RUN_AS_NODE: "1" },
      { AGENTGLASS_PORT: "4321", XDG_CONFIG_HOME: "/p/electron/config" },
    );
    const sh = runScript(env, "/p/electron.pid", "/bin/electron", ["/r/electron"]);
    expect(sh).not.toContain("FAKE_SECRET_TOKEN");
    expect(sh).not.toContain("abc");
    expect(sh).not.toContain("ANTHROPIC_API_KEY");
    expect(sh).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(sh).not.toContain("9999");
    for (const line of ["export PATH='/usr/bin'", "export WAYLAND_DISPLAY='wayland-1'", "export XDG_RUNTIME_DIR='/run/user/1000'", "export LC_ALL='C'", "export AGENTGLASS_PORT='4321'", "export XDG_CONFIG_HOME='/p/electron/config'"]) expect(sh).toContain(line);
  });
});

/*
 * The environment and config of every git a plugin install runs. A leaf
 * module: plugins.ts imports plugin-sources.ts, so anything both need lives
 * here, not in either.
 */

/**
 * Names that are not secrets and without which git cannot reach a host at
 * all: where the proxy is, which certificates to trust, and on Windows the
 * folders the runtime looks for. The proxy URL may carry a login, and it goes
 * to the proxy, which is the one place it was always meant for.
 */
const GIT_PASSTHROUGH = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "SystemRoot", "USERPROFILE", "TEMP", "TMP",
];

/**
 * The environment of every git a plugin install runs. It asks nobody for a
 * password: the server is not somebody at a terminal, and a repository that
 * answered 401 left an install waiting on a prompt in whatever terminal the
 * server was started from. And it fetches nothing through Git LFS, where the
 * user has it: a plugin's own .lfsconfig names the LFS host, so installing a
 * plugin made this machine talk to a server the plugin chose. A plugin that
 * keeps files in LFS installs with the pointers, which is also what the
 * catalogue's runner hashes.
 *
 * `from` is the server's own environment; a test hands in a copy rather than
 * setting a proxy on process.env, because Bun 1.3.14 keeps sending https
 * through an HTTPS_PROXY after it is deleted from process.env.
 */
export const pluginGitEnv = (from: Record<string, string | undefined> = process.env): Record<string, string> => {
  const env: Record<string, string> = {
    PATH: from.PATH ?? "",
    HOME: from.HOME ?? "",
    LANG: from.LANG ?? "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    // The user's own gitconfig is not read. A `-c` reset cannot clear a
    // header or helper scoped to one URL (`[http "https://host/"]`): git
    // keeps the more specific match over the command line. Measured.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // ssh has no terminal to ask on: a passphrase or a host key prompt would
    // wait on the server's tty until the install timed out.
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
  for (const k of GIT_PASSTHROUGH) { const v = from[k]; if (v) env[k] = v; }
  return env;
};

/** Belt to the braces above: the two keys that carry a credential, cleared on the command line. */
export const PLUGIN_GIT_CONFIG = ["-c", "credential.helper=", "-c", "http.extraheader="];

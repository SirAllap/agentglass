// Google Antigravity — the CLI's argv for a worker run.
//
// `agy -p <prompt> --output-format stream-json` is Antigravity's equivalent of
// `claude -p --output-format stream-json`; the first turn mints a conversation
// and follow-ups go through `--conversation <id>`.
//
// This is *not* the Gemini CLI. They are separate binaries with separate
// wiring, they keep separate state, and `agy models` offers Claude and
// gpt-oss models alongside Gemini ones. Gemini CLI keeps its own OpenTelemetry
// route onto the radar and is untouched by any of this.

/**
 * The command line for one turn.
 *
 * Exported for tests, because the mode mapping is the part worth pinning: three
 * of the four modes are spelled as flags and the default is spelled by their
 * absence, so a regression here is silent rather than loud.
 *
 * The prompt goes in argv rather than on stdin. `--print` takes it as its
 * value, and there is no stdin form.
 *
 * The working directory is set on the spawn rather than with `--add-dir`.
 */
export function antigravityArgs(bin: string, model: string, mode: string, resumeId: string, message: string): string[] {
  const args = [bin, "-p", message, "--output-format", "stream-json", "--model", model];
  if (resumeId) args.push("--conversation", resumeId);
  if (mode === "always-proceed") args.push("--dangerously-skip-permissions");
  else if (mode === "plan" || mode === "accept-edits") args.push("--mode", mode);
  // `request-review` is the default and has no flag: passing --mode with it is
  // rejected, since --mode only accepts the two middle values.
  return args;
}

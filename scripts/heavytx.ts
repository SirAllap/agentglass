// Build a ~/.claude/projects-shaped fixture of BIG JSONL transcripts in /tmp.
//
// This is the shape the transcript scanner chokes on: session files tens of MB
// each, thousands of ordinary turn lines PLUS the occasional several-MB line —
// a base64 image a browser tool or a pasted screenshot writes into a
// tool_result. Every line is a `JSON.parse` and every turn is an `insertEvent`
// (FTS write + pre→post pairing query) on the single thread that also pumps the
// terminal's PTY, so a cold backfill of a real 700MB tree freezes the console.
// Everything here lives under a caller-supplied dir (a /tmp temp), so a harness
// can point the scanner at it via AGENTGLASS_PROJECTS_DIR and never go near the
// operator's real ~/.claude.
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface HeavyOpts {
  /** How many session .jsonl files to write. */
  files: number;
  /** Approximate size of each file, in MB. */
  fileMb: number;
  /** Size of each pathological base64-image line, in MB (the JSON.parse bomb). */
  giantLineMb: number;
  /** How many giant image lines to sprinkle through each file. */
  giantPerFile: number;
  /** Size of the ordinary tool-result output lines, in KB. */
  mediumLineKb: number;
  /** The cwd recorded on every line. A real directory, so projectOf() resolves
   *  it once (memoized) instead of failing. */
  cwd: string;
}

export const HEAVY_DEFAULTS: HeavyOpts = {
  files: Number(process.env.AGX_TX_FILES || 6),
  fileMb: Number(process.env.AGX_TX_FILE_MB || 50),
  giantLineMb: Number(process.env.AGX_TX_GIANT_MB || 4),
  // 0 isolates the per-event insert cost; the default sprinkles a handful so a
  // run exercises both the giant-line skip and the batched-yield paths.
  giantPerFile: Number(process.env.AGX_TX_GIANT_PER_FILE ?? 5),
  mediumLineKb: Number(process.env.AGX_TX_MEDIUM_KB || 4),
  cwd: process.env.AGX_TX_CWD || "",
};

/**
 * Write the fixture. Streams each line straight to the fd so a 300MB tree never
 * has to sit in memory at build time. Returns the paths and the byte total.
 *
 * Each file is thousands of ordinary turns — a user prompt, an assistant
 * tool_use, its tool_result (a few KB of "command output"), and an assistant
 * reply carrying token usage — the realistic mix that makes both JSON.parse and
 * insertEvent (with its FTS write and its pre→post pairing query) do real work
 * per line, with the giant image lines sprinkled evenly through.
 */
export function buildHeavyTranscripts(projectsDir: string, o: HeavyOpts): { bytes: number; files: string[]; lines: number } {
  const proj = join(projectsDir, "-tmp-heavyproj"); // encoded-cwd project folder
  mkdirSync(proj, { recursive: true });

  const CWD = o.cwd;
  const jstr = JSON.stringify;
  // One reusable blob per size class — building it once keeps construction fast;
  // the parser pays the same whether or not the bytes repeat.
  const giantBlob = "A".repeat(o.giantLineMb * 1024 * 1024); // valid base64 chars
  const mediumText = "x".repeat(o.mediumLineKb * 1024);

  const files: string[] = [];
  let bytes = 0;
  let lines = 0;
  const baseTs = Date.now() - 3_600_000;

  for (let f = 0; f < o.files; f++) {
    const sid = `heavy-sess-${f}`;
    const path = join(proj, `${sid}.jsonl`);
    const fd = openSync(path, "w");
    let written = 0;
    let seq = 0;
    const target = o.fileMb * 1024 * 1024;
    // Reserve the giant lines' bytes so the file lands near fileMb once they're
    // added, and space them evenly through the medium-line stream.
    const giantBytes = o.giantPerFile * o.giantLineMb * 1024 * 1024;
    const mediumTarget = Math.max(0, target - giantBytes);
    let nextGiantAt = o.giantPerFile > 0 ? mediumTarget / (o.giantPerFile + 1) : Infinity;
    let giantsDone = 0;

    const emit = (line: string) => {
      const buf = line + "\n";
      writeSync(fd, buf);
      written += Buffer.byteLength(buf);
      lines++;
    };
    // Header line carrying cwd + sessionId, so the scanner's sniff finds them on
    // line 0 (cheap) rather than parsing a giant line to get them.
    emit(`{"type":"user","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(new Date(baseTs).toISOString())},"message":{"role":"user","content":"session ${f} start"}}`);

    while (written < mediumTarget) {
      const ts = new Date(baseTs + seq * 1000).toISOString();
      const tid = `t-${f}-${seq}`;
      // A user prompt — exercises UserPromptSubmit.
      emit(`{"type":"user","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(ts)},"message":{"role":"user","content":"do task ${seq} please, thanks"}}`);
      // An assistant tool_use — opens a call the result must pair with.
      emit(`{"type":"assistant","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(ts)},"message":{"id":"m-${tid}","model":"claude-opus-4-8","role":"assistant","content":[{"type":"tool_use","id":${jstr(tid)},"name":"Bash","input":{"command":"run ${seq}"}}]}}`);
      // A tool_result with a few KB of "command output" — the pairing SELECT
      // fires here (PostToolUse → findPreById).
      emit(`{"type":"user","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(ts)},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":${jstr(tid)},"content":"${mediumText}"}]}}`);
      // An assistant reply carrying usage — exercises the token/cost path.
      emit(`{"type":"assistant","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(ts)},"message":{"id":"m2-${tid}","model":"claude-opus-4-8","role":"assistant","content":[{"type":"text","text":"done with ${seq}"}],"usage":{"input_tokens":1200,"output_tokens":300,"cache_read_input_tokens":5000}}}`);
      seq++;
      // Time for a giant image line?
      if (giantsDone < o.giantPerFile && written >= nextGiantAt) {
        emit(
          `{"type":"user","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(ts)},` +
          `"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":${jstr(tid)},"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` +
          giantBlob +
          `"}}]}]}}`
        );
        giantsDone++;
        nextGiantAt = (mediumTarget / (o.giantPerFile + 1)) * (giantsDone + 1);
      }
    }
    // Any giants we didn't reach (short files) go at the end.
    for (; giantsDone < o.giantPerFile; giantsDone++) {
      const ts = new Date(baseTs + seq * 1000).toISOString();
      emit(
        `{"type":"user","cwd":${jstr(CWD)},"sessionId":${jstr(sid)},"timestamp":${jstr(ts)},` +
        `"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t-${f}-tail","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` +
        giantBlob +
        `"}}]}]}}`
      );
    }
    closeSync(fd);
    files.push(path);
    bytes += written;
  }
  return { bytes, files, lines };
}

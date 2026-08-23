/*
 * Speech, turned into text on the computer.
 *
 * ── why the machine and not the phone ────────────────────────────────────
 * Because the phone cannot. Android's own recogniser needs Play Services and a
 * native module, iOS needs another, and Orca solved that by writing its own
 * native package — which is only available to an app that ships its own build.
 * This one runs in Expo Go, where a native module that is not in the client
 * simply is not there.
 *
 * It is also the shape the rest of this app already has: the phone is a window
 * onto a computer that does the work. That computer has a disk, a CPU nobody
 * is holding, and whatever the person installed. Recording is the half a phone
 * is good at; transcribing is the half it is not.
 *
 * ── it depends on something that may not be there ────────────────────────
 * Whisper, in one of the four shapes it ships as. None of them is bundled and
 * none is installed by this app, so the honest answer when there is none is a
 * refusal that NAMES what is missing — which is what the phone draws, and what
 * the dependency list on the Troubleshooting screen reports without anybody
 * having to press the microphone to find out.
 *
 * ── and it never touches a shell ─────────────────────────────────────────
 * The audio is written to a temp file this process names, and the binary is
 * spawned with an argv. Nothing here is interpolated into a command line: the
 * bytes are a recording from a phone and the only safe assumption about them
 * is that they are hostile.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeViewTempDir } from "./viewtemp.ts";

/**
 * The transcribers this knows how to drive, in the order worth trying.
 *
 * `whisper-cli` and `whisper-cpp` are whisper.cpp's own names — fast, no
 * Python, and what somebody on a laptop most likely has. `whisper` is
 * OpenAI's reference implementation and is slower but common. Each takes a
 * file and writes a `.txt` beside it; the flags differ, which is the whole
 * reason this is a table rather than a string.
 *
 * The model is NOT named. whisper.cpp needs one and refuses without it, so
 * `-m` is left to the person's own wrapper or environment — a path guessed
 * here would be a path that exists on one machine.
 */
interface Transcriber {
  bin: string;
  /** Given the audio path and the directory to write into. */
  args: (file: string, dir: string) => string[];
  /** Where the text lands, relative to that directory. */
  out: (file: string) => string;
}

const TRANSCRIBERS: Transcriber[] = [
  {
    bin: "whisper-cli",
    args: (file) => [file, "--output-txt", "--no-timestamps"],
    out: (file) => `${file}.txt`,
  },
  {
    bin: "whisper-cpp",
    args: (file) => [file, "--output-txt", "--no-timestamps"],
    out: (file) => `${file}.txt`,
  },
  {
    bin: "whisper",
    args: (file, dir) => [file, "--output_format", "txt", "--output_dir", dir, "--fp16", "False"],
    // OpenAI's writes `<stem>.txt` into the output dir, dropping the extension.
    out: (file) => `${file.replace(/\.[^.]+$/, "")}.txt`,
  },
];

/** Which one this machine has, or null. Exported so `/dependencies` can report
 *  it without anybody pressing the microphone to find out. */
export function transcriberOn(which: (cmd: string) => string | null = (c) => Bun.which(c)): string | null {
  for (const t of TRANSCRIBERS) if (which(t.bin)) return t.bin;
  return null;
}

export interface Transcript {
  ok: boolean;
  text?: string;
  error?: string;
}

/** A minute of speech is a long thing to say to a phone, and the cap is here
 *  rather than on the wire because this is the one route whose work is
 *  unbounded: whisper on a long file is minutes of CPU. */
const MAX_BYTES = 12 * 1024 * 1024;

/** Past this the run is abandoned. A transcriber that has not answered in two
 *  minutes is one that is not going to — a missing model is the usual reason,
 *  and it fails by waiting rather than by exiting. */
const DEADLINE_MS = 120_000;

/**
 * Bytes in, words out.
 *
 * Everything is cleaned up on the way out including on failure: these are
 * recordings of somebody's voice and leaving them in a temp directory is the
 * kind of thing that is fine until the day it is not.
 */
export async function transcribe(dataIn: unknown, nameIn: unknown): Promise<Transcript> {
  const data = typeof dataIn === "string" ? dataIn : "";
  if (!data) return { ok: false, error: "no audio" };

  let bytes: Buffer;
  try { bytes = Buffer.from(data, "base64"); } catch { return { ok: false, error: "not base64" }; }
  if (!bytes.length) return { ok: false, error: "empty recording" };
  if (bytes.length > MAX_BYTES) return { ok: false, error: "that recording is too long" };

  const bin = transcriberOn();
  if (!bin) {
    return {
      ok: false,
      error: "no transcriber on this computer — install whisper.cpp (whisper-cli) or openai-whisper",
    };
  }
  const spec = TRANSCRIBERS.find((t) => t.bin === bin)!;

  // The extension is the CLIENT's and only a known one is kept: it reaches a
  // filename, and what the transcriber is handed is a path this process chose.
  const asked = typeof nameIn === "string" ? nameIn.toLowerCase() : "";
  const ext = /\.(m4a|mp3|wav|ogg|webm|aac)$/.exec(asked)?.[0] ?? ".m4a";

  const dir = makeViewTempDir("audio");
  const file = join(dir, `speech${ext}`);
  try {
    writeFileSync(file, bytes);
    const ran = await run(spec.bin, spec.args(file, dir), dir);
    if (!ran.ok) return { ok: false, error: ran.error };

    const out = spec.out(file);
    if (!existsSync(out)) {
      return { ok: false, error: `${bin} ran but wrote no transcript` };
    }
    const text = readFileSync(out, "utf8").trim();
    if (!text) return { ok: false, error: "nothing was said, or nothing was heard" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: `could not transcribe it: ${String(e)}` };
  } finally {
    // Voice, gone as soon as it is words. Best-effort: a failure to clean up
    // must not turn a working transcript into an error.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to do */ }
  }
}

/** Spawn with an argv and a deadline. Never a shell — the only thing on this
 *  command line the client influenced is a file extension from a fixed set,
 *  and even that arrives as one element rather than as text. */
async function run(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const child = Bun.spawn([bin, ...args], { cwd, stdout: "ignore", stderr: "pipe" });

  /* A deadline rather than a wait. A transcriber that has not answered in two
     minutes is not going to — a missing model is the usual reason and it fails
     by hanging rather than by exiting, which without this is a request that
     never returns and a spinner that never stops. */
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* already gone */ }
  }, DEADLINE_MS);

  let code: number;
  let stderr = "";
  try {
    [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  } catch (e) {
    return { ok: false, error: `${bin} would not run: ${String(e)}` };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return { ok: false, error: `${bin} did not answer in two minutes — is its model installed?` };
  }
  if (code === 0) return { ok: true };
  // The TAIL of stderr: whisper's useful line is its last and its first forty
  // are a banner.
  const tail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
  return { ok: false, error: tail || `${bin} exited ${code}` };
}

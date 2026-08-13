/*
 * The sounds this app makes, synthesised rather than shipped.
 *
 * Why not audio files, which is the obvious answer: a strict CSP blocks a remote
 * asset outright, a bundled set is a few hundred kilobytes of the download for
 * two seconds of audio, and every free sound pack arrives with a licence to
 * carry around. Everything here is a few oscillators and an envelope — a couple
 * of hundred bytes of code each, original, and identical on every platform.
 *
 * They are written to sound like the current generation of notification sounds
 * rather than like a 90s system beep, which is a small number of concrete
 * decisions:
 *
 *   · SINE and TRIANGLE only. A square or a sawtooth reads as an error;
 *   · an ENVELOPE on every note. A gate that opens instantly clicks, and the
 *     click is louder than the note it introduces;
 *   · INTERVALS, not one pitch. Two or three notes read as a phrase — which is
 *     why every phone, clock and kitchen timer uses them — where a single tone
 *     reads as an alert;
 *   · nothing longer than about a second, except the alarms, which are meant to
 *     be heard from the next room.
 *
 * Notes are named in Hz, and the numbers are a pentatonic set on purpose: any
 * two of them sound intentional together, so a sound that fires twice in a
 * second (two notifications at once) does not clash with itself.
 */

/* A5, C#6, E6, F#6, A6 — a major pentatonic, which is the scale a wind chime
   is tuned to and the reason a wind chime never sounds wrong. */
const A5 = 880, CS6 = 1108.7, E6 = 1318.5, FS6 = 1480, A6 = 1760;
const D5 = 587.3, FS5 = 740, A4 = 440;

export type Voice = {
  id: string;
  label: string;
  /** One line in Settings, so the choice is made by reading rather than by
   *  clicking every one of them. */
  hint: string;
  play(ctx: AudioContext, at: number): void;
};

/* ── the instrument ───────────────────────────────────────────────────────── */

type NoteOpts = {
  /** Seconds from `at`. */
  delay?: number;
  /** Seconds. Short is a blip, long is a bell. */
  hold?: number;
  gain?: number;
  type?: OscillatorType;
  /** Where the pitch ends up, for a slide. Absent means it stays put. */
  to?: number;
};

function note(ctx: AudioContext, at: number, hz: number, o: NoteOpts = {}): void {
  const { delay = 0, hold = 0.16, gain = 0.2, type = "sine", to } = o;
  const t = at + delay;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(hz, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + hold);
  // Fast attack, exponential decay: the shape of something struck, which is
  // what every modern notification imitates.
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + hold);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + hold + 0.02);
}

/* ── notifications ────────────────────────────────────────────────────────── */

export const NOTIFY_VOICES: Voice[] = [
  {
    id: "ping", label: "Ping", hint: "Two notes rising — the default",
    play: (c, t) => { note(c, t, CS6, { hold: 0.13 }); note(c, t, E6, { delay: 0.09, hold: 0.2 }); },
  },
  {
    id: "drop", label: "Drop", hint: "One note, falling — quiet and quick",
    play: (c, t) => { note(c, t, A6, { hold: 0.16, to: E6, gain: 0.18 }); },
  },
  {
    id: "chime", label: "Chime", hint: "Three notes, like a wind chime",
    play: (c, t) => {
      note(c, t, A5, { hold: 0.5, gain: 0.13, type: "triangle" });
      note(c, t, CS6, { delay: 0.07, hold: 0.45, gain: 0.11, type: "triangle" });
      note(c, t, FS6, { delay: 0.14, hold: 0.55, gain: 0.09, type: "triangle" });
    },
  },
  {
    id: "tap", label: "Tap", hint: "A single soft tick — the least of them",
    play: (c, t) => { note(c, t, FS5, { hold: 0.06, gain: 0.16, type: "triangle" }); },
  },
  {
    id: "none", label: "Silent", hint: "No sound; the notification still arrives",
    play: () => { /* deliberately nothing */ },
  },
];

/* ── alarms ───────────────────────────────────────────────────────────────── */

/*
 * Longer, and built to repeat: an alarm is heard from another room, and it is
 * heard several times. Each of these is designed to survive being played every
 * three seconds without becoming unbearable, which rules out anything with a
 * long tail or a hard attack.
 */
export const ALARM_VOICES: Voice[] = [
  {
    id: "clock", label: "Clock", hint: "Two notes, a fifth apart — the default",
    play: (c, t) => { note(c, t, A5, { hold: 0.14, gain: 0.22 }); note(c, t, E6, { delay: 0.16, hold: 0.18, gain: 0.22 }); },
  },
  {
    id: "bell", label: "Bell", hint: "One struck note with a long decay",
    play: (c, t) => {
      note(c, t, D5, { hold: 1.1, gain: 0.2, type: "triangle" });
      // The overtone is what makes a bell a bell rather than a beep.
      note(c, t, D5 * 2.76, { hold: 0.55, gain: 0.05, type: "sine" });
    },
  },
  {
    id: "rise", label: "Rise", hint: "Three notes climbing — insistent, not shrill",
    play: (c, t) => {
      note(c, t, A5, { hold: 0.13, gain: 0.2 });
      note(c, t, CS6, { delay: 0.13, hold: 0.13, gain: 0.21 });
      note(c, t, E6, { delay: 0.26, hold: 0.24, gain: 0.22 });
    },
  },
  {
    id: "pulse", label: "Pulse", hint: "A double beat, low — the one you cannot miss",
    play: (c, t) => {
      note(c, t, A4, { hold: 0.12, gain: 0.24, type: "triangle" });
      note(c, t, A4, { delay: 0.18, hold: 0.12, gain: 0.24, type: "triangle" });
      note(c, t, A5, { delay: 0.36, hold: 0.22, gain: 0.2 });
    },
  },
  {
    id: "none", label: "Silent", hint: "No sound; the card still takes the screen",
    play: () => { /* deliberately nothing */ },
  },
];

/* ── playing one ──────────────────────────────────────────────────────────── */

let ctx: AudioContext | null = null;

/** One context for the page. Browsers cap how many exist, and creating one per
 *  sound costs a few milliseconds of latency on the first note — which lands as
 *  a swallowed attack, the one artefact these envelopes exist to avoid. */
function audio(): AudioContext | null {
  try {
    const AC = (globalThis as unknown as { AudioContext?: new () => AudioContext }).AudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    // A page that loaded in a background tab starts suspended, and stays that
    // way until something resumes it.
    void (ctx as unknown as { resume?: () => Promise<void> }).resume?.();
    return ctx;
  } catch { return null; }
}

export function findVoice(voices: Voice[], id: string | null | undefined): Voice {
  return voices.find((v) => v.id === id) ?? voices[0]!;
}

/** Play one, now. Silent and safe where there is no audio device, no
 *  AudioContext, or an autoplay policy that has not been satisfied yet. */
export function playVoice(voice: Voice): void {
  if (voice.id === "none") return;
  const c = audio();
  if (!c) return;
  try { voice.play(c, c.currentTime + 0.01); } catch { /* nothing to be done about it */ }
}

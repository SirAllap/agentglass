"use strict";
/**
 * Keep the machine awake while an agent works, and only then.
 *
 * Three modes: `on` (stay awake continuously), `agent` (stay awake only while
 * something is actually working — the one that matters), `off` (normal
 * system sleep). Whether "something is working" polls the server's own
 * `/agents/working`, which is built from what already tracks that — a pane
 * mid-turn, an understudy run still `running` — rather than a fourth source
 * of truth invented here.
 *
 * The assertion has two halves on Linux, because neither alone is the whole
 * promise:
 *   - `systemd-inhibit` is a *child process* holding a logind inhibitor lock
 *     for as long as it runs — two of them, one per lock, because the two
 *     locks need different modes (see `spawnInhibit`). `handle-lid-switch`
 *     is deliberate: closing the lid must not end a run.
 *   - Electron's `powerSaveBlocker` covers the display, which systemd does not.
 *
 * A PERSON'S OWN SUSPEND WINS. The sleep lock is held in BLOCK-WEAK mode:
 * logind enforces it against its own idle action and against other users,
 * and not against a request from the user who holds it — so `systemctl
 * suspend` from the menu goes through while an agent works, and the machine
 * still does not doze off on its own. Plain block was the first version, and
 * it did what it says to every suspend, that one included: with an agent
 * mid-turn the menu entry answered "Operation inhibited" and nothing happened,
 * with nothing on screen saying why. Measured on the owner's laptop.
 *
 * `block-weak` arrived in systemd 257. An older logind refuses the mode at
 * once ("Invalid mode specification", exit 1, measured on 261 with a bogus
 * mode), and the lock is then taken in plain BLOCK mode instead — which,
 * before 257, is the same thing under the old name: org.freedesktop.login1(5)
 * says block locks were "honoured only by unprivileged users, excluding the
 * user owning the inhibitor", and that 257 enforces them on everyone and
 * offers the old behaviour as block-weak. So on a logind too old for the
 * weak spelling, block already lets the owner's own suspend through. The
 * first version fell back to DELAY, which holds a suspend for
 * InhibitDelayMaxSec and then lets it go — nothing at all, on every Debian 12
 * and Ubuntu 24.04 (systemd 252 and 255). The lid switch has no weak or
 * delay mode in logind, and blocking it is what was wanted.
 *
 * Three failure modes are the whole difference between this working and this
 * being a lie, and each gets its own paragraph below: `systemd-inhibit` not
 * being installed, a suspend killing the child that was holding the lock, and
 * a dead agent's stale "working" status holding the machine awake forever.
 */
/*
 * READ OFF THE MODULE, NOT DESTRUCTURED, AND EVERY USE GUARDED.
 *
 * `powerMonitor` and `powerSaveBlocker` are main-process Electron APIs, and
 * this file is loaded by anything that loads main.js — including the harness
 * that runs the shell under plain node with an electron stub to check that a
 * broken sidecar is REPORTED rather than fatal. Destructured, the stub yields
 * `undefined` and the first `.on` throws out of `app.whenReady()`, which turned
 * three "the app survives" tests into "the app exits 1".
 *
 * That is not a test accident, it is the rule this feature has to obey: keeping
 * the machine awake is never worth the app not starting. So both are optional
 * here and every call site treats absence as "this half of the assertion is not
 * available", the same way a missing `systemd-inhibit` is treated below.
 */
const electron = require("electron");
const powerMonitor = electron.powerMonitor ?? null;
const powerSaveBlocker = electron.powerSaveBlocker ?? null;
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const MODES = ["on", "agent", "off"];
const POLL_MS = 20_000;
const FETCH_TIMEOUT_MS = 5_000;

let cfgPath = null;
let mode = "off";
let getApiOrigin = () => "";
let getToken = () => "";

/**
 * The two logind locks, each its own child. They cannot be one: `block-weak`
 * and `delay` are only offered for `sleep` and `shutdown`, so
 * `sleep:handle-lid-switch` would have to be block for both, and block on
 * sleep is the bug above.
 * @type {{ sleep: import("child_process").ChildProcess | null, lid: import("child_process").ChildProcess | null }}
 */
const inhibitChild = { sleep: null, lid: null };
/** The mode each running child was spawned with, for `status`: the sleep
 *  lock's is `block-weak` or, on a logind too old for it, `block`. */
const modeOfChild = new WeakMap();
/** Children this process ended itself, so their exit is not read as logind
 *  refusing the mode. */
const releasedByUs = new WeakSet();
/** Set once `systemd-inhibit` comes back ENOENT. Checked before every spawn,
 *  and never cleared for the life of the process — a binary that is not on
 *  this machine at second 10 is not going to appear at second 40, and
 *  retrying it forever would just be a slow poll for nothing. */
let inhibitUnavailable = false;
/** @type {number | null} */
let displayBlockerId = null;
/** The Mac's second half — see `assertMacAwake`. */
/** @type {number | null} */
let suspensionBlockerId = null;
/** Which platform's assertion to make. Read once at init rather than from
 *  `process.platform` at each call so the suite, which runs on Linux, can state
 *  a Mac. */
let platform = process.platform;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** Last poll's answer — `agent` mode's only input besides the mode itself. */
let lastKnownWorking = false;
/** And the server's reasons for it, by source (`workingWhy` on the server),
 *  or null from a server that does not send them. Shown, never decided on. */
let lastKnownWhy = null;
/** Whether the assertion is currently held, independent of *why*. */
let held = false;

function loadMode() {
  try {
    const saved = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mode;
    if (MODES.includes(saved)) return saved;
  } catch { /* first run, or a file nobody trusts */ }
  /* `agent` by default: awake only while something is working, which is the
     one mode that costs nothing when nothing is — and the one a person who
     closes the lid on a running agent would have chosen had they been asked. */
  return "agent";
}

function saveMode(m) {
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ mode: m }, null, 2) + "\n");
  } catch { /* the mode still applies for this run; it just won't survive a restart */ }
}

/** Set once logind has refused `block-weak` (systemd before 257). */
let weakRefused = false;

/**
 * Spawn one lock. Idempotent: a second call while it is already running is a
 * no-op, not a leaked second lock.
 * @param {"sleep" | "lid"} which
 * @param {string} [mode] the logind mode; the sleep lock's default is
 *   `block-weak`, and `block` is what it falls back to when logind refuses it
 *   (see the header: before 257, block is weak).
 */
function spawnInhibit(which, mode = which === "sleep" && !weakRefused ? "block-weak" : "block") {
  if (inhibitChild[which] || inhibitUnavailable) return;
  const what = which === "sleep" ? "--what=sleep" : "--what=handle-lid-switch";
  const child = spawn(
    "systemd-inhibit",
    [what, "--who=agentglass", "--why=Agents are working", `--mode=${mode}`, "sleep", "infinity"],
    { stdio: "ignore" },
  );
  inhibitChild[which] = child;
  modeOfChild.set(child, mode);
  /*
   * ENOENT means the tool is not on this machine — not every Linux ships
   * systemd, and a laptop without it must not busy-loop trying to spawn a
   * binary that will never appear. Anything else (spawned fine, then the
   * logind call itself failed) is transient and worth retrying on the next
   * poll, so only ENOENT sets the permanent flag.
   */
  child.on("error", (e) => {
    if (inhibitChild[which] === child) inhibitChild[which] = null;
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") inhibitUnavailable = true;
  });
  child.on("exit", (code) => {
    // A suspend does not necessarily leave this child alive to see the
    // resume — the `resume` handler below is what re-asserts, not this.
    if (inhibitChild[which] === child) inhibitChild[which] = null;
    // Refused at once, by a logind too old for the mode: the next best lock.
    // Only a refusal (exit 1) that this process did not cause; a child killed
    // by `killInhibit` exits by signal, and one killed by the suspend itself
    // is the resume handler's to replace.
    if (mode === "block-weak" && code === 1 && !releasedByUs.has(child) && held) {
      /* The logind's version spoke, and it does not change while the app
         runs: every later lock — the resume handler re-asserts them all —
         goes straight to block. */
      weakRefused = true;
      spawnInhibit(which, "block");
    }
  });
}

/** Idempotent, and ESRCH — the process already gone — is not an error.
 *  @param {"sleep" | "lid"} which */
function killInhibit(which) {
  const child = inhibitChild[which];
  inhibitChild[which] = null;
  if (!child) return;
  releasedByUs.add(child);
  try { child.kill(); } catch { /* already gone */ }
}

function assertLinuxInhibit() {
  spawnInhibit("sleep");
  spawnInhibit("lid");
}

function releaseLinuxInhibit() {
  killInhibit("sleep");
  killInhibit("lid");
}

function assertDisplay() {
  if (!powerSaveBlocker) return;
  if (displayBlockerId !== null && powerSaveBlocker.isStarted(displayBlockerId)) return;
  displayBlockerId = powerSaveBlocker.start("prevent-display-sleep");
}

function releaseDisplay() {
  if (displayBlockerId === null) return;
  try { if (powerSaveBlocker?.isStarted(displayBlockerId)) powerSaveBlocker.stop(displayBlockerId); } catch { /* already stopped */ }
  displayBlockerId = null;
}

/**
 * The Mac's equivalent of the systemd half.
 *
 * On Linux the promise has two parts — the display (Electron's blocker) and
 * the system (a logind inhibitor held by a child process). A Mac has no logind,
 * and `prevent-display-sleep` alone is only the first part: it keeps the screen
 * lit while the app is in front, and says nothing about App Nap, which macOS
 * applies to a window that has been in the background for a while — timers
 * slow, the poll that decides "still working" slows with them, and the sidecar
 * this process is the parent of is throttled along with it. That is the run
 * an agent is in the middle of.
 *
 * `prevent-app-suspension` is Electron's name for the assertion against that
 * (NSActivity user-initiated, system idle sleep disabled). Held ALONGSIDE the
 * display blocker, not instead of it — Electron documents that when both are
 * held the display one takes precedence for the screen, and the intent here is
 * both: screen on, app not napped. Darwin only; Linux and Windows keep exactly
 * the assertion they had.
 */
function assertMacAwake() {
  if (platform !== "darwin" || !powerSaveBlocker) return;
  if (suspensionBlockerId !== null && powerSaveBlocker.isStarted(suspensionBlockerId)) return;
  suspensionBlockerId = powerSaveBlocker.start("prevent-app-suspension");
}

function releaseMacAwake() {
  if (suspensionBlockerId === null) return;
  try { if (powerSaveBlocker?.isStarted(suspensionBlockerId)) powerSaveBlocker.stop(suspensionBlockerId); } catch { /* already stopped */ }
  suspensionBlockerId = null;
}

function assertAwake() {
  held = true;
  if (platform === "linux") assertLinuxInhibit();
  assertDisplay();
  assertMacAwake();
}

function releaseAwake() {
  held = false;
  releaseLinuxInhibit();
  releaseDisplay();
  releaseMacAwake();
}

function desired() {
  if (mode === "on") return true;
  if (mode === "agent") return lastKnownWorking;
  return false;
}

function sync() {
  const want = desired();
  if (want === held) return;
  if (want) assertAwake(); else releaseAwake();
}

async function pollWorking() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${getApiOrigin()}/agents/working`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: controller.signal,
    });
    if (!res.ok) return; // a hiccup — hold last known state rather than flap on it
    const body = await res.json();
    lastKnownWorking = body.working === true;
    lastKnownWhy = body.why && typeof body.why === "object" ? body.why : null;
    sync();
  } catch { /* server not up yet, or the request timed out — try again next tick */ } finally {
    clearTimeout(timer);
  }
}

function startPolling() {
  if (pollTimer) return;
  void pollWorking();
  pollTimer = setInterval(() => { void pollWorking(); }, POLL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function applyMode() {
  if (mode === "agent") startPolling(); else stopPolling();
  if (mode !== "agent") { lastKnownWorking = false; lastKnownWhy = null; }
  sync();
}

/** @param {{ configDir: string, apiOrigin: () => string, token: () => string, platform?: string }} opts */
function init(opts) {
  cfgPath = path.join(opts.configDir, "power.json");
  getApiOrigin = opts.apiOrigin;
  getToken = opts.token;
  platform = opts.platform ?? process.platform;
  mode = loadMode();
  /*
   * A child process holding the logind lock does not necessarily survive the
   * suspend it was blocking — the exact moment this matters is the one right
   * after waking, which is also the moment a person glances over expecting
   * the machine to still be held. Force a fresh assertion rather than trust
   * whatever `held` says: the old child, if it is even still running, gets
   * released and replaced.
   */
  powerMonitor?.on("resume", () => {
    if (!desired()) return;
    releaseAwake();
    assertAwake();
  });
  /*
   * And the moment logind announces the suspend, the sleep lock is let go.
   *
   * By then the suspend is happening whatever the lock says: the lock is
   * weak, and the person's own request went through it. Letting go here is
   * bookkeeping — a child that would otherwise be found dead after the
   * resume, and a lock that must not read as "held" while the machine is
   * asleep. `held` is left as it is: the resume handler above re-asserts
   * everything on the way back.
   */
  powerMonitor?.on("suspend", () => { killInhibit("sleep"); });
  applyMode();
}

/** @param {string} m */
function setMode(m) {
  if (!MODES.includes(m)) return status();
  mode = m;
  saveMode(m);
  applyMode();
  return status();
}

/**
 * What is held and why, for the header.
 *
 * `awake` alone was all it said, and it could not tell a person the two
 * things they need before closing a lid or picking suspend from the menu:
 * WHICH locks are held — the lid switch, and the sleep lock whose weak mode
 * lets their own suspend through — and WHY, which is the server's count of
 * what is working. It also said "awake" on a machine with no systemd-inhibit,
 * where only the display is held and the machine sleeps on the lid as ever.
 *
 * `locks` is read off the children that are running now, not off `held`: a
 * sleep lock let go on the way into a suspend, or never taken, is null.
 */
function status() {
  const sleepChild = inhibitChild.sleep;
  return {
    mode, awake: held, working: lastKnownWorking, why: lastKnownWhy,
    locks: {
      sleep: sleepChild ? modeOfChild.get(sleepChild) ?? null : null,
      lid: !!inhibitChild.lid,
      display: displayBlockerId !== null,
      app: suspensionBlockerId !== null,
    },
    inhibitMissing: platform === "linux" && inhibitUnavailable,
  };
}

function shutdown() {
  stopPolling();
  releaseAwake();
}

module.exports = { init, setMode, status, shutdown, MODES };
